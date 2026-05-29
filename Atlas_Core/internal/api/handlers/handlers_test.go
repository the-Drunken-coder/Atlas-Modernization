package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

func newTestHandler() *Handler {
	return &Handler{
		logger: zerolog.Nop(),
		config: &config.Config{
			MaxViewSizeMB:   10,
			MaxUploadSizeMB: 100,
		},
	}
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()

	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode response body: %v", err)
	}
	return body
}

func routeRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func withURLParam(req *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
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
	if endpoints["changed_since"] != "/queries/changed-since" {
		t.Fatalf("expected changed_since endpoint, got %v", endpoints["changed_since"])
	}
}

func TestCreateEntityRejectsInvalidJSON(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/entities", `{"entity_id":`)

	handler.CreateEntity(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "INVALID_JSON" {
		t.Fatalf("expected INVALID_JSON, got %v", body["error_code"])
	}
	if body["path"] != "/entities" {
		t.Fatalf("expected error path /entities, got %v", body["path"])
	}
}

func TestCreateEntityRejectsOversizedBody(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	// Handler request bodies are capped at 1 MiB; exceed that limit by 64 bytes.
	oversizedValue := strings.Repeat("a", 1024*1024+64)
	req := routeRequest(http.MethodPost, "/entities", `{"entity_id":"`+oversizedValue+`"}`)

	handler.CreateEntity(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "BODY_TOO_LARGE" {
		t.Fatalf("expected BODY_TOO_LARGE, got %v", body["error_code"])
	}
}

func TestUpdateEntityTelemetryRequiresAtLeastOneField(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := withURLParam(routeRequest(http.MethodPatch, "/entities/entity-1/telemetry", `{}`), "entity_id", "entity-1")

	handler.UpdateEntityTelemetry(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	if !strings.Contains(body["message"].(string), "At least one telemetry field") {
		t.Fatalf("expected telemetry validation message, got %v", body["message"])
	}
}

func TestEntityCheckinRejectsOutOfRangeLimit(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := withURLParam(routeRequest(http.MethodPost, "/entities/entity-1/checkin?limit=25", `{}`), "entity_id", "entity-1")

	handler.EntityCheckin(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
}

func TestGetChangedSinceRejectsMissingParam(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/queries/changed-since", nil)

	handler.GetChangedSince(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	if body["message"] != "since parameter is required" {
		t.Fatalf("unexpected message: %v", body["message"])
	}
}

func TestGetChangedSinceRejectsInvalidTimestamp(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/queries/changed-since?since=not-a-date", nil)

	handler.GetChangedSince(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	details, _ := body["details"].(map[string]interface{})
	errs, _ := details["errors"].([]interface{})
	if len(errs) == 0 {
		t.Fatalf("expected details.errors for invalid since")
	}
}

func TestHandleActionErrorMapsKnownErrorTypes(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "/entities/entity-1", nil)

	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "validation",
			err:        actions.NewValidationError("bad field"),
			wantStatus: http.StatusBadRequest,
			wantCode:   "VALIDATION_ERROR",
		},
		{
			name:       "not found",
			err:        actions.NewEntityNotFoundError("entity-1"),
			wantStatus: http.StatusNotFound,
			wantCode:   "ENTITY_NOT_FOUND",
		},
		{
			name:       "conflict",
			err:        actions.NewEntityConflictError("entity-1"),
			wantStatus: http.StatusConflict,
			wantCode:   "ENTITY_ALREADY_EXISTS",
		},
		{
			name:       "storage error",
			err:        &storage.StorageError{Message: "storage down"},
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "STORAGE_ERROR",
		},
		{
			name:       "unknown error",
			err:        testError("boom"),
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_SERVER_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()

			handler.handleActionError(rec, req, tt.err)

			if rec.Code != tt.wantStatus {
				t.Fatalf("expected %d, got %d", tt.wantStatus, rec.Code)
			}

			body := decodeBody(t, rec)
			if body["error_code"] != tt.wantCode {
				t.Fatalf("expected %s, got %v", tt.wantCode, body["error_code"])
			}
			if id, ok := body["error_id"].(string); !ok || id == "" {
				t.Fatal("expected error_id to be populated")
			}
		})
	}
}

func TestParseStatusFilterNormalizesAndDeduplicates(t *testing.T) {
	got := parseStatusFilter(" Pending,ACKNOWLEDGED,pending, ,failed ")
	want := []string{"pending", "acknowledged", "failed"}

	if len(got) != len(want) {
		t.Fatalf("expected %d statuses, got %d", len(want), len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %q at index %d, got %q", want[i], i, got[i])
		}
	}
}

func TestParseRFC3339TimestampAcceptsNanoPrecision(t *testing.T) {
	raw := "2026-03-06T10:11:12.123456789Z"

	got, err := parseRFC3339Timestamp(raw)
	if err != nil {
		t.Fatalf("expected RFC3339Nano to parse, got error: %v", err)
	}
	if got.Format(time.RFC3339Nano) != raw {
		t.Fatalf("expected %s, got %s", raw, got.Format(time.RFC3339Nano))
	}
}

func TestSerializeCheckinTasksMinimalPromotesCommandData(t *testing.T) {
	entityID := "entity-1"
	tasks := []*serializers.TaskResponse{
		{
			TaskID:   "task-1",
			Status:   "pending",
			EntityID: &entityID,
			Components: map[string]interface{}{
				"command": map[string]interface{}{
					"id":         "move-to",
					"parameters": map[string]interface{}{"speed": "fast"},
				},
			},
		},
	}

	got := serializeCheckinTasksMinimal(tasks)
	if len(got) != 1 {
		t.Fatalf("expected 1 task, got %d", len(got))
	}
	if got[0]["command_id"] != "move-to" {
		t.Fatalf("expected promoted command_id, got %v", got[0]["command_id"])
	}

	params, ok := got[0]["parameters"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected parameters map, got %T", got[0]["parameters"])
	}
	if params["speed"] != "fast" {
		t.Fatalf("expected promoted parameters, got %v", params)
	}
}

func TestViewObjectRequiresConfiguredStorage(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/objects/object-1/view", nil)

	handler.ViewObject(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "STORAGE_UNAVAILABLE" {
		t.Fatalf("expected STORAGE_UNAVAILABLE, got %v", body["error_code"])
	}
}

func TestUploadObjectRequiresConfiguredStorage(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/objects/upload", nil)

	handler.UploadObject(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "STORAGE_UNAVAILABLE" {
		t.Fatalf("expected STORAGE_UNAVAILABLE, got %v", body["error_code"])
	}
}

func TestIsViewableContentTypeSupportsParameterizedTypes(t *testing.T) {
	if !isViewableContentType("application/json; charset=utf-8") {
		t.Fatal("expected JSON with charset to be viewable")
	}
	if isViewableContentType("image/png") {
		t.Fatal("expected image/png to be non-viewable")
	}
}

func TestGetExtensionForContentTypeUsesFallbacks(t *testing.T) {
	if got := getExtensionForContentType("application/x-laz"); got != ".laz" {
		t.Fatalf("expected .laz fallback, got %q", got)
	}
	if got := getExtensionForContentType("application/x-octet-stream"); got != "" {
		t.Fatalf("expected empty extension for unknown type, got %q", got)
	}
}

type testError string

func (e testError) Error() string {
	return string(e)
}
