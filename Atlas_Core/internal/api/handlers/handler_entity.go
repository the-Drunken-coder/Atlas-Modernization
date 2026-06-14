package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
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
	writeJSON(w, http.StatusOK, entities)
}

// CreateEntity handles POST /entities.
func (h *Handler) CreateEntity(w http.ResponseWriter, r *http.Request) {
	// Limit request body to 1MB for entity operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req struct {
		EntityID    string                 `json:"entity_id"`
		EntityType  string                 `json:"entity_type"`
		Subtype     string                 `json:"subtype"`
		Alias       *string                `json:"alias,omitempty"`
		Components  map[string]interface{} `json:"components,omitempty"`
		PublishedAt *time.Time             `json:"published_at,omitempty"`
		UpdatedAt   *time.Time             `json:"updated_at,omitempty"`
		Extra       map[string]interface{} `json:"extra,omitempty"`
	}

	if !h.decodeJSONRequestBody(w, r, &req, false) {
		return
	}

	entity, err := h.entityActions.Create(r.Context(), actions.CreateEntityParams{
		EntityID:    req.EntityID,
		EntityType:  req.EntityType,
		Subtype:     req.Subtype,
		Alias:       req.Alias,
		Components:  req.Components,
		PublishedAt: req.PublishedAt,
		UpdatedAt:   req.UpdatedAt,
		Extra:       req.Extra,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, entity.Version)
	writeJSON(w, http.StatusCreated, serializers.SerializeEntity(entity))
}

// GetEntity handles GET /entities/{entity_id}.
func (h *Handler) GetEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	entity, err := h.entityActions.Get(r.Context(), entityID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, entity.Version)
	writeJSON(w, http.StatusOK, serializers.SerializeEntity(entity))
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
	writeJSON(w, http.StatusOK, serializers.SerializeEntity(entity))
}

