package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

// ErrorResponse represents an API error response.
type ErrorResponse struct {
	Success   bool                   `json:"success"`
	Message   string                 `json:"message"`
	ErrorCode string                 `json:"error_code"`
	ErrorID   string                 `json:"error_id"`
	Timestamp string                 `json:"timestamp"`
	Path      string                 `json:"path,omitempty"`
	Details   map[string]interface{} `json:"details,omitempty"`
}

// generateErrorID generates a unique error ID.
func generateErrorID() string {
	bytes := make([]byte, 6)
	if _, err := rand.Read(bytes); err != nil {
		// Fallback to timestamp-based ID if crypto/rand fails
		return fmt.Sprintf("err_%d", time.Now().UnixNano())
	}
	return "err_" + hex.EncodeToString(bytes)
}

// writeJSON writes a JSON response. If encoding fails after the status header
// has been sent, the error is logged because the HTTP status code can no longer
// be changed.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Error().Err(err).Int("status", status).Msg("writeJSON: failed to encode response")
	}
}

// writeError writes an error response.
func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, status int, message, errorCode string) {
	h.writeErrorWithCause(w, r, status, message, errorCode, nil)
}

// writeErrorWithCause writes an error response and logs an optional wrapped cause (for 5xx diagnostics).
func (h *Handler) writeErrorWithCause(w http.ResponseWriter, r *http.Request, status int, message, errorCode string, cause error) {
	errorID := generateErrorID()
	resp := ErrorResponse{
		Success:   false,
		Message:   message,
		ErrorCode: errorCode,
		ErrorID:   errorID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Path:      r.URL.Path,
	}

	event := h.logger.Error().
		Str("error_id", errorID).
		Str("error_code", errorCode).
		Str("path", r.URL.Path).
		Str("method", r.Method).
		Int("status", status)
	if cause != nil && status >= http.StatusInternalServerError {
		event = event.Err(cause)
	}
	event.Msg(message)

	writeJSON(w, status, resp)
}

// writeValidationError writes a validation error response with details.
func (h *Handler) writeValidationError(w http.ResponseWriter, r *http.Request, validationErr *actions.ValidationError) {
	errorID := generateErrorID()
	resp := ErrorResponse{
		Success:   false,
		Message:   validationErr.Message,
		ErrorCode: validationErr.Code,
		ErrorID:   errorID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Path:      r.URL.Path,
	}

	// Add details if there are multiple validation errors
	if len(validationErr.Details) > 0 {
		resp.Details = map[string]interface{}{
			"errors": validationErr.Details,
		}
	}

	// Log the error
	h.logger.Error().
		Str("error_id", errorID).
		Str("error_code", validationErr.Code).
		Str("path", r.URL.Path).
		Str("method", r.Method).
		Int("status", http.StatusBadRequest).
		Interface("details", validationErr.Details).
		Msg(validationErr.Message)

	writeJSON(w, http.StatusBadRequest, resp)
}

// handleActionError handles errors from action functions.
func (h *Handler) handleActionError(w http.ResponseWriter, r *http.Request, err error) {
	var validationErr *actions.ValidationError
	if errors.As(err, &validationErr) {
		h.writeValidationError(w, r, validationErr)
		return
	}

	var notFoundErr *actions.NotFoundError
	if errors.As(err, &notFoundErr) {
		h.writeErrorWithCause(w, r, http.StatusNotFound, notFoundErr.Message, notFoundErr.Code, err)
		return
	}

	var conflictErr *actions.ConflictError
	if errors.As(err, &conflictErr) {
		h.writeErrorWithCause(w, r, http.StatusConflict, conflictErr.Message, conflictErr.Code, err)
		return
	}

	var preconditionErr *actions.PreconditionFailedError
	if errors.As(err, &preconditionErr) {
		h.writeErrorWithCause(w, r, http.StatusPreconditionFailed, preconditionErr.Message, preconditionErr.Code, err)
		return
	}

	var actionErr *actions.ActionError
	if errors.As(err, &actionErr) {
		h.writeErrorWithCause(w, r, http.StatusInternalServerError, actionErr.Message, actionErr.Code, err)
		return
	}

	var storageErr *storage.StorageError
	if errors.As(err, &storageErr) {
		h.writeErrorWithCause(w, r, http.StatusServiceUnavailable, storageErr.Message, "STORAGE_ERROR", err)
		return
	}

	var objNotFoundErr *storage.ObjectNotFoundError
	if errors.As(err, &objNotFoundErr) {
		h.writeErrorWithCause(w, r, http.StatusNotFound, "Object not found", "OBJECT_NOT_FOUND", err)
		return
	}

	var bucketNotFoundErr *storage.BucketNotFoundError
	if errors.As(err, &bucketNotFoundErr) {
		h.writeErrorWithCause(w, r, http.StatusNotFound, "Storage bucket not found", "BUCKET_NOT_FOUND", err)
		return
	}

	h.writeErrorWithCause(w, r, http.StatusInternalServerError, "Internal server error", "INTERNAL_SERVER_ERROR", err)
}

// setPaginationHeaders sets pagination headers on the response.
func setPaginationHeaders(w http.ResponseWriter, total, limit, offset, count int) {
	w.Header().Set("X-Total-Count", strconv.Itoa(total))
	w.Header().Set("X-Limit", strconv.Itoa(limit))
	w.Header().Set("X-Offset", strconv.Itoa(offset))
	w.Header().Set("X-Returned-Count", strconv.Itoa(count))
}

