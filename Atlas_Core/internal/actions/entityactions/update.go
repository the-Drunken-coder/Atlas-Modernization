package entityactions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// UpdateParams holds parameters for updating an entity.
type UpdateParams struct {
	EntityType      *string
	Subtype         *string
	Alias           *string
	Components      map[string]interface{}
	Extra           map[string]interface{}
	ExpectedVersion *int64
}

// IsEmpty reports whether the PATCH carries no updatable fields.
func (p UpdateParams) IsEmpty() bool {
	componentsEmpty := len(p.Components) == 0
	extraEmpty := len(p.Extra) == 0
	return p.EntityType == nil && p.Subtype == nil && p.Alias == nil && componentsEmpty && extraEmpty
}

// Update updates an entity.
func (a *Actions) Update(ctx context.Context, entityID string, params UpdateParams) (*models.Entity, error) {
	if err := actions.ValidateEntityID(entityID); err != nil {
		return nil, err
	}
	entityID = actions.SanitizeID(entityID)

	if params.IsEmpty() {
		entity, err := a.Get(ctx, entityID)
		if err != nil {
			return nil, err
		}
		if !actions.ExpectedVersionMatches(params.ExpectedVersion, entity.Version) {
			return nil, actions.NewPreconditionFailedError("entity")
		}
		return entity, nil
	}

	// Begin transaction for atomic read-modify-write.
	tx, err := actions.BeginChangeTx(ctx, a.pool, "entity update")
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
			return nil, actions.NewEntityNotFoundError(entityID)
		}
		return nil, fmt.Errorf("failed to get entity: %w", err)
	}
	if !actions.ExpectedVersionMatches(params.ExpectedVersion, entity.Version) {
		return nil, actions.NewPreconditionFailedError("entity")
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
			return nil, actions.NewValidationError("entity_type cannot be empty")
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
		s, err := actions.NormalizeAlias(*params.Alias)
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
		if err := actions.ValidateEntityComponents(params.Components); err != nil {
			return nil, err
		}

		var existingComponents map[string]interface{}
		rawStored, hadStored := existingJSON["components"]
		if hadStored && rawStored != nil {
			storedMap, ok := rawStored.(map[string]interface{})
			if !ok {
				return nil, actions.NewValidationError("stored entity components must be an object or null")
			}
			existingComponents = storedMap
		} else {
			existingComponents = make(map[string]interface{})
		}
		for k, v := range params.Components {
			existingComponents[k] = actions.MergeJSONValue(existingComponents[k], v)
		}
		normalizeLegacyEntityComponents(existingComponents)
		if err := actions.ValidateEntityComponents(existingComponents); err != nil {
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
	if err := actions.ValidateEntityBlob(existingJSON); err != nil {
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
		if actions.IsUniqueViolation(err) {
			return nil, actions.NewEntityUniqueConstraintError()
		}
		return nil, fmt.Errorf("failed to update entity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return &out, nil
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
func (a *Actions) Delete(ctx context.Context, entityID string) error {
	if err := actions.ValidateEntityID(entityID); err != nil {
		return err
	}
	entityID = actions.SanitizeID(entityID)

	tx, err := actions.BeginChangeTx(ctx, a.pool, "entity delete")
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
		return actions.NewEntityNotFoundError(entityID)
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
