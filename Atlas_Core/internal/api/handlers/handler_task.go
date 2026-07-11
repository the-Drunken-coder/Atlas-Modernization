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
	if !h.decodeJSONRequestBody(w, r, &req, false) {
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
	if !h.decodeJSONRequestBody(w, r, &req, false) {
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

// AcknowledgeTask handles POST /tasks/{task_id}/acknowledge.
func (h *Handler) AcknowledgeTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "task")
	if !ok {
		return
	}

	task, err := h.taskActions.Acknowledge(r.Context(), taskID, expectedVersion)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

// CompleteTask handles POST /tasks/{task_id}/complete.
func (h *Handler) CompleteTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req completeTaskRequest
	if !h.decodeJSONRequestBody(w, r, &req, true) {
		return
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "task")
	if !ok {
		return
	}

	task, err := h.taskActions.Complete(r.Context(), taskID, req.Result, expectedVersion)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

// FailTask handles POST /tasks/{task_id}/fail.
func (h *Handler) FailTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req failTaskRequest
	if !h.decodeJSONRequestBody(w, r, &req, true) {
		return
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "task")
	if !ok {
		return
	}

	task, err := h.taskActions.Fail(r.Context(), taskID, req.Error, expectedVersion)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

// TaskStatus handles POST /tasks/{task_id}/status.
func (h *Handler) TaskStatus(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req taskStatusRequest
	if !h.decodeJSONRequestBody(w, r, &req, false) {
		return
	}

	if req.Status == "" {
		h.writeError(w, r, http.StatusBadRequest, "status is required", protocol.ErrorCodeValidationError)
		return
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "task")
	if !ok {
		return
	}

	task, err := h.taskActions.TransitionStatus(r.Context(), taskID, req.Status, req.Progress, req.Message, expectedVersion)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}
