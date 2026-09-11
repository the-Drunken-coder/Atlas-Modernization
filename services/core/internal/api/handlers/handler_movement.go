package handlers

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
)

func (h *Handler) ImportMovement(w http.ResponseWriter, r *http.Request) {
	received := time.Now()
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
	var request protocol.MovementHistoryBatchRequest
	if !h.decodeProtocolRequestBody(w, r, &request, false, protocol.ValidateMovementHistoryBatchRequest) {
		return
	}
	result, err := h.entityActions.ImportMovement(r.Context(), chi.URLParam(r, "entity_id"), request, received)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func movementTimestamp(r *http.Request, name string) (time.Time, error) {
	t, err := actions.ParseMovementTimestamp(r.URL.Query().Get(name))
	if err != nil {
		return t, actions.NewValidationError(name + " must be an RFC3339 timestamp")
	}
	return t, nil
}
func movementQuery(r *http.Request, trail bool) (actions.MovementQuery, error) {
	var q actions.MovementQuery
	var err error
	if q.EntityCreatedAt, err = movementTimestamp(r, "entity_created_at"); err != nil {
		return q, err
	}
	if q.From, err = movementTimestamp(r, "from"); err != nil {
		return q, err
	}
	if q.To, err = movementTimestamp(r, "to"); err != nil {
		return q, err
	}
	field, target := "limit", &q.Limit
	if trail {
		field, target = "max_points", &q.MaxPoints
	} else {
		q.Cursor = r.URL.Query().Get("cursor")
		if len(q.Cursor) > 4096 {
			return q, actions.NewValidationError("movement cursor is too long")
		}
	}
	if raw := r.URL.Query().Get(field); raw != "" {
		*target, err = strconv.Atoi(raw)
		if err != nil || *target < 1 {
			return q, actions.NewValidationError(field + " must be positive")
		}
	}
	return q, nil
}
func (h *Handler) GetMovementHistory(w http.ResponseWriter, r *http.Request) {
	q, err := movementQuery(r, false)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	result, err := h.entityActions.MovementHistory(r.Context(), chi.URLParam(r, "entity_id"), q)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
func (h *Handler) GetMovementTrail(w http.ResponseWriter, r *http.Request) {
	q, err := movementQuery(r, true)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	result, err := h.entityActions.MovementTrail(r.Context(), chi.URLParam(r, "entity_id"), q)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
func (h *Handler) InspectMovement(w http.ResponseWriter, r *http.Request) {
	created, err := movementTimestamp(r, "entity_created_at")
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	at, err := movementTimestamp(r, "at")
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	result, err := h.entityActions.InspectMovement(r.Context(), chi.URLParam(r, "entity_id"), created, at)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
