package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	custommiddleware "github.com/the-drunken-coder/atlas/atlas_core/internal/api/middleware"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

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
			name:       "expired cursor",
			err:        actions.NewCursorExpiredError(42),
			wantStatus: http.StatusGone,
			wantCode:   "CURSOR_EXPIRED",
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

func TestHandlerErrorLogsUseRequestIDAndStatusSeverity(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		wantLevel string
		wantCause bool
	}{
		{name: "client error", status: http.StatusBadRequest, wantLevel: "warn"},
		{name: "server error", status: http.StatusServiceUnavailable, wantLevel: "error", wantCause: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var logBuf bytes.Buffer
			handler := newTestHandler()
			handler.logger = zerolog.New(&logBuf)
			wrapped := chimiddleware.RequestID(custommiddleware.RequestLogger(handler.logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				handler.writeErrorWithCause(w, r, tt.status, "logged error", protocol.ErrorCodeInternalServerError, testError("cause"))
			})))
			req := httptest.NewRequest(http.MethodGet, "/test", nil)
			req.Header.Set(chimiddleware.RequestIDHeader, "request-123")
			rec := httptest.NewRecorder()

			wrapped.ServeHTTP(rec, req)

			event := findLogEvent(t, logBuf.String(), "logged error")
			if event["level"] != tt.wantLevel {
				t.Fatalf("expected %s level, got %v", tt.wantLevel, event["level"])
			}
			if event["request_id"] != "request-123" {
				t.Fatalf("expected request ID, got %v", event["request_id"])
			}
			_, hasCause := event["error"]
			if hasCause != tt.wantCause {
				t.Fatalf("cause logged = %v, want %v", hasCause, tt.wantCause)
			}
		})
	}
}

func TestValidationErrorLogUsesRequestIDAndWarningSeverity(t *testing.T) {
	var logBuf bytes.Buffer
	handler := newTestHandler()
	handler.logger = zerolog.New(&logBuf)
	wrapped := chimiddleware.RequestID(custommiddleware.RequestLogger(handler.logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.writeValidationError(w, r, actions.NewValidationError("bad field"))
	})))
	req := httptest.NewRequest(http.MethodPost, "/entities", nil)
	req.Header.Set(chimiddleware.RequestIDHeader, "validation-123")
	rec := httptest.NewRecorder()

	wrapped.ServeHTTP(rec, req)

	event := findLogEvent(t, logBuf.String(), "bad field")
	if event["level"] != "warn" {
		t.Fatalf("expected warning level, got %v", event["level"])
	}
	if event["request_id"] != "validation-123" {
		t.Fatalf("expected request ID, got %v", event["request_id"])
	}
}

func TestWriteJSONEncodingErrorUsesRequestID(t *testing.T) {
	var logBuf bytes.Buffer
	logger := zerolog.New(&logBuf)
	wrapped := chimiddleware.RequestID(custommiddleware.RequestLogger(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, r, http.StatusOK, make(chan int))
	})))
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set(chimiddleware.RequestIDHeader, "encoding-123")
	rec := httptest.NewRecorder()

	wrapped.ServeHTTP(rec, req)

	event := findLogEvent(t, logBuf.String(), "writeJSON: failed to encode response")
	if event["level"] != "error" {
		t.Fatalf("expected error level, got %v", event["level"])
	}
	if event["request_id"] != "encoding-123" {
		t.Fatalf("expected request ID, got %v", event["request_id"])
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
	tasks := []protocol.TaskResource{
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
	if got[0].CommandID != "move-to" {
		t.Fatalf("expected promoted command_id, got %v", got[0].CommandID)
	}

	params := got[0].Parameters
	if params["speed"] != "fast" {
		t.Fatalf("expected promoted parameters, got %v", params)
	}
}

func TestEntityCheckInResponseVariantsConformToProtocol(t *testing.T) {
	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	entityID := "entity-1"
	entity := serializers.SerializeEntity(&models.Entity{
		EntityID:  entityID,
		Type:      "asset",
		CreatedAt: now,
		UpdatedAt: now,
		Version:   1,
	})
	tasks := serializers.SerializeTasks([]*models.Task{{
		TaskID:    "task-1",
		Status:    "pending",
		EntityID:  &entityID,
		JSON:      []byte(`{"components":{"command":{"id":"move","type":"move"}}}`),
		CreatedAt: now,
		UpdatedAt: now,
		Version:   2,
	}})

	tests := []struct {
		name     string
		response any
		validate func(any) []string
	}{
		{
			name: "full",
			response: protocol.EntityCheckInFullResponse{
				Entity: *entity, Tasks: tasks, TaskCount: 1, TaskLimit: 10,
			},
			validate: protocol.ValidateEntityCheckInFullResponse,
		},
		{
			name: "minimal",
			response: protocol.EntityCheckInMinimalResponse{
				Entity: *entity, Tasks: serializeCheckinTasksMinimal(tasks), TaskCount: 1, TaskLimit: 10,
			},
			validate: protocol.ValidateEntityCheckInMinimalResponse,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(test.response)
			if err != nil {
				t.Fatal(err)
			}
			if validationErrors := test.validate(json.RawMessage(encoded)); len(validationErrors) > 0 {
				t.Fatalf("response failed Atlas Protocol validation: %v\n%s", validationErrors, encoded)
			}
		})
	}
}
