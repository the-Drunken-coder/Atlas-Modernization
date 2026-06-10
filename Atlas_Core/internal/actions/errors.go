// Package actions holds the shared building blocks for Atlas Core's action
// layer: error types, validation wrappers, cursor pagination, and write
// transaction helpers. Resource-specific business logic lives in the
// entityactions, taskactions, objectactions, and syncactions subpackages,
// which depend only on this package.
package actions

import (
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// ActionError is a base error for action operations.
type ActionError struct {
	Message string
	Code    string
}

func (e *ActionError) Error() string {
	return e.Message
}

// ValidationError is returned when input validation fails.
type ValidationError struct {
	ActionError
	Details []string // Field-level validation errors
}

// NotFoundError is returned when a resource is not found.
type NotFoundError struct {
	ActionError
	ResourceType string
	ResourceID   string
}

// NewValidationError creates a new validation error.
func NewValidationError(message string) *ValidationError {
	return &ValidationError{
		ActionError: ActionError{Message: message, Code: "VALIDATION_ERROR"},
	}
}

// NewValidationErrorWithDetails creates a validation error with multiple error details.
func NewValidationErrorWithDetails(message string, details []string) *ValidationError {
	return &ValidationError{
		ActionError: ActionError{Message: message, Code: "VALIDATION_ERROR"},
		Details:     details,
	}
}

// NewEntityNotFoundError creates an entity not found error.
func NewEntityNotFoundError(entityID string) *NotFoundError {
	return &NotFoundError{
		ActionError:  ActionError{Message: fmt.Sprintf("Entity '%s' was not found", entityID), Code: "ENTITY_NOT_FOUND"},
		ResourceType: "entity",
		ResourceID:   entityID,
	}
}

// NewAliasNotFoundError is returned when no entity exists for the given alias.
func NewAliasNotFoundError(alias string) *NotFoundError {
	return &NotFoundError{
		ActionError:  ActionError{Message: fmt.Sprintf("No entity was found for alias '%s'", alias), Code: "ENTITY_ALIAS_NOT_FOUND"},
		ResourceType: "entity",
		ResourceID:   alias,
	}
}

// NewTaskNotFoundError creates a task not found error.
func NewTaskNotFoundError(taskID string) *NotFoundError {
	return &NotFoundError{
		ActionError:  ActionError{Message: fmt.Sprintf("Task '%s' was not found", taskID), Code: "TASK_NOT_FOUND"},
		ResourceType: "task",
		ResourceID:   taskID,
	}
}

// NewObjectNotFoundError creates an object not found error.
func NewObjectNotFoundError(objectID string) *NotFoundError {
	return &NotFoundError{
		ActionError:  ActionError{Message: fmt.Sprintf("Object '%s' was not found", objectID), Code: "OBJECT_NOT_FOUND"},
		ResourceType: "object",
		ResourceID:   objectID,
	}
}

// PreconditionFailedError is returned when If-Match does not match the current resource.
type PreconditionFailedError struct {
	ActionError
}

// NewPreconditionFailedError indicates a write was rejected due to stale If-Match.
func NewPreconditionFailedError(resourceType string) *PreconditionFailedError {
	return &PreconditionFailedError{
		ActionError: ActionError{
			Message: fmt.Sprintf("If-Match precondition failed for %s", resourceType),
			Code:    "PRECONDITION_FAILED",
		},
	}
}

// ConflictError is returned when a create or update violates a unique constraint.
type ConflictError struct {
	ActionError
}

// NewEntityConflictError reports a duplicate entity id on insert.
func NewEntityConflictError(entityID string) *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: fmt.Sprintf("An entity with id '%s' already exists", entityID),
			Code:    "ENTITY_ALREADY_EXISTS",
		},
	}
}

// NewEntityUniqueConstraintError reports a unique constraint violation on create or update (e.g. duplicate alias).
func NewEntityUniqueConstraintError() *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: "Entity conflicts with an existing unique value",
			Code:    "ENTITY_ALREADY_EXISTS",
		},
	}
}

// NewTaskConflictError reports a duplicate task id on insert.
func NewTaskConflictError(taskID string) *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: fmt.Sprintf("A task with id '%s' already exists", taskID),
			Code:    "TASK_ALREADY_EXISTS",
		},
	}
}

// NewObjectConflictError reports a duplicate object id on insert.
func NewObjectConflictError(objectID string) *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: fmt.Sprintf("An object with id '%s' already exists", objectID),
			Code:    "OBJECT_ALREADY_EXISTS",
		},
	}
}

// NewObjectPathConflictError reports a duplicate object storage path.
func NewObjectPathConflictError() *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: "Object path conflicts with an existing object",
			Code:    "OBJECT_PATH_CONFLICT",
		},
	}
}

// IsUniqueViolation reports whether err is a PostgreSQL unique-constraint violation.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// IsForeignKeyViolation reports whether err is a PostgreSQL foreign-key violation.
func IsForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}
