// Package plugins owns configured Plugin discovery, health, and Operation dispatch.
package plugins

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/pluginid"
)

const (
	MaxOperationTimeout  = 25 * time.Second
	DefaultCheckTimeout  = 2 * time.Second
	DefaultCheckCadence  = 10 * time.Second
	DefaultInFlightLimit = 8
)

type Endpoint struct {
	ID      string
	BaseURL string
}

type Options struct {
	CheckTimeout  time.Duration
	RetryCadence  time.Duration
	HealthCadence time.Duration
	InFlightLimit int
	Now           func() time.Time
	Client        privateClient
}

type applicationHealth uint8

const (
	healthUnknown applicationHealth = iota
	healthOK
	healthUnhealthy
)

type entry struct {
	endpoint  Endpoint
	manifest  *protocol.PluginManifest
	status    protocol.PluginStatusState
	reason    *protocol.PluginUnavailableReason
	checkedAt *time.Time
	health    applicationHealth
	inFlight  chan struct{}
}

type Registry struct {
	mu      sync.RWMutex
	entries map[string]*entry
	order   []string
	client  privateClient
	options Options
}

type InvokeErrorKind string

const (
	InvokeNotFound      InvokeErrorKind = "not_found"
	InvokeInputRejected InvokeErrorKind = "input_rejected"
	InvokeUnavailable   InvokeErrorKind = "unavailable"
	InvokeTimeout       InvokeErrorKind = "timeout"
	InvokeFailure       InvokeErrorKind = "failure"
	InvokeCanceled      InvokeErrorKind = "canceled"
)

type InvokeError struct {
	Kind          InvokeErrorKind
	PluginCode    string
	PluginDetails protocol.JSONValue
	HasDetails    bool
	ReasonCode    string
}

func (e *InvokeError) Error() string { return string(e.Kind) }

func New(ctx context.Context, endpoints []Endpoint, options Options) *Registry {
	if options.CheckTimeout <= 0 {
		options.CheckTimeout = DefaultCheckTimeout
	}
	if options.RetryCadence <= 0 {
		options.RetryCadence = DefaultCheckCadence
	}
	if options.HealthCadence <= 0 {
		options.HealthCadence = DefaultCheckCadence
	}
	if options.InFlightLimit <= 0 {
		options.InFlightLimit = DefaultInFlightLimit
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Client == nil {
		options.Client = newHTTPClient(nil)
	}
	registry := &Registry{
		entries: make(map[string]*entry, len(endpoints)),
		order:   make([]string, 0, len(endpoints)),
		client:  options.Client,
		options: options,
	}
	for _, endpoint := range endpoints {
		registry.entries[endpoint.ID] = &entry{
			endpoint: endpoint,
			status:   protocol.PluginStatusStateStarting,
			health:   healthUnknown,
			inFlight: make(chan struct{}, options.InFlightLimit),
		}
		registry.order = append(registry.order, endpoint.ID)
	}
	sort.Strings(registry.order)
	for _, pluginID := range registry.order {
		go registry.monitor(ctx, pluginID)
	}
	return registry
}

func (r *Registry) List() []protocol.PluginStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()
	statuses := make([]protocol.PluginStatus, 0, len(r.order))
	for _, pluginID := range r.order {
		state := r.entries[pluginID]
		status := protocol.PluginStatus{
			PluginID:   pluginID,
			Status:     state.status,
			ReasonCode: cloneReason(state.reason),
			Operations: []protocol.PluginOperationDescriptor{},
		}
		if state.checkedAt != nil {
			value := state.checkedAt.UTC().Format(time.RFC3339Nano)
			status.CheckedAt = &value
		}
		if state.manifest != nil {
			displayName := state.manifest.DisplayName
			status.DisplayName = &displayName
			status.Operations = append(status.Operations, state.manifest.Operations...)
			if state.manifest.ToolAssetID != "" {
				toolAssetID := state.manifest.ToolAssetID
				status.ToolAssetID = &toolAssetID
			}
		}
		statuses = append(statuses, status)
	}
	return statuses
}

