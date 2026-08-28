package plugins

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPClientDecodesExactPrivateProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/manifest":
			_, _ = w.Write([]byte(`{"plugin_id":"reference","display_name":"Reference","operations":[{"operation_id":"inspect_fixture","display_name":"Inspect fixture","timeout_ms":5000}]}`))
		case "/health":
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		case "/operations/inspect_fixture":
			_, _ = w.Write([]byte(`{"value":7}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	client := newHTTPClient(server.Client())

	manifest, clientErr := client.manifest(context.Background(), server.URL)
	if clientErr != nil || manifest.PluginID != "reference" || len(manifest.Operations) != 1 {
		t.Fatalf("manifest = %#v, %v", manifest, clientErr)
	}
	healthy, clientErr := client.health(context.Background(), server.URL)
	if clientErr != nil || !healthy {
		t.Fatalf("health = %t, %v", healthy, clientErr)
	}
	result, remoteErr, clientErr := client.invoke(context.Background(), server.URL, "inspect_fixture", map[string]any{"key": "alpha"})
	object, objectOK := result.(map[string]any)
	value, valueOK := object["value"].(json.Number)
	if clientErr != nil || remoteErr != nil || !objectOK || !valueOK || value.String() != "7" {
		t.Fatalf("result = %#v, remote = %#v, client = %v", result, remoteErr, clientErr)
	}

	for _, test := range []struct {
		name       string
		status     int
		body       string
		wantReject bool
		wantCode   string
	}{
		{name: "input rejected", status: http.StatusBadRequest, body: `{"code":"invalid_key","details":{"field":"key"}}`, wantReject: true, wantCode: "invalid_key"},
		{name: "handled failure", status: http.StatusInternalServerError, body: `{"code":"source_failed"}`, wantCode: "source_failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			operationServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			t.Cleanup(operationServer.Close)
			_, remote, callErr := newHTTPClient(operationServer.Client()).invoke(context.Background(), operationServer.URL, "inspect_fixture", nil)
			if callErr != nil || remote == nil || remote.rejected != test.wantReject || remote.code != test.wantCode {
				t.Fatalf("remote = %#v, client = %v", remote, callErr)
			}
		})
	}
}

func TestHTTPClientRejectsMalformedAndOversizedPrivateResponses(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		call     func(*httpClient, string) *clientError
		wantKind clientFailure
	}{
		{
			name: "manifest missing operations", body: `{"plugin_id":"reference","display_name":"Reference"}`,
			call: func(client *httpClient, origin string) *clientError {
				_, err := client.manifest(context.Background(), origin)
				return err
			},
			wantKind: failureInvalidManifest,
		},
		{
			name: "manifest null operations", body: `{"plugin_id":"reference","display_name":"Reference","operations":null}`,
			call: func(client *httpClient, origin string) *clientError {
				_, err := client.manifest(context.Background(), origin)
				return err
			},
			wantKind: failureInvalidManifest,
		},
		{
			name: "manifest null tool asset", body: `{"plugin_id":"reference","display_name":"Reference","operations":[],"tool_asset_id":null}`,
			call: func(client *httpClient, origin string) *clientError {
				_, err := client.manifest(context.Background(), origin)
				return err
			},
			wantKind: failureInvalidManifest,
		},
		{
			name: "health unknown field", body: `{"status":"ok","detail":"private"}`,
			call: func(client *httpClient, origin string) *clientError {
				_, err := client.health(context.Background(), origin)
				return err
			},
			wantKind: failureInvalidResponse,
		},
		{
			name: "operation unexpected status", status: http.StatusTeapot, body: `{"code":"failed"}`,
			call: func(client *httpClient, origin string) *clientError {
				_, _, err := client.invoke(context.Background(), origin, "inspect_fixture", nil)
				return err
			},
			wantKind: failureInvalidResponse,
		},
		{
			name: "operation oversized", body: `"` + strings.Repeat("x", maxPrivateResponseBytes) + `"`,
			call: func(client *httpClient, origin string) *clientError {
				_, _, err := client.invoke(context.Background(), origin, "inspect_fixture", nil)
				return err
			},
			wantKind: failureInvalidResponse,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				status := test.status
				if status == 0 {
					status = http.StatusOK
				}
				w.WriteHeader(status)
				_, _ = w.Write([]byte(test.body))
			}))
			t.Cleanup(server.Close)
			err := test.call(newHTTPClient(server.Client()), server.URL)
			if err == nil || err.kind != test.wantKind {
				t.Fatalf("error = %#v, want %s", err, test.wantKind)
			}
		})
	}
}

func TestHTTPClientMapsCancellationAndDeadline(t *testing.T) {
	for _, test := range []struct {
		name     string
		context  func() (context.Context, context.CancelFunc)
		wantKind clientFailure
	}{
		{name: "cancellation", context: func() (context.Context, context.CancelFunc) { return context.WithCancel(context.Background()) }, wantKind: failureCanceled},
		{name: "deadline", context: func() (context.Context, context.CancelFunc) {
			return context.WithTimeout(context.Background(), 50*time.Millisecond)
		}, wantKind: failureTimeout},
	} {
		t.Run(test.name, func(t *testing.T) {
			entered := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				close(entered)
				<-r.Context().Done()
			}))
			t.Cleanup(server.Close)
			ctx, cancel := test.context()
			defer cancel()
			result := make(chan *clientError, 1)
			go func() {
				_, err := newHTTPClient(server.Client()).health(ctx, server.URL)
				result <- err
			}()
			<-entered
			if test.wantKind == failureCanceled {
				cancel()
			}
			select {
			case err := <-result:
				if err == nil || err.kind != test.wantKind {
					t.Fatalf("error = %#v, want %s", err, test.wantKind)
				}
			case <-time.After(time.Second):
				t.Fatal("private request did not observe context completion")
			}
		})
	}
}

func TestHTTPClientRejectsNonJSONContentType(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	t.Cleanup(server.Close)
	_, err := newHTTPClient(server.Client()).health(context.Background(), server.URL)
	if err == nil || err.kind != failureInvalidResponse {
		t.Fatalf("error = %#v, want invalid response", err)
	}
}

func TestHTTPClientDoesNotFollowPrivateRedirects(t *testing.T) {
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"plugin_id":"reference","display_name":"Reference","operations":[]}`))
	}))
	t.Cleanup(redirectTarget.Close)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", redirectTarget.URL)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusFound)
		_, _ = w.Write([]byte(`{"redirected":true}`))
	}))
	t.Cleanup(server.Close)

	_, err := newHTTPClient(server.Client()).manifest(context.Background(), server.URL)
	if err == nil || err.kind != failureInvalidManifest {
		t.Fatalf("error = %#v, want invalid manifest", err)
	}
}
