package plugins

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

type fakeClient struct {
	mu               sync.Mutex
	manifestValue    protocol.PluginManifest
	manifestFailures []*clientError
	healthFunc       func(context.Context) (bool, *clientError)
	invokeFunc       func(context.Context) (protocol.JSONValue, *remoteOperationError, *clientError)
}

func (f *fakeClient) manifest(context.Context, string) (protocol.PluginManifest, *clientError) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.manifestFailures) > 0 {
		err := f.manifestFailures[0]
		f.manifestFailures = f.manifestFailures[1:]
		return protocol.PluginManifest{}, err
	}
	return cloneManifest(f.manifestValue), nil
}

func (f *fakeClient) health(ctx context.Context, _ string) (bool, *clientError) {
	f.mu.Lock()
	health := f.healthFunc
	f.mu.Unlock()
	if health == nil {
		return true, nil
	}
	return health(ctx)
}

func (f *fakeClient) invoke(ctx context.Context, _, _ string, _ protocol.JSONValue) (protocol.JSONValue, *remoteOperationError, *clientError) {
	f.mu.Lock()
	invoke := f.invokeFunc
	f.mu.Unlock()
	if invoke == nil {
		return map[string]any{"ok": true}, nil, nil
	}
	return invoke(ctx)
}

func fixtureManifest(timeout time.Duration) protocol.PluginManifest {
	return protocol.PluginManifest{
		PluginID:    "reference",
		DisplayName: "Reference",
		Operations: []protocol.PluginOperationDescriptor{{
			OperationID: "inspect_fixture",
			DisplayName: "Inspect fixture",
			TimeoutMs:   int64(timeout / time.Millisecond),
		}},
	}
}

func cloneManifest(manifest protocol.PluginManifest) protocol.PluginManifest {
	manifest.Operations = append([]protocol.PluginOperationDescriptor(nil), manifest.Operations...)
	return manifest
}

