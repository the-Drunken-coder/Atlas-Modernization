package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/cors"
	custommiddleware "github.com/the-drunken-coder/atlas/atlas_core/internal/api/middleware"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
)

func storageConfig(endpoint string, disposable bool) *config.Config {
	return &config.Config{
		DatabaseRecreateOnStartup: disposable,
		MinIOEndpoint:             endpoint,
		MinIOAccessKey:            "atlas",
		MinIOSecretKey:            "secret",
		MinioBucket:               "atlas",
	}
}

func TestInitializeStorageDurableConfiguration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/atlas/" && r.URL.Query().Has("location") {
			_, _ = w.Write([]byte("<LocationConstraint></LocationConstraint>"))
			return
		}
		if r.Method != http.MethodHead || r.URL.Path != "/atlas/" {
			http.Error(w, "unexpected storage request", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client, err := initializeStorage(context.Background(), storageConfig(strings.TrimPrefix(server.URL, "http://"), false))
	if err != nil {
		t.Fatalf("initialize complete durable storage: %v", err)
	}
	if client == nil {
		t.Fatal("expected durable storage client")
	}
}

func TestInitializeStorageDurableConfigurationRequiresEveryField(t *testing.T) {
	tests := []struct {
		name  string
		clear func(*config.Config)
	}{
		{"endpoint", func(cfg *config.Config) { cfg.MinIOEndpoint = "" }},
		{"access key", func(cfg *config.Config) { cfg.MinIOAccessKey = "" }},
		{"secret key", func(cfg *config.Config) { cfg.MinIOSecretKey = "" }},
		{"bucket", func(cfg *config.Config) { cfg.MinioBucket = "" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := storageConfig("localhost:9000", false)
			tt.clear(cfg)
			if _, err := initializeStorage(context.Background(), cfg); err == nil {
				t.Fatal("expected incomplete durable storage configuration to fail")
			}
		})
	}
}

func TestInitializeStorageDurableConfigurationRejectsUnavailableStorage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := initializeStorage(ctx, storageConfig("127.0.0.1:1", false)); err == nil {
		t.Fatal("expected unavailable durable storage to fail")
	}
}

func TestInitializeStorageDurableConfigurationRejectsMissingBucket(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		isBucketProbe := r.URL.Path == "/atlas/" && (r.Method == http.MethodHead || (r.Method == http.MethodGet && r.URL.Query().Has("location")))
		if !isBucketProbe {
			http.Error(w, r.Method+" "+r.URL.String(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("<Error><Code>NoSuchBucket</Code></Error>"))
	}))
	defer server.Close()

	_, err := initializeStorage(context.Background(), storageConfig(strings.TrimPrefix(server.URL, "http://"), false))
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing durable bucket error = %v", err)
	}
}

func TestInitializeStorageDisposableDevelopmentAllowsUnavailableStorage(t *testing.T) {
	client, err := initializeStorage(context.Background(), storageConfig("", true))
	if err != nil {
		t.Fatalf("initialize disposable development storage: %v", err)
	}
	if client != nil {
		t.Fatal("expected unavailable disposable storage to remain disabled")
	}
}

func TestNewHTTPServerRetainsOrdinaryRequestProtection(t *testing.T) {
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	server := newHTTPServer(":1234", handler)

	if server.Addr != ":1234" || server.Handler == nil {
		t.Fatalf("server address/handler = %q %T, want :1234 and supplied handler", server.Addr, server.Handler)
	}
	if server.ReadHeaderTimeout != 10*time.Second {
		t.Fatalf("ReadHeaderTimeout = %s, want 10s", server.ReadHeaderTimeout)
	}
	if server.ReadTimeout != 30*time.Second {
		t.Fatalf("ReadTimeout = %s, want 30s", server.ReadTimeout)
	}
	if server.WriteTimeout != 30*time.Second {
		t.Fatalf("WriteTimeout = %s, want 30s", server.WriteTimeout)
	}
	if server.IdleTimeout != 120*time.Second {
		t.Fatalf("IdleTimeout = %s, want 2m", server.IdleTimeout)
	}
}

