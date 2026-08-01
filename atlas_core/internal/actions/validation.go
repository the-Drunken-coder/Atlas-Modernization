package actions

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	// IDMaxLength is the maximum allowed length for resource IDs.
	IDMaxLength = 50

	entityTypeMaxLength    = 50
	entitySubtypeMaxLength = 50
	objectPathMaxLength    = 500
	objectContentMaxLength = 100
	objectTypeMaxLength    = 50
)

// validIDPattern matches alphanumeric characters, hyphens, underscores, and dots.
// This prevents injection attacks while allowing common ID formats (UUIDs, slugs, etc.).
var validIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// validAliasPattern matches alias format: alphanumeric start, then alphanumeric, spaces, hyphens, underscores, and dots.
var validAliasPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$`)

// ValidateResourceID validates that a resource ID is safe and well-formed.
// Returns a ValidationError if the ID is invalid.
func ValidateResourceID(id, resourceType string) error {
	if err := validateStringMaxLength(resourceType+"_id", id, IDMaxLength); err != nil {
		return err
	}
	id = strings.TrimSpace(id)

	if id == "" {
		return NewValidationError(resourceType + "_id is required")
	}

	if !validIDPattern.MatchString(id) {
		return NewValidationError(resourceType + "_id contains invalid characters (only alphanumeric, hyphens, underscores, and dots allowed, must start with alphanumeric)")
	}

	return nil
}

// ValidateEntityID validates an entity ID.
func ValidateEntityID(entityID string) error {
	return ValidateResourceID(entityID, "entity")
}

// ValidateTaskID validates a task ID.
func ValidateTaskID(taskID string) error {
	return ValidateResourceID(taskID, "task")
}

// ValidateObjectID validates an object ID.
func ValidateObjectID(objectID string) error {
	return ValidateResourceID(objectID, "object")
}

func validateStringMaxLength(field, value string, maxLength int) error {
	if utf8.RuneCountInString(value) > maxLength {
		return NewValidationError(fmt.Sprintf("%s must not exceed %d characters", field, maxLength))
	}
	return nil
}

// NormalizeAlias trims and validates an entity alias for storage/reuse.
func NormalizeAlias(alias string) (string, error) {
	if err := ValidateAlias(alias); err != nil {
		return "", err
	}
	return strings.TrimSpace(alias), nil
}

// ValidateAlias validates an entity alias (optional, but if provided must be safe).
func ValidateAlias(alias string) error {
	if err := validateStringMaxLength("alias", alias, 255); err != nil {
		return err
	}
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return nil // Alias is optional
	}

	// Alias can contain more characters than IDs, but still validate for safety
	// Allow alphanumeric, spaces, hyphens, underscores, dots
	if !validAliasPattern.MatchString(alias) {
		return NewValidationError("alias contains invalid characters")
	}

	return nil
}

// SanitizeID trims whitespace from an ID. Always call ValidateResourceID first.
func SanitizeID(id string) string {
	return strings.TrimSpace(id)
}
