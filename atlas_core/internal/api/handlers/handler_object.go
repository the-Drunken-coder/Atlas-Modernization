package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
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
	writeJSON(w, r, http.StatusOK, objects)
}

// CreateObject handles POST /objects.
func (h *Handler) CreateObject(w http.ResponseWriter, r *http.Request) {
	// Limit request body to 1MB for object metadata operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req createObjectRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateObjectCreateRequest) {
		return
	}
	obj, err := h.objectActions.Create(r.Context(), req.actionParams())
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, obj.Version)
	writeJSON(w, r, http.StatusCreated, serializers.SerializeObject(obj))
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
	writeJSON(w, r, http.StatusOK, serializers.SerializeObject(obj))
}

// UpdateObject handles PATCH /objects/{object_id}.
func (h *Handler) UpdateObject(w http.ResponseWriter, r *http.Request) {
	objectID := chi.URLParam(r, "object_id")

	// Limit request body to 1MB for object metadata operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req updateObjectRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateObjectUpdateRequest) {
		return
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "object")
	if !ok {
		return
	}

	obj, err := h.objectActions.Update(r.Context(), objectID, req.actionParams(expectedVersion))
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, obj.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeObject(obj))
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
	writeJSON(w, r, http.StatusOK, objects)
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
	writeJSON(w, r, http.StatusOK, objects)
}