// parseNonNegativeIntQuery parses a query parameter as a non-negative integer; empty uses defaultVal.
func parseNonNegativeIntQuery(r *http.Request, key string, defaultVal int) (int, error) {
	s := strings.TrimSpace(r.URL.Query().Get(key))
	if s == "" {
		return defaultVal, nil
	}
	i, err := strconv.Atoi(s)
	if err != nil || i < 0 {
		return 0, fmt.Errorf("invalid %s", key)
	}
	return i, nil
}

func parseStatusFilter(filter string) []string {
	rawStatuses := strings.Split(filter, ",")
	result := make([]string, 0, len(rawStatuses))
	seen := make(map[string]struct{}, len(rawStatuses))
	for _, raw := range rawStatuses {
		normalized := strings.ToLower(strings.TrimSpace(raw))
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func parseRFC3339Timestamp(raw string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339Nano, raw)
}

func serializeCheckinTasksMinimal(tasks []*serializers.TaskResponse) []map[string]interface{} {
	minimal := make([]map[string]interface{}, 0, len(tasks))
	for _, task := range tasks {
		entry := map[string]interface{}{
			"task_id": task.TaskID,
			"status":  task.Status,
		}
		if task.EntityID != nil {
			entry["entity_id"] = *task.EntityID
		}

		commandID, parameters := extractCheckinTaskFields(task.Components)
		if commandID != "" {
			entry["command_id"] = commandID
		}
		if parameters != nil {
			entry["parameters"] = parameters
		}

		minimal = append(minimal, entry)
	}
	return minimal
}

func extractCheckinTaskFields(components map[string]interface{}) (string, map[string]interface{}) {
	if components == nil {
		return "", nil
	}

	commandID := ""
	var parameters map[string]interface{}

	if v, ok := components["command_id"].(string); ok && strings.TrimSpace(v) != "" {
		commandID = strings.TrimSpace(v)
	}

	if commandID == "" {
		if v, ok := components["command"].(string); ok && strings.TrimSpace(v) != "" {
			commandID = strings.TrimSpace(v)
		}
	}

	if p, ok := components["parameters"].(map[string]interface{}); ok {
		parameters = p
	} else if target, ok := components["target"].(map[string]interface{}); ok {
		parameters = target
	}

	if command, ok := components["command"].(map[string]interface{}); ok {
		if commandID == "" {
			if id, ok := command["id"].(string); ok && strings.TrimSpace(id) != "" {
				commandID = strings.TrimSpace(id)
			} else if commandType, ok := command["type"].(string); ok && strings.TrimSpace(commandType) != "" {
				commandID = strings.TrimSpace(commandType)
			}
		}

		if parameters == nil {
			if p, ok := command["parameters"].(map[string]interface{}); ok {
				parameters = p
			} else if target, ok := command["target"].(map[string]interface{}); ok {
				parameters = target
			}
		}
	}

	return commandID, parameters
}

// decodeJSONRequestBody decodes one JSON value and rejects trailing data.
// When allowEmpty is true, an empty body is accepted.
func (h *Handler) decodeJSONRequestBody(w http.ResponseWriter, r *http.Request, v any, allowEmpty bool) bool {
	err := jsondecode.Decode(json.NewDecoder(r.Body), v)
	if err == nil {
		return true
	}
	if allowEmpty && errors.Is(err, io.EOF) {
		return true
	}
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", "BODY_TOO_LARGE")
		return false
	}
	h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", "INVALID_JSON")
	return false
}

func optionalQueryString(q url.Values, key string) *string {
	v := strings.TrimSpace(q.Get(key))
	if v == "" {
		return nil
	}
	return &v
}

// parseListPagination reads limit and offset query params; writes a 400 response and returns ok=false on error.
// The returned limit is already clamped to the standard list bounds (see actions.ClampListLimit),
// so callers can use it directly for both the query and pagination headers.
func (h *Handler) parseListPagination(w http.ResponseWriter, r *http.Request) (limit, offset int, ok bool) {
	limit, err := parseNonNegativeIntQuery(r, "limit", 100)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid limit parameter", "VALIDATION_ERROR")
		return 0, 0, false
	}
	offset, err = parseNonNegativeIntQuery(r, "offset", 0)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid offset parameter", "VALIDATION_ERROR")
		return 0, 0, false
	}
	return actions.ClampListLimit(limit), offset, true
}

func parseFullDatasetLimits(r *http.Request) (*actions.FullDatasetLimits, string, error) {
	el, err := parseNonNegativeIntQuery(r, "entity_limit", 0)
	if err != nil {
		return nil, "entity_limit", err
	}
	tl, err := parseNonNegativeIntQuery(r, "task_limit", 0)
	if err != nil {
		return nil, "task_limit", err
	}
	ol, err := parseNonNegativeIntQuery(r, "object_limit", 0)
	if err != nil {
		return nil, "object_limit", err
	}
	q := r.URL.Query()
	return &actions.FullDatasetLimits{
		EntityLimit:  el,
		TaskLimit:    tl,
		ObjectLimit:  ol,
		EntityCursor: optionalQueryString(q, "entity_cursor"),
		TaskCursor:   optionalQueryString(q, "task_cursor"),
		ObjectCursor: optionalQueryString(q, "object_cursor"),
	}, "", nil
}

func changedSinceCursorsFromQuery(q url.Values) actions.ChangedSinceCursors {
	return actions.ChangedSinceCursors{
		EntityCursor:        optionalQueryString(q, "entity_cursor"),
		TaskCursor:          optionalQueryString(q, "task_cursor"),
		ObjectCursor:        optionalQueryString(q, "object_cursor"),
		DeletedEntityCursor: optionalQueryString(q, "deleted_entity_cursor"),
		DeletedTaskCursor:   optionalQueryString(q, "deleted_task_cursor"),
		DeletedObjectCursor: optionalQueryString(q, "deleted_object_cursor"),
	}
}
