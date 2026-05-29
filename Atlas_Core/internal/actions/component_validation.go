package actions

import (
	"fmt"
	"strings"
	"time"
)

// knownEntityComponents is the set of valid component keys for entities
var knownEntityComponents = map[string]bool{
	"telemetry":      true,
	"geometry":       true,
	"task_catalog":   true,
	"media_refs":     true,
	"mil_view":       true,
	"health":         true,
	"sensor_refs":    true,
	"communications": true,
	"task_queue":     true,
	"status":         true,
	"heartbeat":      true,
}

// knownTaskComponents is the set of valid component keys for tasks
var knownTaskComponents = map[string]bool{
	"command":        true,
	"parameters":     true,
	"progress":       true,
	"target":         true,
	"status_message": true,
}

// ValidationResult holds multiple validation errors
type ValidationResult struct {
	Errors []string
}

func (vr *ValidationResult) AddError(err string) {
	vr.Errors = append(vr.Errors, err)
}

func (vr *ValidationResult) HasErrors() bool {
	return len(vr.Errors) > 0
}

func (vr *ValidationResult) Error() string {
	if !vr.HasErrors() {
		return ""
	}
	if len(vr.Errors) == 1 {
		return vr.Errors[0]
	}
	return fmt.Sprintf("Component validation failed (%d errors): %s", len(vr.Errors), strings.Join(vr.Errors, "; "))
}

// NewValidationErrorWithDetails creates a validation error with multiple error details.
func NewValidationErrorWithDetails(message string, details []string) *ValidationError {
	return &ValidationError{
		ActionError: ActionError{
			Message: message,
			Code:    "VALIDATION_ERROR",
		},
		Details: details,
	}
}

// ValidateComponentKeys validates that all component keys are known or custom
func ValidateComponentKeys(components map[string]interface{}, knownKeys map[string]bool) *ValidationResult {
	result := &ValidationResult{}

	for key := range components {
		if knownKeys[key] {
			continue
		}
		if strings.HasPrefix(key, "custom_") {
			continue
		}
		result.AddError(fmt.Sprintf("Unknown component '%s'", key))
	}

	return result
}

// ValidateEntityComponents validates all components for an entity
func ValidateEntityComponents(components map[string]interface{}) error {
	if components == nil {
		return nil
	}

	result := &ValidationResult{}

	// Phase 1: Validate component keys
	keyResult := ValidateComponentKeys(components, knownEntityComponents)
	result.Errors = append(result.Errors, keyResult.Errors...)

	// Phase 2: Validate geometry component
	if rawGeometry, exists := components["geometry"]; exists {
		if geometry, ok := rawGeometry.(map[string]interface{}); ok {
			geoResult := ValidateGeometryComponent(geometry)
			result.Errors = append(result.Errors, geoResult.Errors...)
		} else {
			result.AddError("geometry component must be an object")
		}
	}

	// Phase 3: Validate other components
	if rawTelemetry, exists := components["telemetry"]; exists {
		if telemetry, ok := rawTelemetry.(map[string]interface{}); ok {
			teleResult := ValidateTelemetryComponent(telemetry)
			result.Errors = append(result.Errors, teleResult.Errors...)
		} else {
			result.AddError("telemetry component must be an object")
		}
	}

	if rawHealth, exists := components["health"]; exists {
		if health, ok := rawHealth.(map[string]interface{}); ok {
			healthResult := ValidateHealthComponent(health)
			result.Errors = append(result.Errors, healthResult.Errors...)
		} else {
			result.AddError("health component must be an object")
		}
	}

	if rawMilView, exists := components["mil_view"]; exists {
		if milView, ok := rawMilView.(map[string]interface{}); ok {
			milResult := ValidateMilViewComponent(milView)
			result.Errors = append(result.Errors, milResult.Errors...)
		} else {
			result.AddError("mil_view component must be an object")
		}
	}

	if rawTaskCatalog, exists := components["task_catalog"]; exists {
		if taskCatalog, ok := rawTaskCatalog.(map[string]interface{}); ok {
			catalogResult := ValidateTaskCatalogComponent(taskCatalog)
			result.Errors = append(result.Errors, catalogResult.Errors...)
		} else {
			result.AddError("task_catalog component must be an object")
		}
	}

	if mediaRefs, ok := components["media_refs"]; ok {
		// media_refs accepts an array payload, so pass the raw value through.
		mediaResult := ValidateMediaRefsComponent(mediaRefs)
		result.Errors = append(result.Errors, mediaResult.Errors...)
	}

	if sensorRefs, ok := components["sensor_refs"]; ok {
		// sensor_refs accepts an array payload, so pass the raw value through.
		sensorResult := ValidateSensorRefsComponent(sensorRefs)
		result.Errors = append(result.Errors, sensorResult.Errors...)
	}

	if rawComms, exists := components["communications"]; exists {
		if comms, ok := rawComms.(map[string]interface{}); ok {
			commsResult := ValidateCommunicationsComponent(comms)
			result.Errors = append(result.Errors, commsResult.Errors...)
		} else {
			result.AddError("communications component must be an object")
		}
	}

	if rawTaskQueue, exists := components["task_queue"]; exists {
		if taskQueue, ok := rawTaskQueue.(map[string]interface{}); ok {
			queueResult := ValidateTaskQueueComponent(taskQueue)
			result.Errors = append(result.Errors, queueResult.Errors...)
		} else {
			result.AddError("task_queue component must be an object")
		}
	}

	if rawStatus, exists := components["status"]; exists {
		if status, ok := rawStatus.(map[string]interface{}); ok {
			statusResult := ValidateStatusComponent(status)
			result.Errors = append(result.Errors, statusResult.Errors...)
		} else {
			result.AddError("status component must be an object")
		}
	}

	if rawHeartbeat, exists := components["heartbeat"]; exists {
		if heartbeat, ok := rawHeartbeat.(map[string]interface{}); ok {
			heartbeatResult := ValidateHeartbeatComponent(heartbeat)
			result.Errors = append(result.Errors, heartbeatResult.Errors...)
		} else {
			result.AddError("heartbeat component must be an object")
		}
	}

	if result.HasErrors() {
		return NewValidationErrorWithDetails(
			fmt.Sprintf("Component validation failed (%d errors)", len(result.Errors)),
			result.Errors,
		)
	}

	return nil
}

