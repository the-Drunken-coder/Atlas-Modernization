package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/admin"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/config"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/database"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/feed"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
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

func assertPanicContains(t *testing.T, want string, fn func()) {
	t.Helper()
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatalf("expected panic containing %q", want)
		}
		if !strings.Contains(fmt.Sprint(recovered), want) {
			t.Fatalf("panic = %v, want substring %q", recovered, want)
		}
	}()
	fn()
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

func multipartUploadRequest(t *testing.T, fields map[string]string, fileSize int) *http.Request {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatalf("write field %q: %v", key, err)
		}
	}
	file, err := writer.CreateFormFile("file", "upload.bin")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := file.Write(bytes.Repeat([]byte("a"), fileSize)); err != nil {
		t.Fatalf("write file body: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/objects/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
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
	hub := feed.NewHub(1, feed.Options{})
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
	hub := feed.NewHub(1, feed.Options{})
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
	hub := feed.NewHub(1, feed.Options{})
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
			"https://*-atlas-command-interface.laraujo123546.workers.dev",
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
	if !got.AllowedOrigin("https://pr-123-atlas-command-interface.laraujo123546.workers.dev") {
		t.Fatal("expected constrained preview origin to be allowed")
	}
	if got.AllowedOrigin("https://extra.pr-123-atlas-command-interface.laraujo123546.workers.dev") {
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
	if endpoints["changed_since"] != "/queries/changed-since" {
		t.Fatalf("expected changed_since endpoint, got %v", endpoints["changed_since"])
	}
	if _, ok := body["links"]; ok {
		t.Fatal("expected root response to expose endpoints without duplicate links")
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

func TestCreateEntityRejectsTrailingJSON(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/entities", `{"entity_id":"entity-1","entity_type":"asset"}{"extra":true}`)

	handler.CreateEntity(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "INVALID_JSON" {
		t.Fatalf("expected INVALID_JSON, got %v", body["error_code"])
	}
}

func TestCreateEntityRejectsUnknownField(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/entities", `{"entity_id":"entity-1","entity_type":"asset","entity_typo":"vehicle"}`)

	handler.CreateEntity(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "INVALID_JSON" {
		t.Fatalf("expected INVALID_JSON, got %v", body["error_code"])
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

func TestCreateObjectRejectsTrailingJSON(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/objects", `{"object_id":"object-1"}{"extra":true}`)

	handler.CreateObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "INVALID_JSON" {
		t.Fatalf("expected INVALID_JSON, got %v", body["error_code"])
	}
}

func TestCreateObjectRejectsBucketInput(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := routeRequest(http.MethodPost, "/objects", `{"object_id":"object-1","bucket":"client-bucket"}`)

	handler.CreateObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	if !strings.Contains(body["message"].(string), "server-generated") {
		t.Fatalf("expected server-generated bucket message, got %v", body["message"])
	}
}

func TestUpdateObjectRejectsBucketInput(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := withURLParam(routeRequest(http.MethodPatch, "/objects/object-1", `{"bucket":"client-bucket"}`), "object_id", "object-1")

	handler.UpdateObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	if !strings.Contains(body["message"].(string), "server-generated") {
		t.Fatalf("expected server-generated bucket message, got %v", body["message"])
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

func TestNullablePatchStringDistinguishesAbsentNullAndValue(t *testing.T) {
	var req struct {
		Absent nullablePatchString `json:"absent,omitempty"`
		Clear  nullablePatchString `json:"clear,omitempty"`
		Set    nullablePatchString `json:"set,omitempty"`
	}
	if err := json.Unmarshal([]byte(`{"clear":null,"set":"alias"}`), &req); err != nil {
		t.Fatalf("decode nullable patch strings: %v", err)
	}
	if req.Absent.actionValue() != nil {
		t.Fatal("absent nullable patch string should not produce an action value")
	}
	clear := req.Clear.actionValue()
	if clear == nil || *clear != "" {
		t.Fatalf("null nullable patch string action value = %#v, want empty string pointer", clear)
	}
	set := req.Set.actionValue()
	if set == nil || *set != "alias" {
		t.Fatalf("set nullable patch string action value = %#v, want alias", set)
	}
}

func TestCreateTaskRequestDefaultsStatusToPending(t *testing.T) {
	params := createTaskRequest{TaskID: "task-1"}.actionParams()
	if params.Status != "pending" {
		t.Fatalf("default Status = %q, want pending", params.Status)
	}

	params = createTaskRequest{TaskID: "task-1", Status: "acknowledged"}.actionParams()
	if params.Status != "acknowledged" {
		t.Fatalf("explicit Status = %q, want acknowledged", params.Status)
	}
}

func TestEntityCheckinRequestComponentUpdate(t *testing.T) {
	status := "online"
	latitude := 38.5
	heading := 91.25
	now := time.Date(2026, 6, 26, 12, 30, 0, 0, time.FixedZone("EDT", -4*60*60))
	wantTime := now.UTC().Format(time.RFC3339)

	got := entityCheckinRequest{
		Status:     &status,
		Latitude:   &latitude,
		HeadingDeg: &heading,
		Components: map[string]interface{}{
			"custom": "preserved",
		},
	}.componentUpdate(now)

	if got["custom"] != "preserved" {
		t.Fatalf("custom component = %v, want preserved", got["custom"])
	}

	statusComponent, ok := got["status"].(map[string]interface{})
	if !ok {
		t.Fatalf("status component = %T, want map", got["status"])
	}
	if statusComponent["value"] != status || statusComponent["last_update"] != wantTime {
		t.Fatalf("status component = %#v, want value and last_update", statusComponent)
	}

	telemetry, ok := got["telemetry"].(map[string]interface{})
	if !ok {
		t.Fatalf("telemetry component = %T, want map", got["telemetry"])
	}
	if telemetry["latitude"] != latitude || telemetry["heading_deg"] != heading || telemetry["last_update"] != wantTime {
		t.Fatalf("telemetry component = %#v, want latitude, heading, and last_update", telemetry)
	}

	heartbeat, ok := got["heartbeat"].(map[string]interface{})
	if !ok {
		t.Fatalf("heartbeat component = %T, want map", got["heartbeat"])
	}
	if heartbeat["last_seen"] != wantTime {
		t.Fatalf("heartbeat last_seen = %v, want %s", heartbeat["last_seen"], wantTime)
	}
}

func TestParseListPaginationRejectsOffset(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/entities?limit=10&offset=0", nil)

	_, _, ok := handler.parseListPagination(rec, req)

	if ok {
		t.Fatal("expected offset pagination to be rejected")
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
}

func TestParseListPaginationReadsCursorAndSetsCursorHeaders(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/entities?limit=10&cursor=abc123", nil)

	limit, cursor, ok := handler.parseListPagination(rec, req)

	if !ok {
		t.Fatal("expected cursor pagination to parse")
	}
	if limit != 10 {
		t.Fatalf("expected limit 10, got %d", limit)
	}
	if cursor != "abc123" {
		t.Fatalf("expected cursor abc123, got %q", cursor)
	}

	setPaginationHeaders(rec, limit, 10, true, "next456")
	if rec.Header().Get("X-Limit") != "10" {
		t.Fatalf("expected X-Limit 10, got %q", rec.Header().Get("X-Limit"))
	}
	if rec.Header().Get("X-Returned-Count") != "10" {
		t.Fatalf("expected X-Returned-Count 10, got %q", rec.Header().Get("X-Returned-Count"))
	}
	if rec.Header().Get("X-Has-More") != "true" {
		t.Fatalf("expected X-Has-More true, got %q", rec.Header().Get("X-Has-More"))
	}
	if rec.Header().Get("X-Next-Cursor") != "next456" {
		t.Fatalf("expected X-Next-Cursor next456, got %q", rec.Header().Get("X-Next-Cursor"))
	}
	if rec.Header().Get("X-Total-Count") != "" || rec.Header().Get("X-Offset") != "" {
		t.Fatalf("old offset pagination headers should not be set: %#v", rec.Header())
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

func TestEntityCheckinRejectsOffset(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := withURLParam(routeRequest(http.MethodPost, "/entities/entity-1/checkin?offset=0", `{}`), "entity_id", "entity-1")

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
	if body["message"] != "since_version parameter is required" {
		t.Fatalf("unexpected message: %v", body["message"])
	}
}

func TestGetChangedSinceRejectsBlankParam(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/queries/changed-since?since_version=%20%20", nil)

	handler.GetChangedSince(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR, got %v", body["error_code"])
	}
	if body["message"] != "since_version parameter is required" {
		t.Fatalf("unexpected message: %v", body["message"])
	}
}

func TestGetChangedSinceRejectsInvalidVersion(t *testing.T) {
	handler := newTestHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/queries/changed-since?since_version=not-a-version", nil)

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

func TestChangedSinceDeletedTaskEntityIDJSONPresence(t *testing.T) {
	entityID := "asset-1"
	response := serializeChangedSinceResult(&actions.ChangedSinceResult{
		DeletedEntities: []actions.DeletedResource{
			{ID: "deleted-entity", Type: string(actions.ChangeResourceEntity), EntityID: &entityID, Version: 1},
		},
		DeletedTasks: []actions.DeletedResource{
			{ID: "task-with-parent", Type: string(actions.ChangeResourceTask), EntityID: &entityID, Version: 2},
			{ID: "task-without-parent", Type: string(actions.ChangeResourceTask), Version: 3},
		},
		DeletedObjects: []actions.DeletedResource{
			{ID: "deleted-object", Type: string(actions.ChangeResourceObject), EntityID: &entityID, Version: 4},
		},
		Version:   3,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})

	data, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal changed-since response: %v", err)
	}
	var decoded struct {
		DeletedEntities []map[string]any `json:"deleted_entities"`
		DeletedTasks    []map[string]any `json:"deleted_tasks"`
		DeletedObjects  []map[string]any `json:"deleted_objects"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("decode changed-since response: %v", err)
	}
	if _, exists := decoded.DeletedEntities[0]["entity_id"]; exists {
		t.Fatalf("deleted entity emitted entity_id: %s", data)
	}
	if got := decoded.DeletedTasks[0]["entity_id"]; got != entityID {
		t.Fatalf("deleted task entity_id = %v, want %s", got, entityID)
	}
	if _, exists := decoded.DeletedTasks[1]["entity_id"]; exists {
		t.Fatalf("deleted task without parent emitted entity_id: %s", data)
	}
	if _, exists := decoded.DeletedObjects[0]["entity_id"]; exists {
		t.Fatalf("deleted object emitted entity_id: %s", data)
	}
}

func TestQueryResponsesIncludeFalseHasMoreFlags(t *testing.T) {
	tests := []struct {
		name string
		resp interface{}
		keys []string
	}{
		{
			name: "full dataset",
			resp: &fullDatasetResponse{},
			keys: []string{"has_more_entities", "has_more_tasks", "has_more_objects"},
		},
		{
			name: "changed since",
			resp: &changedSinceResponse{Version: 1, Timestamp: "2026-03-20T12:00:00Z"},
			keys: []string{
				"has_more_entities",
				"has_more_tasks",
				"has_more_objects",
				"has_more_deleted_entities",
				"has_more_deleted_tasks",
				"has_more_deleted_objects",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := json.Marshal(tt.resp)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var body map[string]interface{}
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			for _, key := range tt.keys {
				got, ok := body[key]
				if !ok {
					t.Fatalf("expected %s to be present in %s", key, string(raw))
				}
				if got != false {
					t.Fatalf("expected %s=false, got %#v", key, got)
				}
			}
		})
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

func TestUploadObjectAllowsMultipartOverheadAtFileLimit(t *testing.T) {
	handler := newTestHandler()
	handler.storage = &storage.Client{}
	handler.config.MaxUploadSizeMB = 1
	rec := httptest.NewRecorder()
	req := multipartUploadRequest(t, map[string]string{}, 1024*1024)

	handler.UploadObject(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected request to parse and fail validation with 400, got %d", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["error_code"] != "VALIDATION_ERROR" {
		t.Fatalf("expected VALIDATION_ERROR after parsing multipart body, got %v", body["error_code"])
	}
}

func TestUploadObjectRejectsFileOverLimitWith413(t *testing.T) {
	handler := newTestHandler()
	handler.storage = &storage.Client{}
	handler.config.MaxUploadSizeMB = 1
	rec := httptest.NewRecorder()
	req := multipartUploadRequest(t, map[string]string{"object_id": "object-1"}, 1024*1024+1)

	handler.UploadObject(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", rec.Code)
	}
	body := decodeBody(t, rec)
	if body["error_code"] != "FILE_TOO_LARGE" {
		t.Fatalf("expected FILE_TOO_LARGE, got %v", body["error_code"])
	}
}

func TestIsViewableContentTypeSupportsParameterizedTypes(t *testing.T) {
	if !isViewableContentType("application/json; charset=utf-8") {
		t.Fatal("expected JSON with charset to be viewable")
	}
	if isViewableContentType("text/xml") {
		t.Fatal("expected text/xml to be non-viewable")
	}
	if isViewableContentType("application/xml; charset=utf-8") {
		t.Fatal("expected application/xml with charset to be non-viewable")
	}
	if isViewableContentType("image/png") {
		t.Fatal("expected image/png to be non-viewable")
	}
}

func TestGetExtensionForContentTypeUsesFallbacks(t *testing.T) {
	if got := getExtensionForContentType("application/x-laz"); got != ".laz" {
		t.Fatalf("expected .laz fallback, got %q", got)
	}
	if got := getExtensionForContentType("Application/X-LAZ; charset=utf-8"); got != ".laz" {
		t.Fatalf("expected parameterized .laz fallback, got %q", got)
	}
	if got := getExtensionForContentType("application/x-unknown-xyz"); got != "" {
		t.Fatalf("expected empty extension for unknown type, got %q", got)
	}
}

type testError string

func (e testError) Error() string {
	return string(e)
}
