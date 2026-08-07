package actions

import (
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
)

// ActionError is a base error for action operations.
type ActionError struct {
	Message string
	Code    protocol.ErrorCode
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
	ResourceType ChangeResource
	ResourceID   string
}

// NewValidationError creates a new validation error.
func NewValidationError(message string) *ValidationError {
	return &ValidationError{
		ActionError: ActionError{Message: message, Code: protocol.ErrorCodeValidationError},
	}
}

// NewEntityNotFoundError creates an entity not found error.
func NewEntityNotFoundError(entityID string) *NotFoundError {
	return &NotFoundError{
		ActionError:  ActionError{Message: fmt.Sprintf("Entity '%s' was not found", entityID), Code: protocol.ErrorCodeEntityNotFound},
		ResourceType: ChangeResourceEntity,
		ResourceID:   entityID,
	}
}

// NewAliasNotFoundError is returned when no entity exists for the given alias.
func NewAliasNotFoundError(alias string) *NotFoundError {
	return &NotFoundError{
		ActionError:  ActionError{Message: fmt.Sprintf("No entity was found for alias '%s'", alias), Code: protocol.ErrorCodeEntityAliasNotFound},
		ResourceType: ChangeResourceEntity,
		ResourceID:   alias,
	}
}

// NewTaskNotFoundError creates a task not found error.
func NewTaskNotFoundError(taskID string) *NotFoundError {
	return &NotFoundError{
		ActionError:  ActionError{Message: fmt.Sprintf("Task '%s' was not found", taskID), Code: protocol.ErrorCodeTaskNotFound},
		ResourceType: ChangeResourceTask,
		ResourceID:   taskID,
	}
}

// NewObjectNotFoundError creates an object not found error.
func NewObjectNotFoundError(objectID string) *NotFoundError {
	return &NotFoundError{
		ActionError:  ActionError{Message: fmt.Sprintf("Object '%s' was not found", objectID), Code: protocol.ErrorCodeObjectNotFound},
		ResourceType: ChangeResourceObject,
		ResourceID:   objectID,
	}
}

// PreconditionFailedError is returned when If-Match does not match the current resource.
type PreconditionFailedError struct {
	ActionError
}

// CursorExpiredError is returned when changed-since history no longer covers a
// client's cursor and the client must perform a full hydration.
type CursorExpiredError struct {
	ActionError
	MinRetainedVersion int64
}

// NewCursorExpiredError reports the earliest changed-since cursor still
// covered by the bounded recovery log.
func NewCursorExpiredError(minRetainedVersion int64) *CursorExpiredError {
	return &CursorExpiredError{
		ActionError: ActionError{
			Message: "Changed-since cursor has expired; perform a full hydration",
			Code:    protocol.ErrorCodeCursorExpired,
		},
		MinRetainedVersion: minRetainedVersion,
	}
}

// NewPreconditionFailedError indicates a write was rejected due to stale If-Match.
func NewPreconditionFailedError(resourceType string) *PreconditionFailedError {
	resourceType = strings.TrimSpace(resourceType)
	if resourceType == "" {
		resourceType = "resource"
	}
	return &PreconditionFailedError{
		ActionError: ActionError{
			Message: fmt.Sprintf("If-Match precondition failed for %s", resourceType),
			Code:    protocol.ErrorCodePreconditionFailed,
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
			Code:    protocol.ErrorCodeEntityAlreadyExists,
		},
	}
}

// NewEntityUniqueConstraintError reports a unique constraint violation on create or update (e.g. duplicate alias).
func NewEntityUniqueConstraintError() *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: "Entity conflicts with an existing unique value",
			Code:    protocol.ErrorCodeEntityAlreadyExists,
		},
	}
}

// NewTaskConflictError reports a duplicate task id on insert.
func NewTaskConflictError(taskID string) *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: fmt.Sprintf("A task with id '%s' already exists", taskID),
			Code:    protocol.ErrorCodeTaskAlreadyExists,
		},
	}
}

// NewObjectConflictError reports a duplicate object id on insert.
func NewObjectConflictError(objectID string) *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: fmt.Sprintf("An object with id '%s' already exists", objectID),
			Code:    protocol.ErrorCodeObjectAlreadyExists,
		},
	}
}

// NewObjectPathConflictError reports a duplicate object storage path.
func NewObjectPathConflictError() *ConflictError {
	return &ConflictError{
		ActionError: ActionError{
			Message: "Object path conflicts with an existing object",
			Code:    protocol.ErrorCodeObjectPathConflict,
		},
	}
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}