func TestRegistryRetriesManifestAndKeepsCachedDiscoveryDuringOutage(t *testing.T) {
	client := &fakeClient{
		manifestValue:    fixtureManifest(time.Second),
		manifestFailures: []*clientError{{kind: failureUnreachable, err: errors.New("offline")}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	registry := New(ctx, []Endpoint{{ID: "reference", BaseURL: "http://reference:8080"}}, Options{
		Client: client, RetryCadence: time.Millisecond, HealthCadence: time.Hour,
	})
	waitForStatus(t, registry, protocol.PluginStatusStateAvailable)
	status := registry.List()[0]
	if status.DisplayName == nil || *status.DisplayName != "Reference" || len(status.Operations) != 1 {
		t.Fatalf("discovery = %#v", status)
	}

	registry.recordFailure("reference", protocol.PluginUnavailableReasonTransportUnreachable)
	status = registry.List()[0]
	if status.Status != protocol.PluginStatusStateUnavailable || status.DisplayName == nil || len(status.Operations) != 1 {
		t.Fatalf("cached discovery after outage = %#v", status)
	}
}

func TestRegistryApplicationHealthAndOperationRecoveryAreIndependent(t *testing.T) {
	client := &fakeClient{manifestValue: fixtureManifest(time.Second)}
	client.healthFunc = func(context.Context) (bool, *clientError) { return false, nil }
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	registry := New(ctx, []Endpoint{{ID: "reference", BaseURL: "http://reference:8080"}}, Options{
		Client: client, RetryCadence: time.Millisecond, HealthCadence: time.Hour,
	})
	waitForStatus(t, registry, protocol.PluginStatusStateUnavailable)
	status := registry.List()[0]
	if status.ReasonCode == nil || *status.ReasonCode != protocol.PluginUnavailableReasonApplicationUnhealthy {
		t.Fatalf("unhealthy status = %#v", status)
	}
	registry.recordTransportSuccess("reference")
	status = registry.List()[0]
	if status.Status != protocol.PluginStatusStateUnavailable || *status.ReasonCode != protocol.PluginUnavailableReasonApplicationUnhealthy {
		t.Fatalf("Operation transport cleared application health = %#v", status)
	}
	registry.recordHealth("reference", true)
	if status := registry.List()[0]; status.Status != protocol.PluginStatusStateAvailable || status.ReasonCode != nil {
		t.Fatalf("recovered status = %#v", status)
	}
}

func TestRegistryMapsOperationFailuresWithoutChangingHealthyStatus(t *testing.T) {
	client := &fakeClient{manifestValue: fixtureManifest(10 * time.Millisecond)}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	registry := New(ctx, []Endpoint{{ID: "reference", BaseURL: "http://reference:8080"}}, Options{
		Client: client, RetryCadence: time.Millisecond, HealthCadence: time.Hour,
	})
	waitForStatus(t, registry, protocol.PluginStatusStateAvailable)

	client.mu.Lock()
	client.invokeFunc = func(context.Context) (protocol.JSONValue, *remoteOperationError, *clientError) {
		return nil, &remoteOperationError{rejected: true, code: "invalid_key", details: map[string]any{"field": "key"}, hasDetails: true}, nil
	}
	client.mu.Unlock()
	_, rejected := registry.Invoke(context.Background(), "reference", "inspect_fixture", nil)
	if rejected == nil || rejected.Kind != InvokeInputRejected || rejected.PluginCode != "invalid_key" || !rejected.HasDetails {
		t.Fatalf("rejected error = %#v", rejected)
	}
	if registry.List()[0].Status != protocol.PluginStatusStateAvailable {
		t.Fatal("valid private rejection changed Plugin status")
	}

	client.mu.Lock()
	client.invokeFunc = func(ctx context.Context) (protocol.JSONValue, *remoteOperationError, *clientError) {
		<-ctx.Done()
		return nil, nil, &clientError{kind: failureTimeout, err: ctx.Err()}
	}
	client.mu.Unlock()
	_, timeoutErr := registry.Invoke(context.Background(), "reference", "inspect_fixture", nil)
	if timeoutErr == nil || timeoutErr.Kind != InvokeTimeout {
		t.Fatalf("timeout error = %#v", timeoutErr)
	}
	if registry.List()[0].Status != protocol.PluginStatusStateAvailable {
		t.Fatal("Operation timeout changed Plugin status")
	}
}

func TestRegistryRejectsNinthConcurrentOperationWithoutQueueing(t *testing.T) {
	client := &fakeClient{manifestValue: fixtureManifest(time.Second)}
	entered := make(chan struct{}, DefaultInFlightLimit)
	release := make(chan struct{})
	client.invokeFunc = func(ctx context.Context) (protocol.JSONValue, *remoteOperationError, *clientError) {
		entered <- struct{}{}
		select {
		case <-release:
			return nil, nil, nil
		case <-ctx.Done():
			return nil, nil, &clientError{kind: failureCanceled, err: ctx.Err()}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	registry := New(ctx, []Endpoint{{ID: "reference", BaseURL: "http://reference:8080"}}, Options{
		Client: client, RetryCadence: time.Millisecond, HealthCadence: time.Hour,
	})
	waitForStatus(t, registry, protocol.PluginStatusStateAvailable)
	var group sync.WaitGroup
	for range DefaultInFlightLimit {
		group.Add(1)
		go func() {
			defer group.Done()
			_, _ = registry.Invoke(context.Background(), "reference", "inspect_fixture", nil)
		}()
	}
	for range DefaultInFlightLimit {
		<-entered
	}
	_, capacityErr := registry.Invoke(context.Background(), "reference", "inspect_fixture", nil)
	if capacityErr == nil || capacityErr.Kind != InvokeUnavailable || capacityErr.ReasonCode != "capacity_exhausted" {
		t.Fatalf("capacity error = %#v", capacityErr)
	}
	close(release)
	group.Wait()
	if registry.List()[0].Status != protocol.PluginStatusStateAvailable {
		t.Fatal("capacity rejection changed Plugin status")
	}
}

func TestManifestIdentityOperationsAndToolAssetAreValidated(t *testing.T) {
	manifest := fixtureManifest(time.Second)
	manifest.ToolAssetID = "plugin_rfSey5Te4YU6Prz-hpGcwRnuSBuF9z1COTHZJt_s0G4"
	manifest.PluginID = "adsb"
	if err := validateManifest("adsb", manifest); err != nil {
		t.Fatalf("valid Tool Asset manifest: %v", err)
	}
	manifest.Operations = append(manifest.Operations, manifest.Operations[0])
	if err := validateManifest("adsb", manifest); err == nil {
		t.Fatal("duplicate Operation was accepted")
	}
	manifest = fixtureManifest(time.Second)
	manifest.PluginID = "other"
	if err := validateManifest("reference", manifest); err == nil {
		t.Fatal("identity mismatch was accepted")
	}
}

func waitForStatus(t *testing.T, registry *Registry, wanted protocol.PluginStatusState) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if registry.List()[0].Status == wanted {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("Plugin status = %#v, want %s", registry.List()[0], wanted)
}
