package actions

import (
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// ValidateCommandComponent validates the command component for tasks
func ValidateCommandComponent(command map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateCommandComponent(command))
}

// ValidateTaskParametersComponent validates lat/long fields under the given path prefix
// (e.g. "parameters." for the parameters component, "target." for the target component).
func ValidateTaskParametersComponent(params map[string]interface{}, fieldPrefix string) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateTaskParametersComponent(params, fieldPrefix))
}

// ValidateTaskProgressComponent validates the progress component for tasks
func ValidateTaskProgressComponent(progress map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateTaskProgressComponent(progress))
}
