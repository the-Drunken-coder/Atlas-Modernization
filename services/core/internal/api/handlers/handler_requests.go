package handlers

import (
	"time"

	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
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

func checkinComponentUpdate(request protocol.EntityCheckInRequest, now time.Time) map[string]interface{} {
	nowStr := now.UTC().Format(time.RFC3339)
	components := make(map[string]interface{}, len(request.Components)+3)
	for key, value := range request.Components {
		components[key] = value
	}

	if request.Status != nil {
		components["status"] = map[string]interface{}{
			"value":       *request.Status,
			"last_update": nowStr,
		}
	}

	telemetry := buildTelemetryComponent(
		request.Latitude,
		request.Longitude,
		request.AltitudeM,
		request.SpeedMS,
		request.HeadingDeg,
		&nowStr,
	)
	if len(telemetry) > 0 {
		components["telemetry"] = telemetry
	}

	components["heartbeat"] = map[string]interface{}{
		"last_seen": nowStr,
	}
	return components
}

type createTaskRequest struct {
	AssetID string             `json:"asset_id"`
	Command string             `json:"command"`
	Input   protocol.JSONValue `json:"input"`
}

func (r createTaskRequest) actionParams() actions.CreateTaskParams {
	return actions.CreateTaskParams{
		AssetID: r.AssetID,
		Command: r.Command,
		Input:   r.Input,
	}
}

type createObjectRequest struct {
	ObjectID     string                   `json:"object_id"`
	Type         *string                  `json:"type,omitempty"`
	UsageHints   []string                 `json:"usage_hints,omitempty"`
	ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
	Extra        map[string]interface{}   `json:"extra,omitempty"`
}

func (r createObjectRequest) actionParams() actions.CreateObjectParams {
	return actions.CreateObjectParams{
		ObjectID:     r.ObjectID,
		Type:         r.Type,
		UsageHints:   r.UsageHints,
		ReferencedBy: r.ReferencedBy,
		Extra:        r.Extra,
	}
}

type updateObjectRequest struct {
	Type         *string                  `json:"type,omitempty"`
	UsageHints   []string                 `json:"usage_hints,omitempty"`
	ReferencedBy []map[string]interface{} `json:"referenced_by,omitempty"`
	Extra        map[string]interface{}   `json:"extra,omitempty"`
}

func (r updateObjectRequest) actionParams(expectedVersion *int64) actions.UpdateObjectParams {
	return actions.UpdateObjectParams{
		Type:            r.Type,
		UsageHints:      r.UsageHints,
		ReferencedBy:    r.ReferencedBy,
		Extra:           r.Extra,
		ExpectedVersion: expectedVersion,
	}
}
