package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

const maxTaskingRequestBodyBytes = 512 * 1024

type completeTaskRequest struct {
	Output json.RawMessage `json:"output"`
}

func limitTaskingRequestBody(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxTaskingRequestBodyBytes)
}

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
	limitTaskingRequestBody(w, r)

	var req createTaskRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskCreateRequest) {
		return
	}

	task, created, err := h.taskActions.Create(r.Context(), req.actionParams(), r.Header.Get("Idempotency-Key"))
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, task.Version)
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, r, status, serializers.SerializeTask(task))
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

func (h *Handler) AcknowledgeTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	limitTaskingRequestBody(w, r)
	var req protocol.TaskAcknowledgeRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskAcknowledgeRequest) {
		return
	}
	task, err := h.taskActions.Acknowledge(r.Context(), taskID, r.Header.Get("Atlas-Runtime-ID"))
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

func (h *Handler) StartTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	limitTaskingRequestBody(w, r)
	var req protocol.TaskStartRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskStartRequest) {
		return
	}
	task, err := h.taskActions.Start(r.Context(), taskID, r.Header.Get("Atlas-Runtime-ID"))
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

func (h *Handler) ProgressTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	limitTaskingRequestBody(w, r)
	var req protocol.TaskProgressRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskProgressRequest) {
		return
	}
	task, err := h.taskActions.Progress(r.Context(), taskID, r.Header.Get("Atlas-Runtime-ID"), req.Progress)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

func (h *Handler) CompleteTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	limitTaskingRequestBody(w, r)
	var req completeTaskRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskCompleteRequest) {
		return
	}
	var output *actions.TaskOutput
	if req.Output != nil {
		value, err := decodeTaskOutput(req.Output)
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", protocol.ErrorCodeInvalidJSON)
			return
		}
		output = &actions.TaskOutput{Value: value}
	}
	task, err := h.taskActions.Complete(r.Context(), taskID, r.Header.Get("Atlas-Runtime-ID"), output)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

func decodeTaskOutput(raw json.RawMessage) (protocol.JSONValue, error) {
	var value protocol.JSONValue
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := jsondecode.Decode(decoder, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func (h *Handler) FailTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	limitTaskingRequestBody(w, r)
	var req protocol.TaskFailRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskFailRequest) {
		return
	}
	task, err := h.taskActions.Fail(r.Context(), taskID, r.Header.Get("Atlas-Runtime-ID"), req.Failure)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
}

func (h *Handler) CancelTask(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "task_id")
	limitTaskingRequestBody(w, r)
	var req protocol.TaskCancelRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateTaskCancelRequest) {
		return
	}
	task, err := h.taskActions.Cancel(r.Context(), taskID, req.Cancellation)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	setResourceETag(w, task.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeTask(task))
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
