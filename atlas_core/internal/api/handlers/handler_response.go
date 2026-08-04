package handlers

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/rs/zerolog"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// ErrorResponse represents an API error response.
type ErrorResponse = protocol.ErrorResponse

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
func writeJSON(w http.ResponseWriter, r *http.Request, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		zerolog.Ctx(r.Context()).Error().Err(err).Int("status", status).Msg("writeJSON: failed to encode response")
	}
}

func (h *Handler) requestLogger(r *http.Request) *zerolog.Logger {
	if logger := zerolog.Ctx(r.Context()); logger.GetLevel() != zerolog.Disabled {
		return logger
	}
	return &h.logger
}

// writeError writes an error response.
func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, status int, message string, errorCode protocol.ErrorCode) {
	h.writeErrorWithCause(w, r, status, message, errorCode, nil)
}

// writeErrorWithCause writes an error response and logs an optional wrapped cause (for 5xx diagnostics).
func (h *Handler) writeErrorWithCause(w http.ResponseWriter, r *http.Request, status int, message string, errorCode protocol.ErrorCode, cause error) {
	errorID := generateErrorID()
	resp := ErrorResponse{
		Success:   false,
		Message:   message,
		ErrorCode: errorCode,
		ErrorID:   errorID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Path:      r.URL.Path,
	}

	logger := h.requestLogger(r)
	event := logger.Warn()
	if status >= http.StatusInternalServerError {
		event = logger.Error()
	}
	event = event.
		Str("error_id", errorID).
		Str("error_code", string(errorCode)).
		Str("path", r.URL.Path).
		Str("method", r.Method).
		Int("status", status)
	if cause != nil && status >= http.StatusInternalServerError {
		event = event.Err(cause)
	}
	event.Msg(message)

	writeJSON(w, r, status, resp)
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

	h.requestLogger(r).Warn().
		Str("error_id", errorID).
		Str("error_code", string(validationErr.Code)).
		Str("path", r.URL.Path).
		Str("method", r.Method).
		Int("status", http.StatusBadRequest).
		Interface("details", validationErr.Details).
		Msg(validationErr.Message)

	writeJSON(w, r, http.StatusBadRequest, resp)
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
		h.writeErrorWithCause(w, r, http.StatusServiceUnavailable, storageErr.Message, protocol.ErrorCodeStorageError, err)
		return
	}

	var objNotFoundErr *storage.ObjectNotFoundError
	if errors.As(err, &objNotFoundErr) {
		h.writeErrorWithCause(w, r, http.StatusNotFound, "Object not found", protocol.ErrorCodeObjectNotFound, err)
		return
	}

	var bucketNotFoundErr *storage.BucketNotFoundError
	if errors.As(err, &bucketNotFoundErr) {
		h.writeErrorWithCause(w, r, http.StatusNotFound, "Storage bucket not found", protocol.ErrorCodeBucketNotFound, err)
		return
	}

	h.writeErrorWithCause(w, r, http.StatusInternalServerError, "Internal server error", protocol.ErrorCodeInternalServerError, err)
}

// setPaginationHeaders sets cursor pagination headers on the response.
func setPaginationHeaders(w http.ResponseWriter, limit, count int, hasMore bool, nextCursor string) {
	w.Header().Set("X-Limit", strconv.Itoa(limit))
	w.Header().Set("X-Returned-Count", strconv.Itoa(count))
	w.Header().Set("X-Has-More", strconv.FormatBool(hasMore))
	if nextCursor != "" {
		w.Header().Set("X-Next-Cursor", nextCursor)
	}
}

func setResourceETag(w http.ResponseWriter, version int64) {
	if version < 1 {
		return
	}
	w.Header().Set("ETag", serializers.StrongETag(version))
}

// decodeJSONRequestBody decodes one JSON value and rejects trailing data.
// When allowEmpty is true, an empty body is accepted.
func (h *Handler) decodeJSONRequestBody(w http.ResponseWriter, r *http.Request, v any, allowEmpty bool) bool {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	err := jsondecode.Decode(decoder, v)
	if err == nil {
		return true
	}
	if allowEmpty && errors.Is(err, io.EOF) {
		return true
	}
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", protocol.ErrorCodeBodyTooLarge)
		return false
	}
	h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", protocol.ErrorCodeInvalidJSON)
	return false
}

type protocolRequestValidator func(any) []string

// decodeProtocolRequestBody validates the exact JSON value against the
// canonical Atlas Protocol contract before decoding it into Core's named
// request type. Keeping the raw value preserves explicit null and empty-patch
// semantics that ordinary Go struct decoding would otherwise collapse.
func (h *Handler) decodeProtocolRequestBody(
	w http.ResponseWriter,
	r *http.Request,
	v any,
	validate protocolRequestValidator,
) bool {
	var raw json.RawMessage
	if err := jsondecode.Decode(json.NewDecoder(r.Body), &raw); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", protocol.ErrorCodeBodyTooLarge)
			return false
		}
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", protocol.ErrorCodeInvalidJSON)
		return false
	}
	if validationErrors := validate(raw); len(validationErrors) > 0 {
		h.writeValidationError(
			w,
			r,
			actions.NewValidationErrorWithDetails("Request body does not conform to Atlas Protocol", validationErrors),
		)
		return false
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := jsondecode.Decode(decoder, v); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", protocol.ErrorCodeInvalidJSON)
		return false
	}
	return true
}
