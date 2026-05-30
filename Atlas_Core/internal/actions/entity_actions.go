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
	"github.com/the-drunken-coder/atlas/atlas_core/internal/serializers"
)

func isPromotedEntityExtraKey(key string) bool {
	switch key {
	case "type", "subtype", "alias", "components":
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
func (a *EntityActions) Create(ctx context.Context, params CreateEntityParams) (*serializers.EntityResponse, error) {
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

	var entity models.Entity
	err = a.pool.QueryRow(ctx, `
		INSERT INTO entities (entity_id, type, subtype, alias, json)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING entity_id, type, subtype, alias, json, created_at, updated_at
	`, entityID, entityType, subtype, alias, jsonBytes).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt,
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

	return serializers.SerializeEntity(&entity), nil
}

// Get retrieves an entity by ID.
func (a *EntityActions) Get(ctx context.Context, entityID string) (*serializers.EntityResponse, error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	var entity models.Entity
	err := a.pool.QueryRow(ctx, `
		SELECT entity_id, type, subtype, alias, json, created_at, updated_at
		FROM entities WHERE entity_id = $1
	`, entityID).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewEntityNotFoundError(entityID)
		}
		return nil, fmt.Errorf("failed to get entity: %w", err)
	}

	return serializers.SerializeEntity(&entity), nil
}

// GetByAlias retrieves an entity by alias.
func (a *EntityActions) GetByAlias(ctx context.Context, alias string) (*serializers.EntityResponse, error) {
	normalized, err := NormalizeAlias(alias)
	if err != nil {
		return nil, err
	}
	if normalized == "" {
		return nil, NewValidationError("alias is required")
	}

	var entity models.Entity
	err = a.pool.QueryRow(ctx, `
		SELECT entity_id, type, subtype, alias, json, created_at, updated_at
		FROM entities WHERE alias = $1
	`, normalized).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewAliasNotFoundError(alias)
		}
		return nil, fmt.Errorf("failed to get entity by alias: %w", err)
	}

	return serializers.SerializeEntity(&entity), nil
}

// List retrieves entities with pagination.
func (a *EntityActions) List(ctx context.Context, limit, offset int) ([]*serializers.EntityResponse, int, error) {
	limit = ClampListLimit(limit)
	if offset < 0 {
		offset = 0
	}

	// Get entities with total count using window function (single query)
	rows, err := a.pool.Query(ctx, `
		SELECT entity_id, type, subtype, alias, json, created_at, updated_at,
		       COUNT(*) OVER() as total_count
		FROM entities
		ORDER BY created_at DESC, entity_id DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list entities: %w", err)
	}
	defer rows.Close()

	var total int
	var entities []*models.Entity
	for rows.Next() {
		var e models.Entity
		if err := rows.Scan(&e.EntityID, &e.Type, &e.Subtype, &e.Alias, &e.JSON, &e.CreatedAt, &e.UpdatedAt, &total); err != nil {
			return nil, 0, fmt.Errorf("failed to scan entity: %w", err)
		}
		entities = append(entities, &e)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("failed to iterate entities: %w", err)
	}

	if len(entities) == 0 {
		if err := a.pool.QueryRow(ctx, `SELECT COUNT(*) FROM entities`).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("failed to count entities: %w", err)
		}
	}

	return serializers.SerializeEntities(entities), total, nil
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
func (a *EntityActions) Update(ctx context.Context, entityID string, params UpdateEntityParams) (*serializers.EntityResponse, error) {
	if err := ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = SanitizeID(entityID)

	if params.IsEmpty() {
		return a.Get(ctx, entityID)
	}

	// Begin transaction for atomic read-modify-write
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Fetch existing entity with row lock
	var entity models.Entity
	err = tx.QueryRow(ctx, `
		SELECT entity_id, type, subtype, alias, json, created_at, updated_at
		FROM entities WHERE entity_id = $1
		FOR UPDATE
	`, entityID).Scan(
		&entity.EntityID, &entity.Type, &entity.Subtype, &entity.Alias,
		&entity.JSON, &entity.CreatedAt, &entity.UpdatedAt,
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
		normalizeLegacyEntityComponents(existingComponents)
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

	jsonBytes, err := json.Marshal(existingJSON)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var out models.Entity
	err = tx.QueryRow(ctx, `
		UPDATE entities SET type = $1, subtype = $2, alias = $3, json = $4, updated_at = CURRENT_TIMESTAMP
		WHERE entity_id = $5
		RETURNING entity_id, type, subtype, alias, json, created_at, updated_at
	`, newType, newSubtype, newAlias, jsonBytes, entityID).Scan(
		&out.EntityID, &out.Type, &out.Subtype, &out.Alias,
		&out.JSON, &out.CreatedAt, &out.UpdatedAt,
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

	return serializers.SerializeEntity(&out), nil
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

func normalizeLegacyEntityComponents(components map[string]interface{}) {
	rawStatus, hasStatus := components["status"]
	if hasStatus {
		if _, ok := rawStatus.(map[string]interface{}); !ok {
			if statusText, ok := rawStatus.(string); ok {
				statusText = strings.TrimSpace(statusText)
				if statusText != "" {
					components["status"] = map[string]interface{}{"value": statusText}
				} else {
					delete(components, "status")
				}
			}
			// Non-string legacy values: leave unchanged so validation can fail loudly.
		}
	}

	rawHeartbeat, hasHeartbeat := components["heartbeat"]
	if hasHeartbeat {
		if _, ok := rawHeartbeat.(map[string]interface{}); !ok {
			if lastSeen, ok := rawHeartbeat.(string); ok {
				lastSeen = strings.TrimSpace(lastSeen)
				if lastSeen != "" {
					components["heartbeat"] = map[string]interface{}{"last_seen": lastSeen}
				} else {
					delete(components, "heartbeat")
				}
			}
		}
	}
}

// Delete removes an entity.
func (a *EntityActions) Delete(ctx context.Context, entityID string) error {
	if err := ValidateEntityID(entityID); err != nil {
		return err
	}
	entityID = SanitizeID(entityID)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("failed to begin delete transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

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
