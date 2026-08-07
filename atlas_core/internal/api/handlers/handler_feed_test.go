package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func TestFeedWithoutHubReturnsServiceUnavailable(t *testing.T) {
	handler := &Handler{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	handler.Feed(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	var body ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.ErrorCode != protocol.ErrorCodeFeedUnavailable {
		t.Fatalf("unexpected body: %+v", body)
	}
	if strings.TrimSpace(body.Message) == "" {
		t.Fatal("expected non-empty error message")
	}
	if body.ErrorID == "" {
		t.Fatal("expected error_id to be populated")
	}
}

func TestFeedConfigNilReturnsServiceUnavailable(t *testing.T) {
	hub := feed.NewHub(feed.Options{})
	defer hub.Close()
	handler := &Handler{feedHub: hub, config: nil}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	handler.Feed(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	var body ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.ErrorCode != protocol.ErrorCodeFeedUnavailable {
		t.Fatalf("unexpected body: %+v", body)
	}
	if strings.TrimSpace(body.Message) == "" {
		t.Fatal("expected non-empty error message")
	}
	if body.ErrorID == "" {
		t.Fatal("expected error_id to be populated")
	}
}

func TestFeedAuthEnabledWithEmptyKeyReturnsServiceUnavailable(t *testing.T) {
	hub := feed.NewHub(feed.Options{})
	defer hub.Close()
	handler := &Handler{
		feedHub: hub,
		config: &config.Config{
			EnableAPIAuth: true,
			APIAuthKey:    "",
		},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	handler.Feed(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	var body ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.ErrorCode != protocol.ErrorCodeFeedUnavailable {
		t.Fatalf("unexpected body: %+v", body)
	}
	if strings.TrimSpace(body.Message) == "" {
		t.Fatal("expected non-empty error message")
	}
	if body.ErrorID == "" {
		t.Fatal("expected error_id to be populated")
	}
}

func TestFeedRejectsUnauthenticatedWhenAPIAuthDisabled(t *testing.T) {
	hub := feed.NewHub(feed.Options{})
	defer hub.Close()
	handler := &Handler{
		feedHub: hub,
		config: &config.Config{
			EnableAPIAuth: false,
		},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	handler.Feed(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	var body ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.ErrorCode != protocol.ErrorCodeUnauthorized {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestFeedServerConfigNormalizesAuthAndOrigins(t *testing.T) {
	cfg := &config.Config{
		EnableAPIAuth: true,
		APIAuthKey:    "  secret-key  ",
		CORSOrigins: []string{
			"http://localhost:5173",
			"https://atlas.example:8443",
			"devbox.local:3000",
			" ",
		},
		CORSOriginPatterns: []string{
			"https://*.atlas-je0.pages.dev",
		},
	}

	got := feedServerConfig(cfg)

	if got.APIKey != "secret-key" {
		t.Fatalf("APIKey = %q, want trimmed key", got.APIKey)
	}
	if got.AllowedOrigin == nil {
		t.Fatal("AllowedOrigin must be configured")
	}
	if !got.AllowedOrigin("https://atlas.example:8443") {
		t.Fatal("expected exact origin to be allowed")
	}
	if !got.AllowedOrigin("https://pr-123.atlas-je0.pages.dev") {
		t.Fatal("expected constrained preview origin to be allowed")
	}
	if got.AllowedOrigin("https://extra.pr-123.atlas-je0.pages.dev") {
		t.Fatal("expected extra subdomain label in wildcard slot to be rejected")
	}
}

func TestRootReturnsCurrentAPIContract(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)

	handler.Root(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected application/json content type, got %q", got)
	}

	body := decodeBody(t, rec)
	if body["name"] != "ATLAS Core API" {
		t.Fatalf("expected API name, got %v", body["name"])
	}

	endpoints, ok := body["endpoints"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected endpoints object, got %T", body["endpoints"])
	}
	if endpoints["readiness"] != "/readiness" {
		t.Fatalf("expected readiness endpoint to be exposed, got %v", endpoints["readiness"])
	}
	if endpoints["command_catalog"] != "/command-catalog" {
		t.Fatalf("expected command catalog endpoint to be exposed, got %v", endpoints["command_catalog"])
	}
	if endpoints["resources"] != "/resources" {
		t.Fatalf("expected resources endpoint, got %v", endpoints["resources"])
	}
	if endpoints["changed_since"] != "/queries/changed-since" {
		t.Fatalf("expected changed_since endpoint, got %v", endpoints["changed_since"])
	}
	if _, ok := body["links"]; ok {
		t.Fatal("expected root response to expose endpoints without duplicate links")
	}
}
