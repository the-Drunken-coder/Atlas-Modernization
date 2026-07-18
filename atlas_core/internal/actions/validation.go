package actions

import (
	"fmt"
	"regexp"
	"strings"
)

// IDMaxLength is the maximum allowed length for resource IDs.
const IDMaxLength = 50

// validIDPattern matches alphanumeric characters, hyphens, underscores, and dots.
// This prevents injection attacks while allowing common ID formats (UUIDs, slugs, etc.).
var validIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// validAliasPattern matches alias format: alphanumeric start, then alphanumeric, spaces, hyphens, underscores, and dots.
var validAliasPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$`)

// ValidateResourceID validates that a resource ID is safe and well-formed.
// Returns a ValidationError if the ID is invalid.
func ValidateResourceID(id, resourceType string) error {
	id = strings.TrimSpace(id)

	if id == "" {
		return NewValidationError(resourceType + "_id is required")
	}

	if len(id) > IDMaxLength {
		return NewValidationError(fmt.Sprintf("%s_id must not exceed %d characters", resourceType, IDMaxLength))
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

// NormalizeAlias trims and validates an entity alias for storage/reuse.
func NormalizeAlias(alias string) (string, error) {
	alias = strings.TrimSpace(alias)
	if err := ValidateAlias(alias); err != nil {
		return "", err
	}
	return alias, nil
}

// ValidateAlias validates an entity alias (optional, but if provided must be safe).
func ValidateAlias(alias string) error {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return nil // Alias is optional
	}

	if len(alias) > 255 {
		return NewValidationError("alias must not exceed 255 characters")
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
