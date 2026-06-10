package actions

import (
	"fmt"
	"strings"

	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

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
			Code:    "VALIDATION_ERROR",
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

// ValidateTaskComponents validates all components for a task
func ValidateTaskComponents(components map[string]interface{}) error {
	if components == nil {
		return nil
	}

	result := validationResultFromErrors(protocol.ValidateTaskComponents(components))

	if result.HasErrors() {
		return NewValidationErrorWithDetails(
			fmt.Sprintf("Component validation failed (%d errors)", len(result.Errors)),
			result.Errors,
		)
	}

	return nil
}

// ValidateTaskBlob validates the full task JSON blob that will be stored.
func ValidateTaskBlob(blob map[string]interface{}) error {
	if blob == nil {
		return nil
	}
	result := validationResultFromErrors(protocol.ValidateTaskBlob(blob))
	if !result.HasErrors() {
		return nil
	}
	return NewValidationErrorWithDetails(
		fmt.Sprintf("Task validation failed (%d errors)", len(result.Errors)),
		result.Errors,
	)
}
