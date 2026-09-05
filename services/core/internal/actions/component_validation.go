package actions

import (
	"fmt"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

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

	validationErrors := protocol.ValidateEntityComponents(components)

	if len(validationErrors) > 0 {
		return NewValidationErrorWithDetails(
			fmt.Sprintf("Component validation failed (%d errors)", len(validationErrors)),
			validationErrors,
		)
	}

	return nil
}

// ValidateEntityBlob validates the full entity JSON blob that will be stored.
func ValidateEntityBlob(blob map[string]interface{}) error {
	if blob == nil {
		return nil
	}
	validationErrors := protocol.ValidateEntityBlob(blob)
	if len(validationErrors) == 0 {
		return nil
	}
	return NewValidationErrorWithDetails(
		fmt.Sprintf("Entity validation failed (%d errors)", len(validationErrors)),
		validationErrors,
	)
}
