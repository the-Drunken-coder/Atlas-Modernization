package handlers

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/admin"
	"github.com/the-drunken-coder/atlas/services/core/internal/config"
	"github.com/the-drunken-coder/atlas/services/core/internal/database"
	"github.com/the-drunken-coder/atlas/services/core/internal/storage"
)

func TestNewHandlerRequiresConfig(t *testing.T) {
	assertPanicContains(t, "config is required", func() {
		NewHandler(nil, nil, zerolog.Nop(), nil)
	})
}

func TestNewHandlerRequiresInitializedDBPool(t *testing.T) {
	cfg := &config.Config{}
	assertPanicContains(t, "initialized pool is required", func() {
		NewHandler(nil, nil, zerolog.Nop(), cfg)
	})
	assertPanicContains(t, "initialized pool is required", func() {
		NewHandler(&database.DB{}, nil, zerolog.Nop(), cfg)
	})
}
func TestAdminAuthPostRejectsUntrustedOrigin(t *testing.T) {
	for _, tc := range []struct {
		name   string
		target string
		serve  func(*Handler, http.ResponseWriter, *http.Request)
		body   string
	}{
		{
			name:   "login",
			target: "/admin/auth/login",
			serve:  (*Handler).AdminLogin,
			body:   `{"username":"admin","password":"password"}`,
		},
		{
			name:   "logout",
			target: "/admin/auth/logout",
			serve:  (*Handler).AdminLogout,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestHandler()
			h.config.CORSOrigins = []string{"https://ui.test"}
			h.adminAuth = admin.NewService(nil, h.config)

			rec := httptest.NewRecorder()
			req := routeRequest(http.MethodPost, tc.target, tc.body)
			req.Header.Set("Origin", "https://evil.test")
			tc.serve(h, rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d", rec.Code)
			}
			if body := decodeBody(t, rec); body["error_code"] != string(protocol.ErrorCodeUnauthorized) {
				t.Fatalf("expected UNAUTHORIZED code, got %v", body["error_code"])
			}
		})
	}
}

func TestLivenessCheckAlwaysHealthy(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)

	handler.LivenessCheck(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["status"] != "healthy" {
		t.Fatalf("expected healthy status, got %v", body["status"])
	}
	if body["service"] != "atlas-core" {
		t.Fatalf("expected atlas-core service, got %v", body["service"])
	}
	if _, ok := body["checks"]; ok {
		t.Fatal("liveness response should not include dependency checks")
	}
}

