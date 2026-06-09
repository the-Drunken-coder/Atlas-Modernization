package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/objectactions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

// --- Object Handlers ---

// ListObjects handles GET /objects.
func (h *Handler) ListObjects(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	page, err := h.objectActions.List(r.Context(), limit, cursor)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	objects := serializers.SerializeObjectsForList(page.Items)
	setPaginationHeaders(w, page.Limit, len(objects), page.HasMore, page.NextCursor)
	writeJSON(w, http.StatusOK, objects)
}

// CreateObject handles POST /objects.
func (h *Handler) CreateObject(w http.ResponseWriter, r *http.Request) {
	// Limit request body to 1MB for object metadata operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req struct {
		ObjectID     string                   `json:"object_id"`
		Path         *string                  `json:"path,omitempty"`
		Bucket       json.RawMessage          `json:"bucket,omitempty"`
		SizeBytes    *int64                   `json:"size_bytes,omitempty"`
		ContentType  *string                  `json:"content_type,omitempty"`
		Type         *string                  `json:"type,omitempty"`
		UsageHints   []string                 `json:"usage_hints,omitempty"`
		ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
		Extra        map[string]interface{}   `json:"extra,omitempty"`
	}

	if !h.decodeJSONRequestBody(w, r, &req, false) {
		return
	}
	if len(req.Bucket) > 0 {
		h.writeError(w, r, http.StatusBadRequest, "Object bucket is server-generated and cannot be set", "VALIDATION_ERROR")
		return
	}

	obj, err := h.objectActions.Create(r.Context(), objectactions.CreateParams{
		ObjectID:     req.ObjectID,
		Path:         req.Path,
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

	setResourceETag(w, obj.Version)
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

	setResourceETag(w, obj.Version)
	writeJSON(w, http.StatusOK, serializers.SerializeObject(obj))
}

// UpdateObject handles PATCH /objects/{object_id}.
func (h *Handler) UpdateObject(w http.ResponseWriter, r *http.Request) {
	objectID := chi.URLParam(r, "object_id")

	// Limit request body to 1MB for object metadata operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req struct {
		Path         *string                  `json:"path,omitempty"`
		Bucket       json.RawMessage          `json:"bucket,omitempty"`
		ContentType  *string                  `json:"content_type,omitempty"`
		Type         *string                  `json:"type,omitempty"`
		SizeBytes    *int64                   `json:"size_bytes,omitempty"`
		UsageHints   []string                 `json:"usage_hints,omitempty"`
		ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
		Extra        map[string]interface{}   `json:"extra,omitempty"`
	}

	if !h.decodeJSONRequestBody(w, r, &req, false) {
		return
	}
	if len(req.Bucket) > 0 {
		h.writeError(w, r, http.StatusBadRequest, "Object bucket is server-generated and cannot be set", "VALIDATION_ERROR")
		return
	}

	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "object")
	if !ok {
		return
	}

	obj, err := h.objectActions.Update(r.Context(), objectID, objectactions.UpdateParams{
		Path:            req.Path,
		ContentType:     req.ContentType,
		Type:            req.Type,
		SizeBytes:       req.SizeBytes,
		UsageHints:      req.UsageHints,
		ReferencedBy:    req.ReferencedBy,
		Extra:           req.Extra,
		ExpectedVersion: expectedVersion,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, obj.Version)
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
	limit, cursor, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	page, err := h.objectActions.GetByEntity(r.Context(), entityID, limit, cursor)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	objects := serializers.SerializeObjectsForList(page.Items)
	setPaginationHeaders(w, page.Limit, len(objects), page.HasMore, page.NextCursor)
	writeJSON(w, http.StatusOK, objects)
}

// GetObjectsByTask handles GET /tasks/{task_id}/objects.
func (h *Handler) GetObjectsByTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	limit, cursor, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	page, err := h.objectActions.GetByTask(r.Context(), taskID, limit, cursor)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	objects := serializers.SerializeObjectsForList(page.Items)
	setPaginationHeaders(w, page.Limit, len(objects), page.HasMore, page.NextCursor)
	writeJSON(w, http.StatusOK, objects)
}
