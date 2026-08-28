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
		"connectors":[{
			"id":"reference","origin":"https://source.example",
			"routes":[{"method":"GET","path_prefix":"/fixture","allowed_query_names":["key"],"allowed_request_headers":[],"allowed_response_headers":[],"read_only":true,"cache":{},"retry":{}}],
			"secret_headers":{},"egress":{},"limits":{},"rate":{},"circuit_breaker":{}
		}]
	}`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	connector := config.Connectors[0]
	if connector.Limits.TimeoutMS != 10_000 || connector.Limits.MaxRequestBytes != 256<<10 || connector.Limits.MaxResponseBytes != 4<<20 {
		t.Fatalf("unexpected defaults: %+v", connector.Limits)
	}
	if connector.Limits.MaxConcurrency != 4 || connector.CircuitBreaker.Failures != 3 || connector.CircuitBreaker.OpenMS != 30_000 {
		t.Fatalf("unexpected control defaults: %+v %+v", connector.Limits, connector.CircuitBreaker)
	}

	if err := os.WriteFile(path, []byte(`{"connectors":[],"unknown":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("expected unknown configuration field to fail")
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
