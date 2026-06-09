// Package entityactions provides entity CRUD and check-in business logic.
package entityactions

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
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
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

// Actions handles entity business logic.
type Actions struct {
	pool *pgxpool.Pool
}

// New creates a new entity Actions instance.
func New(pool *pgxpool.Pool) *Actions {
	return &Actions{pool: pool}
}

// CreateParams holds parameters for creating an entity.
type CreateParams struct {
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
func (a *Actions) Create(ctx context.Context, params CreateParams) (*models.Entity, error) {
	// Validate entity ID
	if err := actions.ValidateEntityID(params.EntityID); err != nil {
		return nil, err
	}
	entityID := actions.SanitizeID(params.EntityID)

	entityType := strings.TrimSpace(params.EntityType)
	if entityType == "" {
		return nil, actions.NewValidationError("type is required for entity creation")
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
		if err := actions.ValidateEntityComponents(params.Components); err != nil {
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
	if err := actions.ValidateEntityBlob(jsonData); err != nil {
		return nil, err
	}

	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var alias *string
	if params.Alias != nil && strings.TrimSpace(*params.Alias) != "" {
		trimmed, err := actions.NormalizeAlias(*params.Alias)
		if err != nil {
			return nil, err
		}
		alias = &trimmed
	}

	tx, err := actions.BeginChangeTx(ctx, a.pool, "entity create")
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
		if actions.IsUniqueViolation(err) {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.ConstraintName == "entities_pkey" {
				return nil, actions.NewEntityConflictError(entityID)
			}
			return nil, actions.NewEntityUniqueConstraintError()
		}
		return nil, fmt.Errorf("failed to create entity: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit entity create transaction: %w", err)
	}

	return &entity, nil
}

// Get retrieves an entity by ID.
func (a *Actions) Get(ctx context.Context, entityID string) (*models.Entity, error) {
	if err := actions.ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = actions.SanitizeID(entityID)

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
			return nil, actions.NewEntityNotFoundError(entityID)
		}
		return nil, fmt.Errorf("failed to get entity: %w", err)
	}

	return &entity, nil
}

// GetByAlias retrieves an entity by alias.
func (a *Actions) GetByAlias(ctx context.Context, alias string) (*models.Entity, error) {
	normalized, err := actions.NormalizeAlias(alias)
	if err != nil {
		return nil, err
	}
	if normalized == "" {
		return nil, actions.NewValidationError("alias is required")
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
			return nil, actions.NewAliasNotFoundError(alias)
		}
		return nil, fmt.Errorf("failed to get entity by alias: %w", err)
	}

	return &entity, nil
}

// List retrieves entities with pagination.
func (a *Actions) List(ctx context.Context, limit int, cursor string) (*actions.ListPage[*models.Entity], error) {
	limit = actions.ClampListLimit(limit)

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

	parsedCursor, err := actions.ParseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := actions.ContinuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}
	entities, hasMore, err := actions.QueryEntities(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit entity list transaction: %w", err)
	}

	page := &actions.ListPage[*models.Entity]{
		Items:   entities,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(entities) > 0 {
		last := entities[len(entities)-1]
		page.NextCursor, err = actions.EncodeRowCursor(last.CreatedAt, last.EntityID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode entity cursor: %w", err)
		}
	}
	return page, nil
}

// Count returns the total number of entities.
func (a *Actions) Count(ctx context.Context) (int, error) {
	var count int
	err := a.pool.QueryRow(ctx, "SELECT COUNT(*) FROM entities").Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count entities: %w", err)
	}
	return count, nil
}
