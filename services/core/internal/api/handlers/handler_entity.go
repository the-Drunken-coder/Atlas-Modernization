package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
	"github.com/the-drunken-coder/atlas/services/core/internal/serializers"
)

// --- Entity Handlers ---

// ListEntities handles GET /entities.
func (h *Handler) ListEntities(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	page, err := h.entityActions.List(r.Context(), limit, cursor)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	entities := serializers.SerializeEntities(page.Items)
	setPaginationHeaders(w, page.Limit, len(entities), page.HasMore, page.NextCursor)
	writeJSON(w, r, http.StatusOK, entities)
}

// CreateEntity handles POST /entities.
func (h *Handler) CreateEntity(w http.ResponseWriter, r *http.Request) {
	// Limit request body to 1MB for entity operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req createEntityRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateEntityCreateRequest) {
		return
	}

	entity, err := h.entityActions.Create(r.Context(), req.actionParams())
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, entity.Version)
	writeJSON(w, r, http.StatusCreated, serializers.SerializeEntity(entity))
}

// GetEntity handles GET /entities/{entity_id}.
func (h *Handler) GetEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	detail, err := h.entityActions.GetDetail(r.Context(), entityID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	serialized := serializers.SerializeEntity(detail.Entity)
	if detail.CommandManifest != nil {
		serialized.CommandManifest = detail.CommandManifest
	}
	setResourceETag(w, detail.Entity.Version)
	writeJSON(w, r, http.StatusOK, serialized)
}

// GetEntityByAlias handles GET /entities/alias/{alias}.
func (h *Handler) GetEntityByAlias(w http.ResponseWriter, r *http.Request) {
	alias := chi.URLParam(r, "alias")

	entity, err := h.entityActions.GetByAlias(r.Context(), alias)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, entity.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeEntity(entity))
}

// UpdateEntity handles PATCH /entities/{entity_id}.
func (h *Handler) UpdateEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	// Limit request body to 1MB for entity operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req updateEntityRequest
	if !h.decodeProtocolRequestBody(w, r, &req, false, protocol.ValidateEntityUpdateRequest) {
		return
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "entity")
	if !ok {
		return
	}

	entity, err := h.entityActions.Update(r.Context(), entityID, req.actionParams(expectedVersion))
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, entity.Version)
	writeJSON(w, r, http.StatusOK, serializers.SerializeEntity(entity))
}

type nullablePatchString struct {
	present bool
	value   *string
}

func (f *nullablePatchString) UnmarshalJSON(data []byte) error {
	f.present = true
	if string(data) == "null" {
		f.value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	f.value = &value
	return nil
}

func (f nullablePatchString) actionValue() *string {
	if !f.present {
		return nil
	}
	if f.value == nil {
		value := ""
		return &value
	}
	return f.value
}

// DeleteEntity handles DELETE /entities/{entity_id}.
func (h *Handler) DeleteEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	if err := h.entityActions.Delete(r.Context(), entityID); err != nil {
		h.handleActionError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// EntityCheckin handles POST /entities/{entity_id}/checkin.
func (h *Handler) EntityCheckin(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	// Limit request body to 256KB for telemetry updates
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)

	var req protocol.EntityCheckInRequest
	if !h.decodeProtocolRequestBody(w, r, &req, true, protocol.ValidateEntityCheckInRequest) {
		return
	}

	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "entity")
	if !ok {
		return
	}

	result, err := h.checkinActions.CheckIn(r.Context(), actions.EntityCheckinParams{
		EntityID:        entityID,
		Components:      checkinComponentUpdate(req, time.Now()),
		ExpectedVersion: expectedVersion,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	serializedEntity := serializers.SerializeEntity(result.Entity)
	if serializedEntity == nil {
		h.writeError(w, r, http.StatusInternalServerError, "Entity check-in returned no entity", protocol.ErrorCodeInternalServerError)
		return
	}
	setResourceETag(w, result.Entity.Version)
	writeJSON(w, r, http.StatusOK, protocol.EntityCheckInFullResponse{Entity: *serializedEntity})
}

func buildTelemetryComponent(latitude, longitude, altitudeM, speedMS, headingDeg *float64, lastUpdate *string) map[string]interface{} {
	telemetry := make(map[string]interface{})
	if latitude != nil {
		telemetry["latitude"] = *latitude
	}
	if longitude != nil {
		telemetry["longitude"] = *longitude
	}
	if altitudeM != nil {
		telemetry["altitude_m"] = *altitudeM
	}
	if speedMS != nil {
		telemetry["speed_m_s"] = *speedMS
	}
	if headingDeg != nil {
		telemetry["heading_deg"] = *headingDeg
	}
	if lastUpdate != nil && len(telemetry) > 0 {
		telemetry["last_update"] = *lastUpdate
	}
	return telemetry
}
