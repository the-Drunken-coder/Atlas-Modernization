package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
)

// ListTasks handles GET /tasks.
func (h *Handler) ListTasks(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	tasks, total, err := h.taskActions.List(r.Context(), limit, offset)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setPaginationHeaders(w, total, actions.ClampListLimit(limit), offset, len(tasks))
	writeJSON(w, http.StatusOK, tasks)
}

// CreateTask handles POST /tasks.
func (h *Handler) CreateTask(w http.ResponseWriter, r *http.Request) {
	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req struct {
		TaskID     string                 `json:"task_id"`
		Status     string                 `json:"status,omitempty"`
		EntityID   *string                `json:"entity_id,omitempty"`
		Components map[string]interface{} `json:"components,omitempty"`
		Extra      map[string]interface{} `json:"extra,omitempty"`
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

	if req.Status == "" {
		req.Status = "pending"
	}

	task, err := h.taskActions.Create(r.Context(), actions.CreateTaskParams{
		TaskID:     req.TaskID,
		Status:     req.Status,
		EntityID:   req.EntityID,
		Components: req.Components,
		Extra:      req.Extra,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, task)
}

// GetTask handles GET /tasks/{task_id}.
func (h *Handler) GetTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	task, err := h.taskActions.Get(r.Context(), taskID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, task)
}

// UpdateTask handles PATCH /tasks/{task_id}.
func (h *Handler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req struct {
		Status     *string                `json:"status,omitempty"`
		EntityID   *string                `json:"entity_id,omitempty"`
		Components map[string]interface{} `json:"components,omitempty"`
		Extra      map[string]interface{} `json:"extra,omitempty"`
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

	task, err := h.taskActions.Update(r.Context(), taskID, actions.UpdateTaskParams{
		Status:     req.Status,
		EntityID:   req.EntityID,
		Components: req.Components,
		Extra:      req.Extra,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, task)
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
	limit, offset, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	tasks, total, err := h.taskActions.GetByEntity(r.Context(), entityID, limit, offset)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setPaginationHeaders(w, total, actions.ClampListLimit(limit), offset, len(tasks))
	writeJSON(w, http.StatusOK, tasks)
}

// AcknowledgeTask handles POST /tasks/{task_id}/acknowledge.
func (h *Handler) AcknowledgeTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	task, err := h.taskActions.Acknowledge(r.Context(), taskID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, task)
}

// CompleteTask handles POST /tasks/{task_id}/complete.
func (h *Handler) CompleteTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req struct {
		Result map[string]interface{} `json:"result,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", "BODY_TOO_LARGE")
			return
		}
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", "INVALID_JSON")
		return
	}

	task, err := h.taskActions.Complete(r.Context(), taskID, req.Result)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, task)
}

// FailTask handles POST /tasks/{task_id}/fail.
func (h *Handler) FailTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req struct {
		Error map[string]interface{} `json:"error,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", "BODY_TOO_LARGE")
			return
		}
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", "INVALID_JSON")
		return
	}

	task, err := h.taskActions.Fail(r.Context(), taskID, req.Error)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, task)
}

// TaskStatus handles POST /tasks/{task_id}/status.
func (h *Handler) TaskStatus(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")

	// Limit request body to 512KB for task operations
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	var req struct {
		Status   string   `json:"status"`
		Progress *float64 `json:"progress,omitempty"`
		Message  *string  `json:"message,omitempty"`
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

	if req.Status == "" {
		h.writeError(w, r, http.StatusBadRequest, "status is required", "VALIDATION_ERROR")
		return
	}

	task, err := h.taskActions.TransitionStatus(r.Context(), taskID, req.Status, req.Progress, req.Message)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, task)
}
