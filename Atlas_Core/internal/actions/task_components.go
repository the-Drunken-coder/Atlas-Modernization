package actions

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// ValidateCommandComponent validates the command component for tasks
func ValidateCommandComponent(command map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if cmdType, ok := command["type"]; ok {
		str, ok := cmdType.(string)
		if !ok {
			result.AddError("command.type: expected string")
		} else if strings.TrimSpace(str) == "" {
			result.AddError("command.type: must be non-empty")
		}
	} else {
		result.AddError("command: missing required field 'type'")
	}

	return result
}

// ValidateTaskParametersComponent validates lat/long fields under the given path prefix
// (e.g. "parameters." for the parameters component, "target." for the target component).
func ValidateTaskParametersComponent(params map[string]interface{}, fieldPrefix string) *ValidationResult {
	result := &ValidationResult{}

	if lat, ok := params["latitude"]; ok && lat != nil {
		num, ok := toFloat64(lat)
		if !ok {
			result.AddError(fieldPrefix + "latitude: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError(fieldPrefix + "latitude: must be finite (not NaN or Inf)")
		} else if num < -90 || num > 90 {
			result.AddError(fmt.Sprintf(fieldPrefix+"latitude: %.6f is out of range [-90, 90]", num))
		}
	}

	if lng, ok := params["longitude"]; ok && lng != nil {
		num, ok := toFloat64(lng)
		if !ok {
			result.AddError(fieldPrefix + "longitude: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError(fieldPrefix + "longitude: must be finite (not NaN or Inf)")
		} else if num < -180 || num > 180 {
			result.AddError(fmt.Sprintf(fieldPrefix+"longitude: %.6f is out of range [-180, 180]", num))
		}
	}

	return result
}

// ValidateTaskProgressComponent validates the progress component for tasks
func ValidateTaskProgressComponent(progress map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if percent, ok := progress["percent"]; ok && percent != nil {
		num, ok := toFloat64(percent)
		if !ok {
			result.AddError("progress.percent: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("progress.percent: must be finite (not NaN or Inf)")
		} else if num < 0 || num > 100 {
			result.AddError(fmt.Sprintf("progress.percent: %.6f is out of range [0, 100]", num))
		}
	}

	if updatedAt, ok := progress["updated_at"]; ok && updatedAt != nil {
		str, ok := updatedAt.(string)
		if !ok {
			result.AddError("progress.updated_at: expected string (RFC3339 timestamp)")
		} else {
			if _, err := time.Parse(time.RFC3339, str); err != nil {
				result.AddError(fmt.Sprintf("progress.updated_at: invalid RFC3339 timestamp: %s", err))
			}
		}
	}

	return result
}
