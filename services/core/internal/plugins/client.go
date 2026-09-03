package plugins

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/pluginid"
)

const maxPrivateResponseBytes = 1 << 20

type clientFailure string

const (
	failureUnreachable     clientFailure = "unreachable"
	failureTimeout         clientFailure = "timeout"
	failureCanceled        clientFailure = "canceled"
	failureInvalidManifest clientFailure = "invalid_manifest"
	failureInvalidResponse clientFailure = "invalid_response"
)

type clientError struct {
	kind clientFailure
	err  error
}

func (e *clientError) Error() string { return string(e.kind) }
func (e *clientError) Unwrap() error { return e.err }

type remoteOperationError struct {
	rejected   bool
	code       string
	details    protocol.JSONValue
	hasDetails bool
}

type privateClient interface {
	manifest(context.Context, string) (protocol.PluginManifest, *clientError)
	health(context.Context, string) (bool, *clientError)
	invoke(context.Context, string, string, json.RawMessage) (protocol.JSONValue, *remoteOperationError, *clientError)
}

type httpClient struct {
	client *http.Client
}

func newHTTPClient(client *http.Client) *httpClient {
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		client = &http.Client{Transport: transport}
	}
	copy := *client
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &httpClient{client: &copy}
}

func (c *httpClient) manifest(ctx context.Context, baseURL string) (protocol.PluginManifest, *clientError) {
	response, err := c.request(ctx, http.MethodGet, baseURL+"/manifest", nil)
	if err != nil {
		return protocol.PluginManifest{}, err
	}
	defer func() { _ = response.Body.Close() }()
	data, readErr := readPrivateResponse(ctx, response, failureInvalidManifest)
	if readErr != nil {
		return protocol.PluginManifest{}, readErr
	}
	if response.StatusCode != http.StatusOK {
		return protocol.PluginManifest{}, invalidManifest(fmt.Errorf("manifest status %d", response.StatusCode))
	}
	var manifest protocol.PluginManifest
	if err := decodeStrictJSON(data, &manifest); err != nil {
		return protocol.PluginManifest{}, invalidManifest(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields["operations"] == nil || manifest.Operations == nil {
		return protocol.PluginManifest{}, invalidManifest(fmt.Errorf("manifest is missing required fields"))
	}
	if raw, present := fields["tool_asset_id"]; present {
		var toolAssetID string
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &toolAssetID) != nil {
			return protocol.PluginManifest{}, invalidManifest(fmt.Errorf("tool_asset_id must be a string"))
		}
	}
	return manifest, nil
}

func (c *httpClient) health(ctx context.Context, baseURL string) (bool, *clientError) {
	response, err := c.request(ctx, http.MethodGet, baseURL+"/health", nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = response.Body.Close() }()
	data, readErr := readPrivateResponse(ctx, response, failureInvalidResponse)
	if readErr != nil {
		return false, readErr
	}
	var health struct {
		Status string `json:"status"`
	}
	if err := decodeStrictJSON(data, &health); err != nil {
		return false, invalidResponse(err)
	}
	if response.StatusCode == http.StatusOK && health.Status == "ok" {
		return true, nil
	}
	if response.StatusCode == http.StatusServiceUnavailable && health.Status == "unhealthy" {
		return false, nil
	}
	return false, invalidResponse(fmt.Errorf("unexpected health response"))
}

func (c *httpClient) invoke(
	ctx context.Context,
	baseURL string,
	operationID string,
	input json.RawMessage,
) (protocol.JSONValue, *remoteOperationError, *clientError) {
	if len(input) == 0 {
		input = json.RawMessage("null")
	}
	response, requestErr := c.request(ctx, http.MethodPost, baseURL+"/operations/"+operationID, bytes.NewReader(input))
	if requestErr != nil {
		return nil, nil, requestErr
	}
	defer func() { _ = response.Body.Close() }()
	data, readErr := readPrivateResponse(ctx, response, failureInvalidResponse)
	if readErr != nil {
		return nil, nil, readErr
	}
	if response.StatusCode == http.StatusOK {
		var result protocol.JSONValue
		if err := decodeJSONValue(data, &result); err != nil {
			return nil, nil, invalidResponse(err)
		}
		return result, nil, nil
	}
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusInternalServerError {
		return nil, nil, invalidResponse(fmt.Errorf("operation status %d", response.StatusCode))
	}
	var failure struct {
		Code    string          `json:"code"`
		Details json.RawMessage `json:"details,omitempty"`
	}
	if err := decodeStrictJSON(data, &failure); err != nil || !pluginid.Valid(failure.Code) {
		return nil, nil, invalidResponse(fmt.Errorf("invalid operation error response"))
	}
	remote := &remoteOperationError{rejected: response.StatusCode == http.StatusBadRequest, code: failure.Code}
	if len(failure.Details) > 0 {
		if err := decodeJSONValue(failure.Details, &remote.details); err != nil {
			return nil, nil, invalidResponse(fmt.Errorf("invalid operation error details"))
		}
		remote.hasDetails = true
	}
	return nil, remote, nil
}

func (c *httpClient) request(ctx context.Context, method, target string, body io.Reader) (*http.Response, *clientError) {
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, invalidResponse(err)
	}
	if strings.HasPrefix(request.URL.Host, "[") {
		if hostname, _, hasZone := strings.Cut(request.URL.Hostname(), "%"); hasZone {
			request.Host = "[" + hostname + "]"
			if port := request.URL.Port(); port != "" {
				request.Host = net.JoinHostPort(hostname, port)
			}
		}
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err == nil {
		return response, nil
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return nil, &clientError{kind: failureCanceled, err: err}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return nil, &clientError{kind: failureTimeout, err: err}
	}
	return nil, &clientError{kind: failureUnreachable, err: err}
}

func readPrivateResponse(ctx context.Context, response *http.Response, invalidKind clientFailure) ([]byte, *clientError) {
	if contextErr := privateContextError(ctx, nil); contextErr != nil {
		return nil, contextErr
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		return nil, &clientError{kind: invalidKind, err: fmt.Errorf("private response is not application/json")}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPrivateResponseBytes+1))
	if err != nil {
		if contextErr := privateContextError(ctx, err); contextErr != nil {
			return nil, contextErr
		}
		return nil, &clientError{kind: invalidKind, err: err}
	}
	if len(data) > maxPrivateResponseBytes {
		return nil, &clientError{kind: invalidKind, err: fmt.Errorf("private response exceeds size limit")}
	}
	return data, nil
}

func privateContextError(ctx context.Context, err error) *clientError {
	if errors.Is(ctx.Err(), context.Canceled) {
		return &clientError{kind: failureCanceled, err: err}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return &clientError{kind: failureTimeout, err: err}
	}
	return nil
}

func decodeStrictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("response contains trailing JSON")
	}
	return nil
}

func decodeJSONValue(data []byte, target *protocol.JSONValue) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("response contains trailing JSON")
	}
	return nil
}

func invalidManifest(err error) *clientError {
	return &clientError{kind: failureInvalidManifest, err: err}
}

func invalidResponse(err error) *clientError {
	return &clientError{kind: failureInvalidResponse, err: err}
}
