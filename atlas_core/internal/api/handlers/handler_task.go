package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// ListTasks handles GET /tasks.
func (h *Handler) ListTasks(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	page, err := h.taskActions.List(r.Context(), limit, cursor)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	tasks := serializers.SerializeTasks(page.Items)
	setPaginationHeaders(w, page.Limit, len(tasks), page.HasMore, page.NextCursor)
	writeJSON(w, r, http.StatusOK, tasks)
}

// CreateTask handles POST /tasks.
func (h *Handler) CreateTask(w http.ResponseWriter, r *http.Request) {
	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req createTaskRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskCreateRequest) {
		return
	}

	task, err := h.taskActions.Create(r.Context(), req.actionParams())
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusCreated, serializers.SerializeTask(task))
}

// GetTask handles GET /tasks/{task_id}.
func (h *Handler) GetTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	task, err := h.taskActions.Get(r.Context(), taskID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

// UpdateTask handles PATCH /tasks/{task_id}.
func (h *Handler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req updateTaskRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskUpdateRequest) {
		return
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "task")
	if !ok {
		return
	}

	task, err := h.taskActions.Update(r.Context(), taskID, req.actionParams(expectedVersion))
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

// DeleteTask handles DELETE /tasks/{task_id}.
func (h *Handler) DeleteTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	if err := h.taskActions.Delete(r.Context(), taskID); err != nil {
		h.handleActionError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetTasksByEntity handles GET /entities/{entity_id}/tasks.
func (h *Handler) GetTasksByEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")
	limit, cursor, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	page, err := h.taskActions.GetByEntity(r.Context(), entityID, limit, cursor)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	tasks := serializers.SerializeTasks(page.Items)
	setPaginationHeaders(w, page.Limit, len(tasks), page.HasMore, page.NextCursor)
	writeJSON(w, r, http.StatusOK, tasks)
}
