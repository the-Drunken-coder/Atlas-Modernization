package handlers

import (
	"encoding/json"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
)

type createEntityRequest struct {
	EntityID    string                 `json:"entity_id"`
	EntityType  string                 `json:"entity_type"`
	Subtype     string                 `json:"subtype"`
	Alias       *string                `json:"alias,omitempty"`
	Components  map[string]interface{} `json:"components,omitempty"`
	PublishedAt *time.Time             `json:"published_at,omitempty"`
	UpdatedAt   *time.Time             `json:"updated_at,omitempty"`
	Extra       map[string]interface{} `json:"extra,omitempty"`
}

func (r createEntityRequest) actionParams() actions.CreateEntityParams {
	return actions.CreateEntityParams{
		EntityID:    r.EntityID,
		EntityType:  r.EntityType,
		Subtype:     r.Subtype,
		Alias:       r.Alias,
		Components:  r.Components,
		PublishedAt: r.PublishedAt,
		UpdatedAt:   r.UpdatedAt,
		Extra:       r.Extra,
	}
}

type updateEntityRequest struct {
	EntityType *string                `json:"entity_type,omitempty"`
	Subtype    nullablePatchString    `json:"subtype,omitempty"`
	Alias      nullablePatchString    `json:"alias,omitempty"`
	Components map[string]interface{} `json:"components,omitempty"`
	Extra      map[string]interface{} `json:"extra,omitempty"`
}

func (r updateEntityRequest) actionParams(expectedVersion *int64) actions.UpdateEntityParams {
	return actions.UpdateEntityParams{
		EntityType:      r.EntityType,
		Subtype:         r.Subtype.actionValue(),
		Alias:           r.Alias.actionValue(),
		Components:      r.Components,
		Extra:           r.Extra,
		ExpectedVersion: expectedVersion,
	}
}

type entityCheckinRequest struct {
	Status     *string                `json:"status,omitempty"`
	Latitude   *float64               `json:"latitude,omitempty"`
	Longitude  *float64               `json:"longitude,omitempty"`
	AltitudeM  *float64               `json:"altitude_m,omitempty"`
	SpeedMS    *float64               `json:"speed_m_s,omitempty"`
	HeadingDeg *float64               `json:"heading_deg,omitempty"`
	Components map[string]interface{} `json:"components,omitempty"`
}

func (r entityCheckinRequest) componentUpdate(now time.Time) map[string]interface{} {
	nowStr := now.UTC().Format(time.RFC3339)
	components := make(map[string]interface{}, len(r.Components)+3)
	for key, value := range r.Components {
		components[key] = value
	}

	if r.Status != nil {
		components["status"] = map[string]interface{}{
			"value":       *r.Status,
			"last_update": nowStr,
		}
	}

	telemetry := buildTelemetryComponent(r.Latitude, r.Longitude, r.AltitudeM, r.SpeedMS, r.HeadingDeg, &nowStr)
	if len(telemetry) > 0 {
		components["telemetry"] = telemetry
	}

	components["heartbeat"] = map[string]interface{}{
		"last_seen": nowStr,
	}
	return components
}

type createTaskRequest struct {
	TaskID     string                 `json:"task_id"`
	Status     string                 `json:"status,omitempty"`
	EntityID   *string                `json:"entity_id,omitempty"`
	Components map[string]interface{} `json:"components,omitempty"`
	Extra      map[string]interface{} `json:"extra,omitempty"`
}

func (r createTaskRequest) actionParams() actions.CreateTaskParams {
	status := r.Status
	if status == "" {
		status = "pending"
	}
	return actions.CreateTaskParams{
		TaskID:     r.TaskID,
		Status:     status,
		EntityID:   r.EntityID,
		Components: r.Components,
		Extra:      r.Extra,
	}
}

type updateTaskRequest struct {
	Status          *string                `json:"status,omitempty"`
	EntityID        nullablePatchString    `json:"entity_id,omitempty"`
	Components      map[string]interface{} `json:"components,omitempty"`
	Extra           map[string]interface{} `json:"extra,omitempty"`
	RemoveExtraKeys []string               `json:"remove_extra_keys,omitempty"`
}

func (r updateTaskRequest) actionParams(expectedVersion *int64) actions.UpdateTaskParams {
	return actions.UpdateTaskParams{
		Status:          r.Status,
		EntityID:        r.EntityID.actionValue(),
		Components:      r.Components,
		Extra:           r.Extra,
		RemoveExtraKeys: r.RemoveExtraKeys,
		ExpectedVersion: expectedVersion,
	}
}

type createObjectRequest struct {
	ObjectID     string                   `json:"object_id"`
	Path         *string                  `json:"path,omitempty"`
	Bucket       json.RawMessage          `json:"bucket,omitempty"`
	SizeBytes    *int64                   `json:"size_bytes,omitempty"`
	ContentType  *string                  `json:"content_type,omitempty"`
	Type         *string                  `json:"type,omitempty"`
	UsageHints   []string                 `json:"usage_hints,omitempty"`
	ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
	Extra        map[string]interface{}   `json:"extra,omitempty"`
}

func (r createObjectRequest) actionParams() actions.CreateObjectParams {
	return actions.CreateObjectParams{
		ObjectID:     r.ObjectID,
		Path:         r.Path,
		SizeBytes:    r.SizeBytes,
		ContentType:  r.ContentType,
		Type:         r.Type,
		UsageHints:   r.UsageHints,
		ReferencedBy: r.ReferencedBy,
		Extra:        r.Extra,
	}
}

type updateObjectRequest struct {
	Path         *string                  `json:"path,omitempty"`
	Bucket       json.RawMessage          `json:"bucket,omitempty"`
	ContentType  *string                  `json:"content_type,omitempty"`
	Type         *string                  `json:"type,omitempty"`
	SizeBytes    *int64                   `json:"size_bytes,omitempty"`
	UsageHints   []string                 `json:"usage_hints,omitempty"`
	ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
	Extra        map[string]interface{}   `json:"extra,omitempty"`
}

func (r updateObjectRequest) actionParams(expectedVersion *int64) actions.UpdateObjectParams {
	return actions.UpdateObjectParams{
		Path:            r.Path,
		ContentType:     r.ContentType,
		Type:            r.Type,
		SizeBytes:       r.SizeBytes,
		UsageHints:      r.UsageHints,
		ReferencedBy:    r.ReferencedBy,
		Extra:           r.Extra,
		ExpectedVersion: expectedVersion,
	}
}