func TestAtlasCORSOptionsAllowsCredentialsAndExposesCursorHeaders(t *testing.T) {
	origins := []string{"http://localhost:3000"}

	opts := atlasCORSOptions(origins, nil)

	if !opts.AllowCredentials {
		t.Fatal("expected CORS AllowCredentials to be true")
	}
	if opts.AllowOriginFunc == nil {
		t.Fatal("expected CORS AllowOriginFunc to be configured")
	}
	if !opts.AllowOriginFunc(nil, origins[0]) {
		t.Fatalf("expected exact origin %q to be allowed", origins[0])
	}
	emptyOpts := atlasCORSOptions(nil, nil)
	if emptyOpts.AllowOriginFunc(nil, "https://atlasinterface.com") {
		t.Fatal("expected empty CORS config to reject normal origins")
	}
	for _, header := range []string{"Accept", "Authorization", "Content-Type", "If-Match", "X-API-Key", "X-Request-ID"} {
		if !slices.Contains(opts.AllowedHeaders, header) {
			t.Fatalf("expected allowed header %s in %#v", header, opts.AllowedHeaders)
		}
	}
	for _, header := range []string{"ETag", "X-Has-More", "X-Next-Cursor", "X-Limit", "X-Returned-Count", "Content-Length"} {
		if !slices.Contains(opts.ExposedHeaders, header) {
			t.Fatalf("expected exposed header %s in %#v", header, opts.ExposedHeaders)
		}
	}
	for _, removed := range []string{"X-Total-Count", "X-Offset"} {
		if slices.Contains(opts.ExposedHeaders, removed) {
			t.Fatalf("did not expect old pagination header %s in %#v", removed, opts.ExposedHeaders)
		}
	}
}

func TestAtlasCORSOptionsAllowsConstrainedOriginPatterns(t *testing.T) {
	opts := atlasCORSOptions(
		[]string{"https://atlasinterface.com"},
		[]string{"https://*.atlas-je0.pages.dev"},
	)

	if !opts.AllowOriginFunc(nil, "https://feature-123.atlas-je0.pages.dev") {
		t.Fatal("expected Cloudflare preview origin to be allowed")
	}
	if opts.AllowOriginFunc(nil, "https://feature-123.atlas-je0.pages.dev.evil.test") {
		t.Fatal("expected suffix lookalike origin to be rejected")
	}
	if opts.AllowOriginFunc(nil, "https://atlas-je0.pages.dev") {
		t.Fatal("expected empty wildcard value to be rejected")
	}
}

func TestAtlasCORSPreflightEchoesAllowedPreviewOrigin(t *testing.T) {
	origin := "https://feature-123.atlas-je0.pages.dev"
	handler := cors.Handler(atlasCORSOptions(
		[]string{"https://atlasinterface.com"},
		[]string{"https://*.atlas-je0.pages.dev"},
	))(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodOptions, "/admin/auth/me", nil)
	req.Header.Set("Origin", origin)
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected preflight 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, origin)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}
}

func TestAtlasCORSAndAuthAgreeOnPreviewOriginPatterns(t *testing.T) {
	cfg := &config.Config{
		CORSOrigins:        []string{"https://atlasinterface.com"},
		CORSOriginPatterns: []string{"https://*.atlas-je0.pages.dev"},
	}
	handler := cors.Handler(atlasCORSOptions(cfg.CORSOrigins, cfg.CORSOriginPatterns))(
		custommiddleware.CombinedAuth("", false, nil, cfg.CORSOrigins, cfg.CORSOriginPatterns)(
			http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}),
		),
	)

	for _, tt := range []struct {
		name       string
		origin     string
		wantStatus int
		wantACAO   string
	}{
		{
			name:       "matching preview origin",
			origin:     "https://feature-123.atlas-je0.pages.dev",
			wantStatus: http.StatusNoContent,
			wantACAO:   "https://feature-123.atlas-je0.pages.dev",
		},
		{
			name:       "suffix lookalike origin",
			origin:     "https://feature-123.atlas-je0.pages.dev.evil.test",
			wantStatus: http.StatusUnauthorized,
			wantACAO:   "",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/admin/auth/logout", nil)
			req.Header.Set("Origin", tt.origin)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != tt.wantACAO {
				t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, tt.wantACAO)
			}
		})
	}
}