func (r *Registry) Invoke(ctx context.Context, pluginID, operationID string, input protocol.JSONValue) (protocol.JSONValue, *InvokeError) {
	state, timeout, invokeErr := r.operation(pluginID, operationID)
	if invokeErr != nil {
		return nil, invokeErr
	}
	select {
	case state.inFlight <- struct{}{}:
		defer func() { <-state.inFlight }()
	default:
		return nil, &InvokeError{Kind: InvokeUnavailable, ReasonCode: "capacity_exhausted"}
	}

	operationCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, remoteErr, clientErr := r.client.invoke(operationCtx, state.endpoint.BaseURL, operationID, input)
	if clientErr != nil {
		switch clientErr.kind {
		case failureCanceled:
			return nil, &InvokeError{Kind: InvokeCanceled}
		case failureTimeout:
			return nil, &InvokeError{Kind: InvokeTimeout}
		case failureInvalidResponse:
			r.recordFailure(pluginID, protocol.PluginUnavailableReasonInvalidResponse)
			return nil, &InvokeError{Kind: InvokeFailure, ReasonCode: "invalid_response"}
		default:
			r.recordFailure(pluginID, protocol.PluginUnavailableReasonTransportUnreachable)
			return nil, &InvokeError{Kind: InvokeUnavailable, ReasonCode: "transport_unreachable"}
		}
	}
	r.recordTransportSuccess(pluginID)
	if remoteErr == nil {
		return result, nil
	}
	kind := InvokeFailure
	if remoteErr.rejected {
		kind = InvokeInputRejected
	}
	return nil, &InvokeError{
		Kind:          kind,
		PluginCode:    remoteErr.code,
		PluginDetails: remoteErr.details,
		HasDetails:    remoteErr.hasDetails,
	}
}

func (r *Registry) operation(pluginID, operationID string) (*entry, time.Duration, *InvokeError) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	state := r.entries[pluginID]
	if state == nil || state.manifest == nil {
		if state == nil {
			return nil, 0, &InvokeError{Kind: InvokeNotFound}
		}
		reason := "starting"
		if state.reason != nil {
			reason = string(*state.reason)
		}
		return nil, 0, &InvokeError{Kind: InvokeUnavailable, ReasonCode: reason}
	}
	var timeout time.Duration
	for _, operation := range state.manifest.Operations {
		if operation.OperationID == operationID {
			timeout = time.Duration(operation.TimeoutMs) * time.Millisecond
			break
		}
	}
	if timeout == 0 {
		return nil, 0, &InvokeError{Kind: InvokeNotFound}
	}
	if state.status != protocol.PluginStatusStateAvailable {
		reason := "starting"
		if state.reason != nil {
			reason = string(*state.reason)
		}
		return nil, 0, &InvokeError{Kind: InvokeUnavailable, ReasonCode: reason}
	}
	return state, timeout, nil
}

func (r *Registry) monitor(ctx context.Context, pluginID string) {
	for {
		checkCtx, cancel := context.WithTimeout(ctx, r.options.CheckTimeout)
		manifest, err := r.client.manifest(checkCtx, r.baseURL(pluginID))
		cancel()
		if err == nil {
			if validationErr := validateManifest(pluginID, manifest); validationErr == nil {
				r.recordManifest(pluginID, manifest)
				break
			}
			err = invalidManifest(fmt.Errorf("manifest validation failed"))
		}
		r.recordManifestFailure(pluginID, err)
		if !wait(ctx, r.options.RetryCadence) {
			return
		}
	}

	for {
		checkCtx, cancel := context.WithTimeout(ctx, r.options.CheckTimeout)
		healthy, err := r.client.health(checkCtx, r.baseURL(pluginID))
		cancel()
		if err != nil {
			r.recordHealthFailure(pluginID, err)
		} else {
			r.recordHealth(pluginID, healthy)
		}
		if !wait(ctx, r.options.HealthCadence) {
			return
		}
	}
}

