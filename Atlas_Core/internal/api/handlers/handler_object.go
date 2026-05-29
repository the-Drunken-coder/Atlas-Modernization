package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

// --- Object Handlers ---

// ListObjects handles GET /objects.
func (h *Handler) ListObjects(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	objects, total, err := h.objectActions.List(r.Context(), limit, offset)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setPaginationHeaders(w, total, actions.ClampListLimit(limit), offset, len(objects))
	writeJSON(w, http.StatusOK, serializers.SerializeObjectsForList(objects))
}

// CreateObject handles POST /objects.
func (h *Handler) CreateObject(w http.ResponseWriter, r *http.Request) {
	// Limit request body to 1MB for object metadata operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req struct {
		ObjectID     string                   `json:"object_id"`
		Path         *string                  `json:"path,omitempty"`
		Bucket       *string                  `json:"bucket,omitempty"`
		SizeBytes    *int64                   `json:"size_bytes,omitempty"`
		ContentType  *string                  `json:"content_type,omitempty"`
		Type         *string                  `json:"type,omitempty"`
		UsageHints   []string                 `json:"usage_hints,omitempty"`
		ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
		Extra        map[string]interface{}   `json:"extra,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", "BODY_TOO_LARGE")
			return
		}
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", "INVALID_JSON")
		return
	}

	obj, err := h.objectActions.Create(r.Context(), actions.CreateObjectParams{
		ObjectID:     req.ObjectID,
		Path:         req.Path,
		Bucket:       req.Bucket,
		SizeBytes:    req.SizeBytes,
		ContentType:  req.ContentType,
		Type:         req.Type,
		UsageHints:   req.UsageHints,
		ReferencedBy: req.ReferencedBy,
		Extra:        req.Extra,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	w.Header().Set("ETag", serializers.ObjectWeakETag(obj.UpdatedAt))
	writeJSON(w, http.StatusCreated, serializers.SerializeObject(obj))
}

// GetObject handles GET /objects/{object_id}.
func (h *Handler) GetObject(w http.ResponseWriter, r *http.Request) {
	objectID := chi.URLParam(r, "object_id")

	obj, err := h.objectActions.Get(r.Context(), objectID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	w.Header().Set("ETag", serializers.ObjectWeakETag(obj.UpdatedAt))
	writeJSON(w, http.StatusOK, serializers.SerializeObject(obj))
}

// UpdateObject handles PATCH /objects/{object_id}.
func (h *Handler) UpdateObject(w http.ResponseWriter, r *http.Request) {
	objectID := chi.URLParam(r, "object_id")

	// Limit request body to 1MB for object metadata operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req struct {
		Path         *string                  `json:"path,omitempty"`
		ContentType  *string                  `json:"content_type,omitempty"`
		Type         *string                  `json:"type,omitempty"`
		SizeBytes    *int64                   `json:"size_bytes,omitempty"`
		UsageHints   []string                 `json:"usage_hints,omitempty"`
		ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
		Extra        map[string]interface{}   `json:"extra,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", "BODY_TOO_LARGE")
			return
		}
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", "INVALID_JSON")
		return
	}

	var ifMatchPtr *string
	if v := strings.TrimSpace(r.Header.Get("If-Match")); v != "" {
		ifMatchPtr = &v
	}

	obj, err := h.objectActions.Update(r.Context(), objectID, actions.UpdateObjectParams{
		Path:         req.Path,
		ContentType:  req.ContentType,
		Type:         req.Type,
		SizeBytes:    req.SizeBytes,
		UsageHints:   req.UsageHints,
		ReferencedBy: req.ReferencedBy,
		Extra:        req.Extra,
		IfMatch:      ifMatchPtr,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	w.Header().Set("ETag", serializers.ObjectWeakETag(obj.UpdatedAt))
	writeJSON(w, http.StatusOK, serializers.SerializeObject(obj))
}

// DeleteObject handles DELETE /objects/{object_id}.
func (h *Handler) DeleteObject(w http.ResponseWriter, r *http.Request) {
	objectID := chi.URLParam(r, "object_id")

	if err := h.objectActions.Delete(r.Context(), objectID); err != nil {
		h.handleActionError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetObjectsByEntity handles GET /entities/{entity_id}/objects.
func (h *Handler) GetObjectsByEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")
	limit, offset, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	objects, total, err := h.objectActions.GetByEntity(r.Context(), entityID, limit, offset)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setPaginationHeaders(w, total, actions.ClampListLimit(limit), offset, len(objects))
	writeJSON(w, http.StatusOK, serializers.SerializeObjectsForList(objects))
}

// GetObjectsByTask handles GET /tasks/{task_id}/objects.
func (h *Handler) GetObjectsByTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	limit, offset, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	objects, total, err := h.objectActions.GetByTask(r.Context(), taskID, limit, offset)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setPaginationHeaders(w, total, actions.ClampListLimit(limit), offset, len(objects))
	writeJSON(w, http.StatusOK, serializers.SerializeObjectsForList(objects))
}
