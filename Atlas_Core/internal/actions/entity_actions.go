// Package actions provides business logic operations for Atlas Core.
package actions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// EntityActions handles entity business logic.
type EntityActions struct {
	pool       *pgxpool.Pool
	changeSink ChangeSink
}

// NewEntityActions creates a new EntityActions instance.
func NewEntityActions(pool *pgxpool.Pool) *EntityActions {
	return NewEntityActionsWithChangeSink(pool, nil)
}

// NewEntityActionsWithChangeSink creates a new EntityActions instance that
// emits committed changes to sink.
func NewEntityActionsWithChangeSink(pool *pgxpool.Pool, sink ChangeSink) *EntityActions {
	return &EntityActions{pool: pool, changeSink: sink}
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
		jsonData[string(jsonBlobFieldComponents)] = params.Components
	}
	mergeBlobExtraFields(jsonData, params.Extra, entityPromotedBlobFields)
	if params.PublishedAt != nil {
		jsonData["published_at"] = params.PublishedAt.Format(time.RFC3339)
	}
	if params.UpdatedAt != nil {
		jsonData["updated_at"] = params.UpdatedAt.Format(time.RFC3339)
	}
	jsonBytes, err := marshalValidatedJSONBlob(jsonData, ValidateEntityBlob)
	if err != nil {
		return nil, err
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

	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventCreate,
		ResourceType: ChangeResourceEntity,
		ID:           entity.EntityID,
		Version:      entity.Version,
		AfterEntity:  cloneEntityModel(&entity),
	})

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
	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.Entity]{
		limit:       limit,
		cursor:      cursor,
		cursorLabel: "cursor",
		operation:   "entity list",
		cursorName:  "entity",
		query: func(ctx context.Context, tx pgx.Tx, snapshotUpperBound time.Time, continuation bool, parsedCursor *parsedQueryCursor, limit int) ([]*models.Entity, bool, error) {
			return queryEntities(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit, 0)
		},
		rowCursor: func(entity *models.Entity) (time.Time, string) {
			return entity.CreatedAt, entity.EntityID
		},
	})
}

// UpdateEntityParams holds parameters for updating an entity.
type UpdateEntityParams struct {
	EntityType      *string
	Subtype         *string
	Alias           *string
	Components      map[string]interface{}
	Extra           map[string]interface{}
	ExpectedVersion *int64
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

	if params.IsEmpty() && params.ExpectedVersion == nil {
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
	if err := checkExpectedVersion("entity", params.ExpectedVersion, entity.Version); err != nil {
		return nil, err
	}
	before := cloneEntityModel(&entity)
	if params.IsEmpty() {
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("failed to commit entity precondition transaction: %w", err)
		}
		return &entity, nil
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

	jsonBytes, err := patchValidatedJSONBlob(jsonBlobPatch{
		rawMessage:      entity.JSON,
		decodeMode:      jsonBlobDecodeDefault,
		decodeError:     "existing entity json is corrupt or invalid",
		components:      params.Components,
		mergeComponents: mergeEntityComponents,
		extra:           params.Extra,
		promotedFields:  entityPromotedBlobFields,
		validate:        ValidateEntityBlob,
	})
	if err != nil {
		return nil, err
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

	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceEntity,
		ID:           out.EntityID,
		Version:      out.Version,
		BeforeEntity: before,
		AfterEntity:  cloneEntityModel(&out),
	})

	return &out, nil
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
			return NewEntityNotFoundError(entityID)
		}
		return fmt.Errorf("failed to get entity for deletion: %w", err)
	}

	beforeTasks, err := queryTasksByEntityForUpdate(ctx, tx, entityID)
	if err != nil {
		return err
	}

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

	var tombstoneVersion int64
	if err := tx.QueryRow(ctx,
		"INSERT INTO deletions (resource_type, resource_id, context) VALUES ($1, $2, '{}'::jsonb) RETURNING version",
		ChangeResourceEntity, entityID,
	).Scan(&tombstoneVersion); err != nil {
		return fmt.Errorf("failed to record entity deletion tombstone: %w", err)
	}

	afterTasks, err := queryTasksByIDs(ctx, tx, taskIDs(beforeTasks))
	if err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit delete transaction: %w", err)
	}

	for _, beforeTask := range beforeTasks {
		afterTask := afterTasks[beforeTask.TaskID]
		if afterTask == nil {
			continue
		}
		publishChange(a.changeSink, ResourceChange{
			Event:        ChangeEventUpdate,
			ResourceType: ChangeResourceTask,
			ID:           afterTask.TaskID,
			Version:      afterTask.Version,
			BeforeTask:   cloneTaskModel(beforeTask),
			AfterTask:    cloneTaskModel(afterTask),
		})
	}
	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventDelete,
		ResourceType: ChangeResourceEntity,
		ID:           entity.EntityID,
		Version:      tombstoneVersion,
		BeforeEntity: cloneEntityModel(&entity),
	})

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