// ValidateTaskComponents validates all components for a task
func ValidateTaskComponents(components map[string]interface{}) error {
	if components == nil {
		return nil
	}

	result := &ValidationResult{}

	// Validate component keys
	keyResult := ValidateComponentKeys(components, knownTaskComponents)
	result.Errors = append(result.Errors, keyResult.Errors...)

	// Validate command component (legacy tasks may use a string command)
	if rawCommand, exists := components["command"]; exists {
		switch command := rawCommand.(type) {
		case string:
			if strings.TrimSpace(command) == "" {
				result.AddError("command: string command must be non-empty (whitespace-only is invalid)")
			}
		case map[string]interface{}:
			cmdResult := ValidateCommandComponent(command)
			result.Errors = append(result.Errors, cmdResult.Errors...)
		default:
			result.AddError("command component must be an object or string")
		}
	}

	// Validate parameters component
	if rawParams, exists := components["parameters"]; exists {
		if params, ok := rawParams.(map[string]interface{}); ok {
			paramResult := ValidateTaskParametersComponent(params, "parameters.")
			result.Errors = append(result.Errors, paramResult.Errors...)
		} else {
			result.AddError("parameters component must be an object")
		}
	}

	// Validate progress component
	if rawProgress, exists := components["progress"]; exists {
		if progress, ok := rawProgress.(map[string]interface{}); ok {
			progResult := ValidateTaskProgressComponent(progress)
			result.Errors = append(result.Errors, progResult.Errors...)
		} else {
			result.AddError("progress component must be an object")
		}
	}

	if rawTarget, exists := components["target"]; exists {
		if target, ok := rawTarget.(map[string]interface{}); ok {
			tgtResult := ValidateTaskParametersComponent(target, "target.")
			result.Errors = append(result.Errors, tgtResult.Errors...)
		} else {
			result.AddError("target component must be an object")
		}
	}

	if rawMsg, exists := components["status_message"]; exists && rawMsg != nil {
		if _, ok := rawMsg.(string); !ok {
			result.AddError("status_message must be a string")
		}
	}

	if result.HasErrors() {
		return NewValidationErrorWithDetails(
			fmt.Sprintf("Component validation failed (%d errors)", len(result.Errors)),
			result.Errors,
		)
	}

	return nil
}

// toFloat64 converts various numeric types to float64
func toFloat64(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int8:
		return float64(n), true
	case int16:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint8:
		return float64(n), true
	case uint16:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	default:
		return 0, false
	}
}

func ValidateStatusComponent(status map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	value, ok := status["value"].(string)
	if !ok || strings.TrimSpace(value) == "" {
		result.AddError("status.value is required and must be a non-empty string")
	}

	if lastUpdate, exists := status["last_update"]; exists {
		lastUpdateStr, ok := lastUpdate.(string)
		if !ok {
			result.AddError("status.last_update must be a string")
		} else if _, err := time.Parse(time.RFC3339, lastUpdateStr); err != nil {
			result.AddError("status.last_update must be a valid RFC3339 timestamp")
		}
	}

	return result
}

func ValidateHeartbeatComponent(heartbeat map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	lastSeen, ok := heartbeat["last_seen"].(string)
	if !ok || strings.TrimSpace(lastSeen) == "" {
		result.AddError("heartbeat.last_seen is required and must be a non-empty string")
		return result
	}

	if _, err := time.Parse(time.RFC3339, lastSeen); err != nil {
		result.AddError("heartbeat.last_seen must be a valid RFC3339 timestamp")
	}

	return result
}
