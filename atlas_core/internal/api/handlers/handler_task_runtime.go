package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

func (h *Handler) BeginAssetRuntime(w http.ResponseWriter, r *http.Request) {
	assetID := chi.URLParam(r, "entity_id")
	limitTaskingRequestBody(w, r)
	var req protocol.RuntimeRegistrationRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateRuntimeRegistrationRequest) {
		return
	}
	if err := h.taskActions.BeginRuntimeRegistration(r.Context(), assetID, req.RuntimeID); err != nil {
		h.handleActionError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) ReadyAssetRuntime(w http.ResponseWriter, r *http.Request) {
	assetID := chi.URLParam(r, "entity_id")
	limitTaskingRequestBody(w, r)
	var req protocol.RuntimeReadyRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateRuntimeReadyRequest) {
		return
	}
	if err := h.taskActions.CompleteRuntimeRegistration(r.Context(), assetID, req.RuntimeID, req.Manifest); err != nil {
		h.handleActionError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) DeliverAssetTasks(w http.ResponseWriter, r *http.Request) {
	assetID := chi.URLParam(r, "entity_id")
	tasks, err := h.taskActions.Deliverable(r.Context(), assetID, r.Header.Get("Atlas-Runtime-ID"))
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, protocol.RuntimeTaskDeliveryResponse{Tasks: serializers.SerializeTasks(tasks)})
}