func validateManifest(configuredID string, manifest protocol.PluginManifest) error {
	if validationErrors := protocol.ValidatePluginManifest(manifest); len(validationErrors) > 0 {
		return fmt.Errorf("manifest does not conform to Atlas Protocol: %v", validationErrors)
	}
	if manifest.PluginID != configuredID {
		return fmt.Errorf("manifest Plugin ID %q does not match configured ID %q", manifest.PluginID, configuredID)
	}
	if manifest.ToolAssetID != "" && manifest.ToolAssetID != pluginid.DeriveToolAssetID(configuredID) {
		return fmt.Errorf("manifest Tool Asset ID does not match Plugin ID")
	}
	seen := make(map[string]struct{}, len(manifest.Operations))
	for _, operation := range manifest.Operations {
		if _, duplicate := seen[operation.OperationID]; duplicate {
			return fmt.Errorf("operation %q appears more than once", operation.OperationID)
		}
		seen[operation.OperationID] = struct{}{}
		if operation.TimeoutMs < 1 || time.Duration(operation.TimeoutMs)*time.Millisecond > MaxOperationTimeout {
			return fmt.Errorf("operation %q timeout exceeds %s", operation.OperationID, MaxOperationTimeout)
		}
	}
	return nil
}

func (r *Registry) baseURL(pluginID string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.entries[pluginID].endpoint.BaseURL
}

func (r *Registry) recordManifest(pluginID string, manifest protocol.PluginManifest) {
	sort.Slice(manifest.Operations, func(i, j int) bool { return manifest.Operations[i].OperationID < manifest.Operations[j].OperationID })
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.options.Now().UTC()
	state := r.entries[pluginID]
	state.manifest = &manifest
	state.status = protocol.PluginStatusStateStarting
	state.reason = nil
	state.checkedAt = &now
	state.health = healthUnknown
}

func (r *Registry) recordManifestFailure(pluginID string, err *clientError) {
	reason := protocol.PluginUnavailableReasonInvalidManifest
	if err != nil && err.kind == failureTimeout {
		reason = protocol.PluginUnavailableReasonTransportTimeout
	} else if err != nil && err.kind == failureUnreachable {
		reason = protocol.PluginUnavailableReasonTransportUnreachable
	}
	r.recordFailure(pluginID, reason)
}

func (r *Registry) recordHealthFailure(pluginID string, err *clientError) {
	reason := protocol.PluginUnavailableReasonInvalidResponse
	if err != nil && err.kind == failureTimeout {
		reason = protocol.PluginUnavailableReasonTransportTimeout
	} else if err != nil && err.kind == failureUnreachable {
		reason = protocol.PluginUnavailableReasonTransportUnreachable
	}
	r.recordFailure(pluginID, reason)
}

func (r *Registry) recordFailure(pluginID string, reason protocol.PluginUnavailableReason) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.options.Now().UTC()
	state := r.entries[pluginID]
	state.status = protocol.PluginStatusStateUnavailable
	state.reason = &reason
	state.checkedAt = &now
}

func (r *Registry) recordHealth(pluginID string, healthy bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.options.Now().UTC()
	state := r.entries[pluginID]
	state.checkedAt = &now
	if healthy {
		state.health = healthOK
		state.status = protocol.PluginStatusStateAvailable
		state.reason = nil
		return
	}
	state.health = healthUnhealthy
	state.status = protocol.PluginStatusStateUnavailable
	reason := protocol.PluginUnavailableReasonApplicationUnhealthy
	state.reason = &reason
}

func (r *Registry) recordTransportSuccess(pluginID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.options.Now().UTC()
	state := r.entries[pluginID]
	state.checkedAt = &now
	switch state.health {
	case healthOK:
		state.status = protocol.PluginStatusStateAvailable
		state.reason = nil
	case healthUnhealthy:
		state.status = protocol.PluginStatusStateUnavailable
		reason := protocol.PluginUnavailableReasonApplicationUnhealthy
		state.reason = &reason
	default:
		state.status = protocol.PluginStatusStateStarting
		state.reason = nil
	}
}

func cloneReason(reason *protocol.PluginUnavailableReason) *protocol.PluginUnavailableReason {
	if reason == nil {
		return nil
	}
	value := *reason
	return &value
}

func wait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
