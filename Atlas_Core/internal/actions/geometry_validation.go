package actions

import protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"

// ValidateGeometryComponent validates the geometry component.
func ValidateGeometryComponent(geometry map[string]interface{}) *ValidationResult {
	return validationResultFromErrors(protocol.ValidateGeometryComponent(geometry))
}