// UpdateEntity handles PATCH /entities/{entity_id}.
func (h *Handler) UpdateEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	// Limit request body to 1MB for entity operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req struct {
		EntityType *string                `json:"entity_type,omitempty"`
		Subtype    nullablePatchString    `json:"subtype,omitempty"`
		Alias      nullablePatchString    `json:"alias,omitempty"`
		Components map[string]interface{} `json:"components,omitempty"`
		Extra      map[string]interface{} `json:"extra,omitempty"`
	}

	if !h.decodeJSONRequestBody(w, r, &req, false) {
		return
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "entity")
	if !ok {
		return
	}

	entity, err := h.entityActions.Update(r.Context(), entityID, actions.UpdateEntityParams{
		EntityType:      req.EntityType,
		Subtype:         req.Subtype.actionValue(),
		Alias:           req.Alias.actionValue(),
		Components:      req.Components,
		Extra:           req.Extra,
		ExpectedVersion: expectedVersion,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, entity.Version)
	writeJSON(w, http.StatusOK, serializers.SerializeEntity(entity))
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

// UpdateEntityTelemetry handles PATCH /entities/{entity_id}/telemetry.
func (h *Handler) UpdateEntityTelemetry(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	// Limit request body to 256KB for telemetry updates
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)

	var req struct {
		Latitude   *float64 `json:"latitude,omitempty"`
		Longitude  *float64 `json:"longitude,omitempty"`
		AltitudeM  *float64 `json:"altitude_m,omitempty"`
		SpeedMS    *float64 `json:"speed_m_s,omitempty"`
		HeadingDeg *float64 `json:"heading_deg,omitempty"`
	}

	if !h.decodeJSONRequestBody(w, r, &req, false) {
		return
	}

	telemetry := buildTelemetryComponent(req.Latitude, req.Longitude, req.AltitudeM, req.SpeedMS, req.HeadingDeg, nil)
	if len(telemetry) == 0 {
		h.writeError(w, r, http.StatusBadRequest, "At least one telemetry field must be provided", protocol.ErrorCodeValidationError)
		return
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "entity")
	if !ok {
		return
	}

	entity, err := h.entityActions.Update(r.Context(), entityID, actions.UpdateEntityParams{
		Components:      map[string]interface{}{"telemetry": telemetry},
		ExpectedVersion: expectedVersion,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setResourceETag(w, entity.Version)
	writeJSON(w, http.StatusOK, serializers.SerializeEntity(entity))
}

// EntityCheckin handles POST /entities/{entity_id}/checkin.
func (h *Handler) EntityCheckin(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status_filter"))
	if statusFilter == "" {
		statusFilter = "pending,acknowledged"
	}

	limit, err := parseNonNegativeIntQuery(r, "limit", 10)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid limit parameter", protocol.ErrorCodeValidationError)
		return
	}
	if limit < 1 || limit > 20 {
		h.writeError(w, r, http.StatusBadRequest, "limit must be between 1 and 20", protocol.ErrorCodeValidationError)
		return
	}

	if _, exists := r.URL.Query()["offset"]; exists {
		h.writeError(w, r, http.StatusBadRequest, "offset pagination is not supported; use task_cursor", protocol.ErrorCodeValidationError)
		return
	}
	taskCursor := strings.TrimSpace(r.URL.Query().Get("task_cursor"))

	fields := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("fields")))
	sinceStr := strings.TrimSpace(r.URL.Query().Get("since"))
	var since *time.Time
	if sinceStr != "" {
		parsed, err := parseRFC3339Timestamp(sinceStr)
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "Invalid since timestamp format (use RFC3339)", protocol.ErrorCodeValidationError)
			return
		}
		since = &parsed
	}

	// Limit request body to 256KB for telemetry updates
	r.Body = http.MaxBytesReader(w, r.Body, 256*1024)

	var req struct {
		Status     *string                `json:"status,omitempty"`
		Latitude   *float64               `json:"latitude,omitempty"`
		Longitude  *float64               `json:"longitude,omitempty"`
		AltitudeM  *float64               `json:"altitude_m,omitempty"`
		SpeedMS    *float64               `json:"speed_m_s,omitempty"`
		HeadingDeg *float64               `json:"heading_deg,omitempty"`
		Components map[string]interface{} `json:"components,omitempty"`
	}

	if !h.decodeJSONRequestBody(w, r, &req, true) {
		return
	}

	// Build components update (single timestamp for all touched components)
	now := time.Now().UTC().Format(time.RFC3339)
	components := make(map[string]interface{})
	for key, value := range req.Components {
		components[key] = value
	}

	// Add status component if provided
	if req.Status != nil {
		components["status"] = map[string]interface{}{
			"value":       *req.Status,
			"last_update": now,
		}
	}

	telemetry := buildTelemetryComponent(req.Latitude, req.Longitude, req.AltitudeM, req.SpeedMS, req.HeadingDeg, &now)
	if len(telemetry) > 0 {
		components["telemetry"] = telemetry
	}

	// Add heartbeat component
	components["heartbeat"] = map[string]interface{}{
		"last_seen": now,
	}
	expectedVersion, ok := h.parseIfMatchExpectedVersion(w, r, "entity")
	if !ok {
		return
	}

	entity, err := h.entityActions.Update(r.Context(), entityID, actions.UpdateEntityParams{
		Components:      components,
		ExpectedVersion: expectedVersion,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	statuses := parseStatusFilter(statusFilter)
	taskPage, err := h.taskActions.GetByEntityFiltered(r.Context(), entityID, statuses, since, limit, taskCursor)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	serializedTasks := serializers.SerializeTasks(taskPage.Items)
	var taskPayload interface{} = serializedTasks
	if fields == "minimal" {
		taskPayload = serializeCheckinTasksMinimal(serializedTasks)
	}

	response := map[string]interface{}{
		"entity":         serializers.SerializeEntity(entity),
		"tasks":          taskPayload,
		"task_count":     len(serializedTasks),
		"task_limit":     taskPage.Limit,
		"has_more_tasks": taskPage.HasMore,
	}
	if taskPage.NextCursor != "" {
		response["next_task_cursor"] = taskPage.NextCursor
	}
	setResourceETag(w, entity.Version)
	writeJSON(w, http.StatusOK, response)
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
