package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
)

// --- Entity Handlers ---

// ListEntities handles GET /entities.
func (h *Handler) ListEntities(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := h.parseListPagination(w, r)
	if !ok {
		return
	}

	effectiveLimit := actions.ClampListLimit(limit)
	entities, total, err := h.entityActions.List(r.Context(), limit, offset)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	setPaginationHeaders(w, total, effectiveLimit, offset, len(entities))
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", "BODY_TOO_LARGE")
			return
		}
		if errors.Is(err, io.EOF) {
			h.writeError(w, r, http.StatusBadRequest, "Empty request body", "INVALID_JSON")
			return
		}
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", "INVALID_JSON")
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

	writeJSON(w, http.StatusCreated, entity)
}

// GetEntity handles GET /entities/{entity_id}.
func (h *Handler) GetEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	entity, err := h.entityActions.Get(r.Context(), entityID)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, entity)
}

// GetEntityByAlias handles GET /entities/alias/{alias}.
func (h *Handler) GetEntityByAlias(w http.ResponseWriter, r *http.Request) {
	alias := chi.URLParam(r, "alias")

	entity, err := h.entityActions.GetByAlias(r.Context(), alias)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, entity)
}

// UpdateEntity handles PATCH /entities/{entity_id}.
func (h *Handler) UpdateEntity(w http.ResponseWriter, r *http.Request) {
	entityID := chi.URLParam(r, "entity_id")

	// Limit request body to 1MB for entity operations
	r.Body = http.MaxBytesReader(w, r.Body, 1*1024*1024)

	var req struct {
		EntityType *string                `json:"entity_type,omitempty"`
		Subtype    *string                `json:"subtype,omitempty"`
		Alias      *string                `json:"alias,omitempty"`
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

	entity, err := h.entityActions.Update(r.Context(), entityID, actions.UpdateEntityParams{
		EntityType: req.EntityType,
		Subtype:    req.Subtype,
		Alias:      req.Alias,
		Components: req.Components,
		Extra:      req.Extra,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, entity)
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", "BODY_TOO_LARGE")
			return
		}
		h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", "INVALID_JSON")
		return
	}

	// Build telemetry component update
	telemetry := make(map[string]interface{})
	if req.Latitude != nil {
		telemetry["latitude"] = *req.Latitude
	}
	if req.Longitude != nil {
		telemetry["longitude"] = *req.Longitude
	}
	if req.AltitudeM != nil {
		telemetry["altitude_m"] = *req.AltitudeM
	}
	if req.SpeedMS != nil {
		telemetry["speed_m_s"] = *req.SpeedMS
	}
	if req.HeadingDeg != nil {
		telemetry["heading_deg"] = *req.HeadingDeg
	}

	if len(telemetry) == 0 {
		h.writeError(w, r, http.StatusBadRequest, "At least one telemetry field must be provided", "VALIDATION_ERROR")
		return
	}

	entity, err := h.entityActions.Update(r.Context(), entityID, actions.UpdateEntityParams{
		Components: map[string]interface{}{"telemetry": telemetry},
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, entity)
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
		h.writeError(w, r, http.StatusBadRequest, "Invalid limit parameter", "VALIDATION_ERROR")
		return
	}
	if limit < 1 || limit > 20 {
		h.writeError(w, r, http.StatusBadRequest, "limit must be between 1 and 20", "VALIDATION_ERROR")
		return
	}

	offset, err := parseNonNegativeIntQuery(r, "offset", 0)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "Invalid offset parameter", "VALIDATION_ERROR")
		return
	}

	fields := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("fields")))
	sinceStr := strings.TrimSpace(r.URL.Query().Get("since"))
	var since *time.Time
	if sinceStr != "" {
		parsed, err := parseRFC3339Timestamp(sinceStr)
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "Invalid since timestamp format (use RFC3339)", "VALIDATION_ERROR")
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			h.writeError(w, r, http.StatusRequestEntityTooLarge, "Request body too large", "BODY_TOO_LARGE")
			return
		}
		if !errors.Is(err, io.EOF) {
			h.writeError(w, r, http.StatusBadRequest, "Invalid JSON body", "INVALID_JSON")
			return
		}
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

	// Add telemetry component if any telemetry fields provided
	telemetry := make(map[string]interface{})
	if req.Latitude != nil {
		telemetry["latitude"] = *req.Latitude
	}
	if req.Longitude != nil {
		telemetry["longitude"] = *req.Longitude
	}
	if req.AltitudeM != nil {
		telemetry["altitude_m"] = *req.AltitudeM
	}
	if req.SpeedMS != nil {
		telemetry["speed_m_s"] = *req.SpeedMS
	}
	if req.HeadingDeg != nil {
		telemetry["heading_deg"] = *req.HeadingDeg
	}
	if len(telemetry) > 0 {
		telemetry["last_update"] = now
		components["telemetry"] = telemetry
	}

	// Add heartbeat component
	components["heartbeat"] = map[string]interface{}{
		"last_seen": now,
	}

	entity, err := h.entityActions.Update(r.Context(), entityID, actions.UpdateEntityParams{
		Components: components,
	})
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	statuses := parseStatusFilter(statusFilter)
	tasks, err := h.taskActions.GetByEntityFiltered(r.Context(), entityID, statuses, since, limit, offset)
	if err != nil {
		h.handleActionError(w, r, err)
		return
	}

	var taskPayload interface{} = tasks
	if fields == "minimal" {
		taskPayload = serializeCheckinTasksMinimal(tasks)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"entity":     entity,
		"tasks":      taskPayload,
		"task_count": len(tasks),
		"task_limit": limit,
	})
}
