// Package models defines the database models for Atlas Core.
package models

import (
	"encoding/json"
	"strings"
	"time"
)

// TelemetryComponent represents telemetry data for an entity.
type TelemetryComponent struct {
	Latitude   *float64   `json:"latitude,omitempty"`
	Longitude  *float64   `json:"longitude,omitempty"`
	AltitudeM  *float64   `json:"altitude_m,omitempty"`
	SpeedMS    *float64   `json:"speed_m_s,omitempty"`
	HeadingDeg *float64   `json:"heading_deg,omitempty"`
	LastUpdate *time.Time `json:"last_update,omitempty"`
}

// UnmarshalJSON accepts both the canonical speed_m_s key and the legacy speed_ms alias.
func (t *TelemetryComponent) UnmarshalJSON(data []byte) error {
	type telemetryAlias TelemetryComponent

	var decoded telemetryAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	if _, hasCanonical := raw["speed_m_s"]; !hasCanonical {
		if legacy, ok := raw["speed_ms"]; ok {
			var speed *float64
			if err := json.Unmarshal(legacy, &speed); err != nil {
				return err
			}
			decoded.SpeedMS = speed
		}
	}

	*t = TelemetryComponent(decoded)
	return nil
}

// StatusComponent represents status data for an entity.
type StatusComponent struct {
	Value      string     `json:"value"`
	LastUpdate *time.Time `json:"last_update,omitempty"`
}

// HeartbeatComponent represents heartbeat data for an entity.
type HeartbeatComponent struct {
	LastSeen time.Time `json:"last_seen"`
}

// CommandComponent represents a command for a task.
type CommandComponent struct {
	Type   string                 `json:"type"`
	Target map[string]interface{} `json:"target,omitempty"`
}

// TaskResult represents the result of a completed task.
type TaskResult struct {
	Success     bool                   `json:"success"`
	Description string                 `json:"description,omitempty"`
	Data        map[string]interface{} `json:"data,omitempty"`
}

// TaskError represents an error from a failed task.
type TaskError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// decodeJSONComponent round-trips dynamic component data into out via JSON.
func decodeJSONComponent(data interface{}, out interface{}) bool {
	b, err := json.Marshal(data)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, out) == nil
}

// GetTelemetry returns the telemetry component from the entity.
// Returns nil if the component is missing or has an invalid format.
func (e *Entity) GetTelemetry() *TelemetryComponent {
	components := e.GetComponents()
	if components == nil {
		return nil
	}

	telemetryData, ok := components["telemetry"]
	if !ok || telemetryData == nil {
		return nil
	}

	var telemetry TelemetryComponent
	if !decodeJSONComponent(telemetryData, &telemetry) {
		return nil
	}

	return &telemetry
}

// GetStatus returns the status component from the entity.
// Returns nil if the component is missing or has an invalid format.
func (e *Entity) GetStatus() *StatusComponent {
	components := e.GetComponents()
	if components == nil {
		return nil
	}

	statusData, ok := components["status"]
	if !ok {
		return nil
	}

	var status StatusComponent
	if !decodeJSONComponent(statusData, &status) {
		return nil
	}
	if strings.TrimSpace(status.Value) == "" {
		return nil
	}

	return &status
}

// GetHeartbeat returns the heartbeat component from the entity.
// Returns nil if the component is missing or has an invalid format.
func (e *Entity) GetHeartbeat() *HeartbeatComponent {
	components := e.GetComponents()
	if components == nil {
		return nil
	}

	heartbeatData, ok := components["heartbeat"]
	if !ok {
		return nil
	}

	var heartbeat HeartbeatComponent
	if !decodeJSONComponent(heartbeatData, &heartbeat) {
		return nil
	}

	// Check for zero time which indicates parsing failure
	if heartbeat.LastSeen.IsZero() {
		return nil
	}

	return &heartbeat
}

// GetCommand returns the command component from the task.
// Returns nil if the component is missing or has an invalid format.
func (t *Task) GetCommand() *CommandComponent {
	components := t.GetComponents()
	if components == nil {
		return nil
	}

	commandData, ok := components["command"]
	if !ok {
		return nil
	}

	var command CommandComponent
	if !decodeJSONComponent(commandData, &command) {
		return nil
	}
	if strings.TrimSpace(command.Type) == "" {
		return nil
	}

	return &command
}

// taskExtraField resolves a key from GetExtra(), including nested `extra` (canonical JSON shape).
func taskExtraField(extra map[string]interface{}, key string) (interface{}, bool) {
	if extra == nil {
		return nil, false
	}
	if v, ok := extra[key]; ok {
		return v, true
	}
	if nested, ok := extra["extra"].(map[string]interface{}); ok {
		if v, ok := nested[key]; ok {
			return v, true
		}
	}
	return nil, false
}

// GetResult returns the result from the task's extra fields.
// Returns nil if the result is missing or has an invalid format.
func (t *Task) GetResult() *TaskResult {
	extra := t.GetExtra()
	if extra == nil {
		return nil
	}

	resultData, ok := taskExtraField(extra, "result")
	if !ok || resultData == nil {
		return nil
	}
	if resultMap, ok := resultData.(map[string]interface{}); ok && len(resultMap) == 0 {
		return nil
	}

	var result TaskResult
	if !decodeJSONComponent(resultData, &result) {
		return nil
	}

	return &result
}

// GetError returns the error from the task's extra fields.
// Returns nil if the error is missing or has an invalid format.
func (t *Task) GetError() *TaskError {
	extra := t.GetExtra()
	if extra == nil {
		return nil
	}

	errorData, ok := taskExtraField(extra, "error")
	if !ok || errorData == nil {
		return nil
	}

	var taskError TaskError
	if !decodeJSONComponent(errorData, &taskError) {
		return nil
	}
	if strings.TrimSpace(taskError.Code) == "" && strings.TrimSpace(taskError.Message) == "" {
		return nil
	}

	return &taskError
}

// GetProgress returns progress from components.progress.percent, then legacy extra.progress.
func (t *Task) GetProgress() *float64 {
	if components := t.GetComponents(); components != nil {
		if progressData, ok := components["progress"]; ok && progressData != nil {
			var progress struct {
				Percent *float64 `json:"percent"`
			}
			if decodeJSONComponent(progressData, &progress) && progress.Percent != nil {
				return progress.Percent
			}
		}
	}

	extra := t.GetExtra()
	if extra == nil {
		return nil
	}

	progressData, ok := taskExtraField(extra, "progress")
	if !ok {
		return nil
	}

	progress, ok := progressData.(float64)
	if !ok {
		return nil
	}

	return &progress
}
