package actions

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// ValidateTelemetryComponent validates the telemetry component
func ValidateTelemetryComponent(telemetry map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if lat, ok := telemetry["latitude"]; ok && lat != nil {
		num, ok := toFloat64(lat)
		if !ok {
			result.AddError("telemetry.latitude: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("telemetry.latitude: must be finite (not NaN or Inf)")
		} else if num < -90 || num > 90 {
			result.AddError(fmt.Sprintf("telemetry.latitude: %.6f is out of range [-90, 90]", num))
		}
	}

	if lng, ok := telemetry["longitude"]; ok && lng != nil {
		num, ok := toFloat64(lng)
		if !ok {
			result.AddError("telemetry.longitude: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("telemetry.longitude: must be finite (not NaN or Inf)")
		} else if num < -180 || num > 180 {
			result.AddError(fmt.Sprintf("telemetry.longitude: %.6f is out of range [-180, 180]", num))
		}
	}

	if alt, ok := telemetry["altitude_m"]; ok && alt != nil {
		num, ok := toFloat64(alt)
		if !ok {
			result.AddError("telemetry.altitude_m: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("telemetry.altitude_m: must be finite (not NaN or Inf)")
		}
	}

	if speed, ok := telemetry["speed_m_s"]; ok && speed != nil {
		num, ok := toFloat64(speed)
		if !ok {
			result.AddError("telemetry.speed_m_s: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("telemetry.speed_m_s: must be finite (not NaN or Inf)")
		} else if num < 0 {
			result.AddError(fmt.Sprintf("telemetry.speed_m_s: %.6f must be non-negative", num))
		}
	}

	if heading, ok := telemetry["heading_deg"]; ok && heading != nil {
		num, ok := toFloat64(heading)
		if !ok {
			result.AddError("telemetry.heading_deg: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("telemetry.heading_deg: must be finite (not NaN or Inf)")
		} else if num < 0 || num >= 360 {
			result.AddError(fmt.Sprintf("telemetry.heading_deg: %.6f is out of range [0, 360)", num))
		}
	}

	return result
}

// ValidateHealthComponent validates the health component
func ValidateHealthComponent(health map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if battery, ok := health["battery_percent"]; ok && battery != nil {
		num, ok := toFloat64(battery)
		if !ok {
			result.AddError("health.battery_percent: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("health.battery_percent: must be finite (not NaN or Inf)")
		} else if num < 0 || num > 100 {
			result.AddError(fmt.Sprintf("health.battery_percent: %.6f is out of range [0, 100]", num))
		}
	}

	return result
}

// ValidateMilViewComponent validates the mil_view component
func ValidateMilViewComponent(milView map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if classification, ok := milView["classification"]; ok && classification != nil {
		str, ok := classification.(string)
		if !ok {
			result.AddError("mil_view.classification: expected string")
		} else {
			validClassifications := map[string]bool{
				"friendly": true,
				"hostile":  true,
				"neutral":  true,
				"unknown":  true,
				"civilian": true,
			}
			if !validClassifications[str] {
				result.AddError("mil_view.classification: must be one of friendly, hostile, neutral, unknown, civilian")
			}
		}
	}

	if lastSeen, ok := milView["last_seen"]; ok && lastSeen != nil {
		str, ok := lastSeen.(string)
		if !ok {
			result.AddError("mil_view.last_seen: expected string (RFC3339 timestamp)")
		} else {
			if _, err := time.Parse(time.RFC3339, str); err != nil {
				result.AddError(fmt.Sprintf("mil_view.last_seen: invalid RFC3339 timestamp: %s", err))
			}
		}
	}

	return result
}

// ValidateTaskCatalogComponent validates the task_catalog component
func ValidateTaskCatalogComponent(catalog map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if tasks, ok := catalog["supported_tasks"]; ok && tasks != nil {
		tasksArray, ok := tasks.([]interface{})
		if !ok {
			result.AddError("task_catalog.supported_tasks: expected array of strings")
		} else {
			for i, task := range tasksArray {
				str, ok := task.(string)
				if !ok {
					result.AddError(fmt.Sprintf("task_catalog.supported_tasks[%d]: expected string", i))
				} else {
					trimmed := strings.TrimSpace(str)
					if trimmed == "" {
						result.AddError(fmt.Sprintf("task_catalog.supported_tasks[%d]: must be non-empty", i))
					}
				}
			}
		}
	}

	return result
}

// ValidateMediaRefsComponent validates the media_refs component
func ValidateMediaRefsComponent(refs interface{}) *ValidationResult {
	result := &ValidationResult{}

	if refs == nil {
		return result
	}

	refsArray, ok := refs.([]interface{})
	if !ok {
		result.AddError("media_refs: expected array")
		return result
	}

	validRoles := map[string]bool{
		"camera_feed":  true,
		"thumbnail":    true,
		"heatmap_data": true,
	}

	for i, ref := range refsArray {
		refMap, ok := ref.(map[string]interface{})
		if !ok {
			result.AddError(fmt.Sprintf("media_refs[%d]: expected object", i))
			continue
		}

		if objectID, ok := refMap["object_id"]; ok {
			str, ok := objectID.(string)
			if !ok {
				result.AddError(fmt.Sprintf("media_refs[%d].object_id: expected string", i))
			} else if strings.TrimSpace(str) == "" {
				result.AddError(fmt.Sprintf("media_refs[%d].object_id: must be non-empty", i))
			}
		} else {
			result.AddError(fmt.Sprintf("media_refs[%d]: missing required field 'object_id'", i))
		}

		if role, ok := refMap["role"]; ok {
			str, ok := role.(string)
			if !ok {
				result.AddError(fmt.Sprintf("media_refs[%d].role: expected string", i))
			} else {
				roleTrim := strings.TrimSpace(str)
				if roleTrim == "" {
					result.AddError(fmt.Sprintf("media_refs[%d].role: must be non-empty", i))
				} else if roleTrim != str {
					result.AddError(fmt.Sprintf("media_refs[%d].role: must not include leading or trailing whitespace", i))
				} else if !validRoles[roleTrim] {
					result.AddError(fmt.Sprintf("media_refs[%d].role: must be one of camera_feed, thumbnail, heatmap_data", i))
				}
			}
		} else {
			result.AddError(fmt.Sprintf("media_refs[%d]: missing required field 'role'", i))
		}
	}

	return result
}

// ValidateSensorRefsComponent validates the sensor_refs component
func ValidateSensorRefsComponent(refs interface{}) *ValidationResult {
	result := &ValidationResult{}

	if refs == nil {
		return result
	}

	refsArray, ok := refs.([]interface{})
	if !ok {
		result.AddError("sensor_refs: expected array")
		return result
	}

	for i, ref := range refsArray {
		refMap, ok := ref.(map[string]interface{})
		if !ok {
			result.AddError(fmt.Sprintf("sensor_refs[%d]: expected object", i))
			continue
		}

		if sensorID, ok := refMap["sensor_id"]; ok {
			str, ok := sensorID.(string)
			if !ok {
				result.AddError(fmt.Sprintf("sensor_refs[%d].sensor_id: expected string", i))
			} else if strings.TrimSpace(str) == "" {
				result.AddError(fmt.Sprintf("sensor_refs[%d].sensor_id: must be non-empty", i))
			}
		} else {
			result.AddError(fmt.Sprintf("sensor_refs[%d]: missing required field 'sensor_id'", i))
		}

		if sensorType, ok := refMap["type"]; ok {
			str, ok := sensorType.(string)
			if !ok {
				result.AddError(fmt.Sprintf("sensor_refs[%d].type: expected string", i))
			} else if strings.TrimSpace(str) == "" {
				result.AddError(fmt.Sprintf("sensor_refs[%d].type: must be non-empty", i))
			}
		} else {
			result.AddError(fmt.Sprintf("sensor_refs[%d]: missing required field 'type'", i))
		}

		// Validate numeric sensor fields if present (support both legacy and documented naming)
		numericSensorFields := []string{
			// Legacy naming
			"fov_horizontal", "fov_vertical", "orientation_yaw", "orientation_pitch", "orientation_roll",
			// Documented/SDK naming
			"horizontal_fov", "vertical_fov", "horizontal_orientation", "vertical_orientation",
		}
		for _, field := range numericSensorFields {
			if val, ok := refMap[field]; ok && val != nil {
				num, ok := toFloat64(val)
				if !ok {
					result.AddError(fmt.Sprintf("sensor_refs[%d].%s: expected number", i, field))
				} else if math.IsNaN(num) || math.IsInf(num, 0) {
					result.AddError(fmt.Sprintf("sensor_refs[%d].%s: must be finite (not NaN or Inf)", i, field))
				}
			}
		}
	}

	return result
}

// ValidateCommunicationsComponent validates the communications component
func ValidateCommunicationsComponent(comms map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if linkState, ok := comms["link_state"]; ok && linkState != nil {
		str, ok := linkState.(string)
		if !ok {
			result.AddError("communications.link_state: expected string")
		} else {
			validStates := map[string]bool{
				"connected":    true,
				"disconnected": true,
				"degraded":     true,
				"unknown":      true,
			}
			if !validStates[str] {
				result.AddError("communications.link_state: must be one of connected, disconnected, degraded, unknown")
			}
		}
	}

	return result
}

// ValidateTaskQueueComponent validates the task_queue component
func ValidateTaskQueueComponent(queue map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if currentTask, ok := queue["current_task_id"]; ok && currentTask != nil {
		s, ok := currentTask.(string)
		if !ok {
			result.AddError("task_queue.current_task_id: expected string or null")
		} else if strings.TrimSpace(s) == "" {
			result.AddError("task_queue.current_task_id: must be non-empty when provided")
		}
	}

	if queued, ok := queue["queued_task_ids"]; ok && queued != nil {
		queuedArray, ok := queued.([]interface{})
		if !ok {
			result.AddError("task_queue.queued_task_ids: expected array of strings")
		} else {
			for i, taskID := range queuedArray {
				s, ok := taskID.(string)
				if !ok {
					result.AddError(fmt.Sprintf("task_queue.queued_task_ids[%d]: expected string", i))
					continue
				}
				if strings.TrimSpace(s) == "" {
					result.AddError(fmt.Sprintf("task_queue.queued_task_ids[%d]: must be non-empty", i))
				}
			}
		}
	}

	return result
}
