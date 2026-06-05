package actions

import (
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// ValidateTelemetryComponent validates the telemetry component
func ValidateTelemetryComponent(telemetry map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateTelemetryComponent(telemetry))
}

// ValidateHealthComponent validates the health component
func ValidateHealthComponent(health map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateHealthComponent(health))
}

// ValidateMilViewComponent validates the mil_view component
func ValidateMilViewComponent(milView map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateMilViewComponent(milView))
}

// ValidateTaskCatalogComponent validates the task_catalog component
func ValidateTaskCatalogComponent(catalog map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateTaskCatalogComponent(catalog))
}

// ValidateMediaRefsComponent validates the media_refs component
func ValidateMediaRefsComponent(refs interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateMediaRefsComponent(refs))
}

// ValidateSensorRefsComponent validates the sensor_refs component
func ValidateSensorRefsComponent(refs interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateSensorRefsComponent(refs))
}

// ValidateCommunicationsComponent validates the communications component
func ValidateCommunicationsComponent(comms map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateCommunicationsComponent(comms))
}

// ValidateTaskQueueComponent validates the task_queue component
func ValidateTaskQueueComponent(queue map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateTaskQueueComponent(queue))
}
