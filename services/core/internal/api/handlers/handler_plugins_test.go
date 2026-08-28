package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	coreplugins "github.com/the-drunken-coder/atlas/services/core/internal/plugins"
)

type pluginRegistryStub struct {
	statuses []protocol.PluginStatus
	result   protocol.JSONValue
	err      *coreplugins.InvokeError
	input    protocol.JSONValue
}

func (s *pluginRegistryStub) List() []protocol.PluginStatus { return s.statuses }

func (s *pluginRegistryStub) Invoke(_ context.Context, _, _ string, input protocol.JSONValue) (protocol.JSONValue, *coreplugins.InvokeError) {
	s.input = input
	return s.result, s.err
}

func TestPluginHandlersExposeOnlyDiscoveryAndInvocationContracts(t *testing.T) {
	registry := &pluginRegistryStub{
		statuses: []protocol.PluginStatus{{
			PluginID:   "reference",
			Status:     protocol.PluginStatusStateAvailable,
			Operations: []protocol.PluginOperationDescriptor{},
		}},
		result: map[string]any{"value": "alpha"},
	}
	handler := &Handler{plugins: registry}

	listRecorder := httptest.NewRecorder()
	handler.ListPlugins(listRecorder, httptest.NewRequest(http.MethodGet, "/plugins", nil))
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list status = %d", listRecorder.Code)
	}
	var statuses []protocol.PluginStatus
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &statuses); err != nil || len(statuses) != 1 || statuses[0].PluginID != "reference" {
		t.Fatalf("list response = %#v, %v", statuses, err)
	}

	invokeRecorder := httptest.NewRecorder()
	handler.InvokePluginOperation(invokeRecorder, pluginInvokeRequest(`{"key":"alpha"}`))
	if invokeRecorder.Code != http.StatusOK || strings.TrimSpace(invokeRecorder.Body.String()) != `{"value":"alpha"}` {
		t.Fatalf("invoke = %d %s", invokeRecorder.Code, invokeRecorder.Body.String())
	}
	input, ok := registry.input.(map[string]any)
	if !ok || input["key"] != "alpha" {
		t.Fatalf("decoded input = %#v", registry.input)
	}
}

func TestPluginInvocationMapsPublicErrorsExactly(t *testing.T) {
	tests := []struct {
		name       string
		invokeErr  *coreplugins.InvokeError
		wantStatus int
		wantCode   protocol.ErrorCode
		wantDetail map[string]any
	}{
		{name: "not found", invokeErr: &coreplugins.InvokeError{Kind: coreplugins.InvokeNotFound}, wantStatus: http.StatusNotFound, wantCode: protocol.ErrorCodePluginNotFound},
		{
			name: "input rejected", invokeErr: &coreplugins.InvokeError{
				Kind: coreplugins.InvokeInputRejected, PluginCode: "invalid_key",
				PluginDetails: map[string]any{"field": "key"}, HasDetails: true,
			},
			wantStatus: http.StatusBadRequest, wantCode: protocol.ErrorCodePluginInputRejected,
			wantDetail: map[string]any{"plugin_code": "invalid_key", "plugin_details": map[string]any{"field": "key"}},
		},
		{
			name: "unavailable", invokeErr: &coreplugins.InvokeError{Kind: coreplugins.InvokeUnavailable, ReasonCode: "capacity_exhausted"},
			wantStatus: http.StatusServiceUnavailable, wantCode: protocol.ErrorCodePluginUnavailable,
			wantDetail: map[string]any{"reason_code": "capacity_exhausted"},
		},
		{name: "timeout", invokeErr: &coreplugins.InvokeError{Kind: coreplugins.InvokeTimeout}, wantStatus: http.StatusGatewayTimeout, wantCode: protocol.ErrorCodePluginTimeout},
		{
			name: "failure", invokeErr: &coreplugins.InvokeError{
				Kind: coreplugins.InvokeFailure, PluginCode: "source_failed", ReasonCode: "invalid_response",
			},
			wantStatus: http.StatusBadGateway, wantCode: protocol.ErrorCodePluginFailure,
			wantDetail: map[string]any{"plugin_code": "source_failed", "reason_code": "invalid_response"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := &Handler{plugins: &pluginRegistryStub{err: test.invokeErr}}
			recorder := httptest.NewRecorder()
			handler.InvokePluginOperation(recorder, pluginInvokeRequest(`null`))
			if recorder.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, test.wantStatus)
			}
			var response protocol.ErrorResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if response.ErrorCode != test.wantCode {
				t.Fatalf("error code = %s, want %s", response.ErrorCode, test.wantCode)
			}
			if encoded, want := mustJSON(t, response.Details), mustJSON(t, test.wantDetail); encoded != want {
				t.Fatalf("details = %s, want %s", encoded, want)
			}
		})
	}
}

func TestPluginInvocationEnforcesPublicJSONAndSizeBounds(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   protocol.ErrorCode
	}{
		{name: "invalid JSON", body: `{"key":`, wantStatus: http.StatusBadRequest, wantCode: protocol.ErrorCodeInvalidJSON},
		{name: "trailing JSON", body: `{} {}`, wantStatus: http.StatusBadRequest, wantCode: protocol.ErrorCodeInvalidJSON},
		{name: "oversized", body: `"` + strings.Repeat("x", maxPluginOperationInputBytes) + `"`, wantStatus: http.StatusRequestEntityTooLarge, wantCode: protocol.ErrorCodeBodyTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			(&Handler{plugins: &pluginRegistryStub{}}).InvokePluginOperation(recorder, pluginInvokeRequest(test.body))
			if recorder.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, test.wantStatus)
			}
			var response protocol.ErrorResponse
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || response.ErrorCode != test.wantCode {
				t.Fatalf("response = %#v, %v", response, err)
			}
		})
	}
}

func pluginInvokeRequest(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/plugins/reference/operations/inspect_fixture", strings.NewReader(body))
	route := chi.NewRouteContext()
	route.URLParams.Add("plugin_id", "reference")
	route.URLParams.Add("operation_id", "inspect_fixture")
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
