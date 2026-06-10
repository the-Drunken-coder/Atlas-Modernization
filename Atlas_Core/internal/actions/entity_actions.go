// Package actions provides business logic operations for Atlas Core.
package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func isPromotedEntityExtraKey(key string) bool {
	switch key {
	case "type", "subtype", "alias", "components", "version":
		return true
	default:
		return false
	}
}

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

// NewObjectPreconditionFailedError indicates PATCH /objects was rejected due to stale If-Match.
func NewObjectPreconditionFailedError() *PreconditionFailedError {
	return &PreconditionFailedError{
		ActionError: ActionError{
			Message: "If-Match precondition failed for object",
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

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

// EntityActions handles entity business logic.
type EntityActions struct {
	pool *pgxpool.Pool
}

// NewEntityActions creates a new EntityActions instance.
func NewEntityActions(pool *pgxpool.Pool) *EntityActions {
	return &EntityActions{pool: pool}
}

// CreateEntityParams holds parameters for creating an entity.
type CreateEntityParams struct {
	EntityID    string
	EntityType  string
	Subtype     string
	Alias       *string
	Components  map[string]interface{}
	PublishedAt *time.Time
	UpdatedAt   *time.Time
	Extra       map[string]interface{}
}

// Create creates a new entity.
func (a *EntityActions) Create(ctx context.Context, params CreateEntityParams) (*models.Entity, error) {
	// Validate entity ID
	if err := ValidateEntityID(params.EntityID); err != nil {
		return nil, err
	}
	entityID := SanitizeID(params.EntityID)

	entityType := strings.TrimSpace(params.EntityType)
	if entityType == "" {
		return nil, NewValidationError("type is required for entity creation")
	}

	// Subtype is optional - trim if provided
	var subtype *string
	if params.Subtype != "" {
		s := strings.TrimSpace(params.Subtype)
		if s != "" {
			subtype = &s
		}
	}

	// Validate components
	if params.Components != nil {
		if err := ValidateEntityComponents(params.Components); err != nil {
			return nil, err
		}
	}

	// Build JSON payload: merge Extra first so typed PublishedAt/UpdatedAt override duplicate keys.
	jsonData := make(map[string]interface{})
	if params.Components != nil {
		jsonData["components"] = params.Components
	}
	if params.Extra != nil {
		for k, v := range params.Extra {
			if !isPromotedEntityExtraKey(k) {
				jsonData[k] = v
			}
		}
	}
	if params.PublishedAt != nil {
		jsonData["published_at"] = params.PublishedAt.Format(time.RFC3339)
	}
	if params.UpdatedAt != nil {
		jsonData["updated_at"] = params.UpdatedAt.Format(time.RFC3339)
	}
	if err := ValidateEntityBlob(jsonData); err != nil {
		return nil, err
	}

	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var alias *string
	if params.Alias != nil && strings.TrimSpace(*params.Alias) != "" {
		trimmed, err := NormalizeAlias(*params.Alias)
		if err != nil {
			return nil, err
		}
		alias = &trimmed
	}

	tx, err := beginChangeTx(ctx, a.pool, "entity create")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var entity models.Entity
	err = tx.QueryRow(ctx, `
		INSERT INTO entities (entity_id, type, subtype, alias, json)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING entity_id, type, subtype, alias, json, created_at, updated_at, version
	`, entityID, entityType, subtype, alias, jsonBytes).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
	)
	if err != nil {
		if isUniqueViolation(err) {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.ConstraintName == "entities_pkey" {
				return nil, NewEntityConflictError(entityID)
			}
			return nil, NewEntityUniqueConstraintError()
		}
		return nil, fmt.Errorf("failed to create entity: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit entity create transaction: %w", err)
	}

	return &entity, nil
}

// Get retrieves an entity by ID.
func (a *EntityActions) Get(ctx context.Context, entityID string) (*models.Entity, error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	var entity models.Entity
	err := a.pool.QueryRow(ctx, `
		SELECT entity_id, type, subtype, alias, json, created_at, updated_at, version
		FROM entities WHERE entity_id = $1
	`, entityID).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewEntityNotFoundError(entityID)
		}
		return nil, fmt.Errorf("failed to get entity: %w", err)
	}

	return &entity, nil
}

