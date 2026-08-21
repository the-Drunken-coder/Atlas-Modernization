package actions

import (
	"fmt"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// ValidationResult holds multiple validation errors
type ValidationResult struct {
	Errors []string
}

func (vr *ValidationResult) HasErrors() bool {
	return len(vr.Errors) > 0
}

func validationResultFromErrors(errors []string) *ValidationResult {
	result := &ValidationResult{}
	result.Errors = append(result.Errors, errors...)
	return result
}

// NewValidationErrorWithDetails creates a validation error with multiple error details.
func NewValidationErrorWithDetails(message string, details []string) *ValidationError {
	return &ValidationError{
		ActionError: ActionError{
			Message: message,
			Code:    protocol.ErrorCodeValidationError,
		},
		Details: details,
	}
}

// ValidateEntityComponents validates all components for an entity
func ValidateEntityComponents(components map[string]interface{}) error {
	if components == nil {
		return nil
	}

	result := validationResultFromErrors(protocol.ValidateEntityComponents(components))

	if result.HasErrors() {
		return NewValidationErrorWithDetails(
			fmt.Sprintf("Component validation failed (%d errors)", len(result.Errors)),
			result.Errors,
		)
	}

	return nil
}

// ValidateEntityBlob validates the full entity JSON blob that will be stored.
func ValidateEntityBlob(blob map[string]interface{}) error {
	if blob == nil {
		return nil
	}
	result := validationResultFromErrors(protocol.ValidateEntityBlob(blob))
	if !result.HasErrors() {
		return nil
	}
	return NewValidationErrorWithDetails(
		fmt.Sprintf("Entity validation failed (%d errors)", len(result.Errors)),
		result.Errors,
	)
}
