package sourcegateway

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigDefaultsAndStrictDecoding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source_gateway.json")
	contents := `{
		"listen_address":":8080"
	}`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	connectorDirectory := filepath.Join(t.TempDir(), "connectors")
	if err := os.Mkdir(connectorDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	connector := `{
		"id":"reference","origin":"https://source.example",
		"routes":[{"method":"GET","path_prefix":"/fixture","allowed_query_names":["key"],"allowed_request_headers":[],"allowed_response_headers":[],"read_only":true,"cache":{},"retry":{}}],
		"secret_headers":{},"egress":{},"limits":{},"rate":{},"circuit_breaker":{}
	}`
	if err := os.WriteFile(filepath.Join(connectorDirectory, "reference.json"), []byte(connector), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfig(path, connectorDirectory)
	if err != nil {
		t.Fatal(err)
	}
	loadedConnector := config.Connectors[0]
	if loadedConnector.Limits.TimeoutMS != 10_000 || loadedConnector.Limits.MaxRequestBytes != 256<<10 || loadedConnector.Limits.MaxResponseBytes != 4<<20 {
		t.Fatalf("unexpected defaults: %+v", loadedConnector.Limits)
	}
	if loadedConnector.Limits.MaxConcurrency != 4 || loadedConnector.CircuitBreaker.Failures != 3 || loadedConnector.CircuitBreaker.OpenMS != 30_000 {
		t.Fatalf("unexpected control defaults: %+v %+v", loadedConnector.Limits, loadedConnector.CircuitBreaker)
	}

	if err := os.WriteFile(path, []byte(`{"connectors":[],"unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path, connectorDirectory); err == nil {
		t.Fatal("expected unknown configuration field to fail")
	}

	if err := os.WriteFile(path, []byte(`{"listen_address":":8080"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connectorDirectory, "unknown.json"), []byte(`{"id":"other","unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path, connectorDirectory); err == nil {
		t.Fatal("expected unknown connector fragment field to fail")
	}
}

func TestConfigRejectsUnsafeCacheRetryAndCredentials(t *testing.T) {
	base := testConnectorConfig()
	base.Routes[0].Cache.TTLMS = int64(time.Second / time.Millisecond)
	base.Routes[0].ReadOnly = false
	if _, err := New(Config{Connectors: []ConnectorConfig{base}}, Options{}); err == nil {
		t.Fatal("expected mutating cache rule to fail")
	}

	base = testConnectorConfig()
	base.Routes[0].Method = "POST"
	base.Routes[0].ReadOnly = false
	base.Routes[0].Retry.MaxRetries = 1
	if _, err := New(Config{Connectors: []ConnectorConfig{base}}, Options{}); err == nil {
		t.Fatal("expected mutating retry without idempotency key to fail")
	}

	base.Routes[0].Retry.IdempotencyHeader = "idempotency-key"
	if _, err := New(Config{Connectors: []ConnectorConfig{base}}, Options{}); err == nil {
		t.Fatal("expected unallowlisted idempotency header to fail")
	}
	base.Routes[0].AllowedRequestHeaders = []string{"idempotency-key"}
	if _, err := New(Config{Connectors: []ConnectorConfig{base}}, Options{}); err != nil {
		t.Fatalf("allowlisted idempotency header failed: %v", err)
	}

	base = testConnectorConfig()
	base.SecretHeaders = map[string]SecretRef{"authorization": {Environment: "TOKEN"}}
	if _, err := New(Config{Connectors: []ConnectorConfig{base}}, Options{}); err == nil {
		t.Fatal("expected forbidden credential header to fail")
	}
}

func TestQueryNamesRemainCaseSensitive(t *testing.T) {
	base := testConnectorConfig()
	base.Routes[0].AllowedQueryNames = []string{"Key", "key"}
	gateway, err := New(Config{Connectors: []ConnectorConfig{base}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	got := gateway.connectors[base.ID].config.Routes[0].AllowedQueryNames
	if len(got) != 2 || got[0] != "Key" || got[1] != "key" {
		t.Fatalf("query names lost case-sensitive identity: %q", got)
	}
}

func testConnectorConfig() ConnectorConfig {
	return ConnectorConfig{
		ID: "reference", Origin: "https://source.example",
		Routes: []RouteRule{{
			Method: "GET", PathPrefix: "/fixture", AllowedQueryNames: []string{"key"},
			AllowedRequestHeaders: []string{"x-request"}, AllowedResponseHeaders: []string{"x-result"}, ReadOnly: true,
		}},
	}
}