// GetByAlias retrieves an entity by alias.
func (a *EntityActions) GetByAlias(ctx context.Context, alias string) (*models.Entity, error) {
	normalized, err := NormalizeAlias(alias)
	if err != nil {
		return nil, err
	}
	if normalized == "" {
		return nil, NewValidationError("alias is required")
	}

	var entity models.Entity
	err = a.pool.QueryRow(ctx, `
		SELECT entity_id, type, subtype, alias, json, created_at, updated_at, version
		FROM entities WHERE alias = $1
	`, normalized).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewAliasNotFoundError(alias)
		}
		return nil, fmt.Errorf("failed to get entity by alias: %w", err)
	}

	return &entity, nil
}

// List retrieves entities with pagination.
func (a *EntityActions) List(ctx context.Context, limit int, cursor string) (*ListPage[*models.Entity], error) {
	limit = ClampListLimit(limit)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin entity list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read entity list snapshot timestamp: %w", err)
	}

	parsedCursor, err := parseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := continuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}
	entities, hasMore, err := queryEntities(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit entity list transaction: %w", err)
	}

	page := &ListPage[*models.Entity]{
		Items:   entities,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(entities) > 0 {
		last := entities[len(entities)-1]
		page.NextCursor, err = encodeRowCursor(last.CreatedAt, last.EntityID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode entity cursor: %w", err)
		}
	}
	return page, nil
}

// UpdateEntityParams holds parameters for updating an entity.
type UpdateEntityParams struct {
	EntityType *string
	Subtype    *string
	Alias      *string
	Components map[string]interface{}
	Extra      map[string]interface{}
}

// IsEmpty reports whether the PATCH carries no updatable fields.
func (p UpdateEntityParams) IsEmpty() bool {
	componentsEmpty := len(p.Components) == 0
	extraEmpty := len(p.Extra) == 0
	return p.EntityType == nil && p.Subtype == nil && p.Alias == nil && componentsEmpty && extraEmpty
}

// Update updates an entity.
func (a *EntityActions) Update(ctx context.Context, entityID string, params UpdateEntityParams) (*models.Entity, error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	if params.IsEmpty() {
		return a.Get(ctx, entityID)
	}

	// Begin transaction for atomic read-modify-write.
	tx, err := beginChangeTx(ctx, a.pool, "entity update")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Fetch existing entity with row lock
	var entity models.Entity
	err = tx.QueryRow(ctx, `
		SELECT entity_id, type, subtype, alias, json, created_at, updated_at, version
		FROM entities WHERE entity_id = $1
		FOR UPDATE
	`, entityID).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt, &entity.Version,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewEntityNotFoundError(entityID)
		}
		return nil, fmt.Errorf("failed to get entity: %w", err)
	}

	// Parse existing JSON
	var existingJSON map[string]interface{}
	if entity.JSON != nil {
		if err := json.Unmarshal(entity.JSON, &existingJSON); err != nil {
			return nil, fmt.Errorf("existing entity json is corrupt or invalid: %w", err)
		}
		if existingJSON == nil {
			existingJSON = make(map[string]interface{})
		}
	} else {
		existingJSON = make(map[string]interface{})
	}

	// Update type if provided
	newType := entity.Type
	if params.EntityType != nil {
		trimmed := strings.TrimSpace(*params.EntityType)
		if trimmed == "" {
			return nil, NewValidationError("entity_type cannot be empty")
		}
		newType = trimmed
	}

	// Update subtype if provided
	newSubtype := entity.Subtype
	if params.Subtype != nil {
		s := strings.TrimSpace(*params.Subtype)
		if s == "" {
			newSubtype = nil
		} else {
			newSubtype = &s
		}
	}

	// Update alias if provided
	newAlias := entity.Alias
	if params.Alias != nil {
		s, err := NormalizeAlias(*params.Alias)
		if err != nil {
			return nil, err
		}
		if s == "" {
			newAlias = nil
		} else {
			newAlias = &s
		}
	}

	// Validate and merge components
	if params.Components != nil {
		if err := ValidateEntityComponents(params.Components); err != nil {
			return nil, err
		}

		var existingComponents map[string]interface{}
		rawStored, hadStored := existingJSON["components"]
		if hadStored && rawStored != nil {
			storedMap, ok := rawStored.(map[string]interface{})
			if !ok {
				return nil, NewValidationError("stored entity components must be an object or null")
			}
			existingComponents = storedMap
		} else {
			existingComponents = make(map[string]interface{})
		}
		for k, v := range params.Components {
			existingComponents[k] = mergeJSONValue(existingComponents[k], v)
		}
		if err := ValidateEntityComponents(existingComponents); err != nil {
			return nil, err
		}
		existingJSON["components"] = existingComponents
	}

	// Merge extra
	if params.Extra != nil {
		for k, v := range params.Extra {
			if !isPromotedEntityExtraKey(k) {
				existingJSON[k] = v
			}
		}
	}
	if err := ValidateEntityBlob(existingJSON); err != nil {
		return nil, err
	}

	jsonBytes, err := json.Marshal(existingJSON)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var out models.Entity
	err = tx.QueryRow(ctx, `
		UPDATE entities
		SET type = $1, subtype = $2, alias = $3, json = $4,
			updated_at = clock_timestamp(),
			version = nextval('atlas_change_version_seq')
		WHERE entity_id = $5
		RETURNING entity_id, type, subtype, alias, json, created_at, updated_at, version
	`, newType, newSubtype, newAlias, jsonBytes, entityID).Scan(
		&out.EntityID, &out.Type, &out.Subtype, &out.Alias,
		&out.JSON, &out.CreatedAt, &out.UpdatedAt, &out.Version,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, NewEntityUniqueConstraintError()
		}
		return nil, fmt.Errorf("failed to update entity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return &out, nil
}