func TestReadinessCheckWithoutDBReturnsUnhealthy(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/readiness", nil)

	handler.ReadinessCheck(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["status"] != "unhealthy" {
		t.Fatalf("expected unhealthy status, got %v", body["status"])
	}

	checks, ok := body["checks"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected checks object, got %T", body["checks"])
	}
	dbCheck, ok := checks["database"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected database check, got %T", checks["database"])
	}
	if dbCheck["status"] != "unhealthy" {
		t.Fatalf("expected unhealthy database, got %v", dbCheck["status"])
	}
	storageCheck, ok := checks["storage"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected storage check, got %T", checks["storage"])
	}
	if storageCheck["status"] != "unconfigured" {
		t.Fatalf("expected deliberately unconfigured storage, got %v", storageCheck["status"])
	}
}

func TestReadinessCheckWithConfiguredStorageClientMissingReturnsUnhealthy(t *testing.T) {
	handler := newTestHandler()
	handler.config.MinIOSecretKey = "configured-secret"
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/readiness", nil)

	handler.ReadinessCheck(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	checks := decodeBody(t, rec)["checks"].(map[string]interface{})
	storageCheck := checks["storage"].(map[string]interface{})
	if storageCheck["status"] != "unhealthy" {
		t.Fatalf("expected unhealthy configured storage, got %v", storageCheck["status"])
	}
}

func TestReadinessCheckWithUnreachableStorageReturnsUnhealthy(t *testing.T) {
	storageClient, err := storage.NewClient(&config.Config{
		MinIOEndpoint:  "127.0.0.1:1",
		MinIOAccessKey: "atlas",
		MinIOSecretKey: "configured-secret",
		MinioBucket:    "atlas-media",
	})
	if err != nil {
		t.Fatalf("create storage client: %v", err)
	}
	handler := newTestHandler()
	handler.storage = storageClient

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/readiness", nil).WithContext(ctx)

	handler.ReadinessCheck(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	checks := decodeBody(t, rec)["checks"].(map[string]interface{})
	storageCheck := checks["storage"].(map[string]interface{})
	if storageCheck["status"] != "unhealthy" {
		t.Fatalf("expected unhealthy unreachable storage, got %v", storageCheck["status"])
	}
}

func TestReadinessOutcome(t *testing.T) {
	tests := []struct {
		name         string
		database     string
		storage      string
		wantStatus   string
		wantHTTPCode int
	}{
		{name: "all dependencies healthy", database: "healthy", storage: "healthy", wantStatus: "healthy", wantHTTPCode: http.StatusOK},
		{name: "database unavailable", database: "unhealthy", storage: "healthy", wantStatus: "unhealthy", wantHTTPCode: http.StatusServiceUnavailable},
		{name: "configured storage unavailable", database: "healthy", storage: "unhealthy", wantStatus: "unhealthy", wantHTTPCode: http.StatusServiceUnavailable},
		{name: "storage deliberately unconfigured", database: "healthy", storage: "unconfigured", wantStatus: "degraded", wantHTTPCode: http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, httpCode := readinessOutcome(tt.database, tt.storage)
			if status != tt.wantStatus || httpCode != tt.wantHTTPCode {
				t.Fatalf("readinessOutcome(%q, %q) = (%q, %d), want (%q, %d)", tt.database, tt.storage, status, httpCode, tt.wantStatus, tt.wantHTTPCode)
			}
		})
	}
}

func TestResourcesReturnsUsageSnapshot(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/resources", nil)

	handler.Resources(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["service"] != "atlas-core" {
		t.Fatalf("expected atlas-core service, got %v", body["service"])
	}
	if body["timestamp"] == "" {
		t.Fatal("expected timestamp")
	}

	cpu, ok := body["cpu"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected cpu object, got %T", body["cpu"])
	}
	cores, ok := cpu["cores"].(float64)
	if !ok || cores < 1 {
		t.Fatalf("expected at least one CPU core, got %v", cpu["cores"])
	}

	disk, ok := body["disk"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected disk object, got %T", body["disk"])
	}
	if disk["path"] != "/" {
		t.Fatalf("expected root disk path, got %v", disk["path"])
	}

	process, ok := body["process"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected process object, got %T", body["process"])
	}
	goroutines, ok := process["goroutines"].(float64)
	if !ok || goroutines < 1 {
		t.Fatalf("expected goroutine count, got %v", process["goroutines"])
	}
}

func TestParseCPUSnapshotAndUsage(t *testing.T) {
	first, err := parseCPUSnapshot("cpu  100 0 50 850 0 0 0 0 30 5")
	if err != nil {
		t.Fatalf("parse first snapshot: %v", err)
	}
	second, err := parseCPUSnapshot("cpu  120 0 70 900 0 0 0 0 50 10")
	if err != nil {
		t.Fatalf("parse second snapshot: %v", err)
	}

	if first.total != 1000 {
		t.Fatalf("first total = %d, want 1000", first.total)
	}
	if second.total != 1090 {
		t.Fatalf("second total = %d, want 1090", second.total)
	}
	const wantUsage = 44.44
	if got := cpuUsagePercent(first, second); math.Abs(got-wantUsage) > 0.001 {
		t.Fatalf("usage percent = %v, want %v", got, wantUsage)
	}
}

func TestParseMeminfoBytes(t *testing.T) {
	total, available, err := parseMeminfoBytes("MemTotal: 1000 kB\nHugePages_Total: 1\nMemAvailable: 250 kB\n")
	if err != nil {
		t.Fatalf("parse meminfo: %v", err)
	}
	if total != 1024000 {
		t.Fatalf("total = %d, want 1024000", total)
	}
	if available != 256000 {
		t.Fatalf("available = %d, want 256000", available)
	}
}
