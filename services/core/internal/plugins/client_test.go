package plugins

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
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
	result, remoteErr, clientErr := client.invoke(context.Background(), server.URL, "inspect_fixture", json.RawMessage(`{"key":"alpha"}`))
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

func TestHTTPClientMapsCancellationAndDeadlineWhileReadingBody(t *testing.T) {
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
			bodyStarted := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.(http.Flusher).Flush()
				close(bodyStarted)
				<-r.Context().Done()
			}))
			t.Cleanup(server.Close)
			ctx, cancel := test.context()
			defer cancel()
			result := make(chan *clientError, 1)
			go func() {
				_, _, err := newHTTPClient(server.Client()).invoke(ctx, server.URL, "inspect_fixture", json.RawMessage("null"))
				result <- err
			}()
			<-bodyStarted
			if test.wantKind == failureCanceled {
				cancel()
			}
			select {
			case err := <-result:
				if err == nil || err.kind != test.wantKind {
					t.Fatalf("error = %#v, want %s", err, test.wantKind)
				}
			case <-time.After(time.Second):
				t.Fatal("private response body did not observe context completion")
			}
		})
	}
}

func TestDefaultHTTPClientBypassesEnvironmentProxies(t *testing.T) {
	client := newHTTPClient(nil)
	transport, ok := client.client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatalf("private transport = %#v, want proxy disabled", client.client.Transport)
	}
}

func TestHTTPClientOmitsIPv6ZoneFromHostHeader(t *testing.T) {
	type requestResult struct {
		host string
		err  error
	}
	dialed := make(chan string, 1)
	requestRead := make(chan requestResult, 1)
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(_ context.Context, _, address string) (net.Conn, error) {
			dialed <- address
			client, server := net.Pipe()
			go func() {
				defer func() { _ = server.Close() }()
				request, err := http.ReadRequest(bufio.NewReader(server))
				if err != nil {
					requestRead <- requestResult{err: err}
					return
				}
				requestRead <- requestResult{host: request.Host}
				_, _ = server.Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"status\":\"ok\"}"))
			}()
			return client, nil
		},
	}
	t.Cleanup(transport.CloseIdleConnections)
	client := newHTTPClient(&http.Client{Transport: transport, Timeout: time.Second})
	healthy, clientErr := client.health(context.Background(), "http://[fe80::1%25Windows%20Loves%20Spaces]:8080")
	if clientErr != nil || !healthy {
		t.Fatalf("health = %t, error = %v", healthy, clientErr)
	}
	if got, want := <-dialed, "[fe80::1%Windows Loves Spaces]:8080"; got != want {
		t.Fatalf("dial address = %q, want %q", got, want)
	}
	result := <-requestRead
	if result.err != nil {
		t.Fatal(result.err)
	}
	if got, want := result.host, "[fe80::1]:8080"; got != want {
		t.Fatalf("Host = %q, want %q", got, want)
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