// mergeJSONValue deep-merges nested map[string]interface{} values (recursive key merge).
// Non-map values—including slices and scalars—are replaced entirely by the incoming value.
func mergeJSONValue(existing, incoming interface{}) interface{} {
	existingMap, existingOK := existing.(map[string]interface{})
	incomingMap, incomingOK := incoming.(map[string]interface{})
	if !existingOK || !incomingOK {
		return incoming
	}

	merged := make(map[string]interface{}, len(existingMap))
	for k, v := range existingMap {
		merged[k] = v
	}
	for k, v := range incomingMap {
		merged[k] = mergeJSONValue(merged[k], v)
	}

	return merged
}

// Delete removes an entity.
func (a *EntityActions) Delete(ctx context.Context, entityID string) error {
	if err := ValidateEntityID(entityID); err != nil {
		return err
	}
	entityID = SanitizeID(entityID)

	tx, err := beginChangeTx(ctx, a.pool, "entity delete")
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	if _, err := tx.Exec(ctx, `
		UPDATE tasks
		SET updated_at = clock_timestamp(),
			version = nextval('atlas_change_version_seq')
		WHERE entity_id = $1
	`, entityID); err != nil {
		return fmt.Errorf("failed to mark entity tasks changed before deletion: %w", err)
	}

	result, err := tx.Exec(ctx, "DELETE FROM entities WHERE entity_id = $1", entityID)
	if err != nil {
		return fmt.Errorf("failed to delete entity: %w", err)
	}

	if result.RowsAffected() == 0 {
		return NewEntityNotFoundError(entityID)
	}

	// Record tombstone so changed-since can notify clients
	if _, err := tx.Exec(ctx,
		"INSERT INTO deletions (resource_type, resource_id) VALUES ('entity', $1)", entityID); err != nil {
		return fmt.Errorf("failed to record entity deletion tombstone: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit delete transaction: %w", err)
	}

	return nil
}

// Count returns the total number of entities.
func (a *EntityActions) Count(ctx context.Context) (int, error) {
	var count int
	err := a.pool.QueryRow(ctx, "SELECT COUNT(*) FROM entities").Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count entities: %w", err)
	}
	return count, nil
}
