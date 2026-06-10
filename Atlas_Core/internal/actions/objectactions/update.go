package objectactions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

// UpdateParams holds parameters for updating an object.
type UpdateParams struct {
	Path            *string
	ContentType     *string
	Type            *string
	SizeBytes       *int64
	UsageHints      []string
	ReferencedBy    []map[string]interface{}
	Extra           map[string]interface{}
	ExpectedVersion *int64
}

// Update updates an object.
func (a *Actions) Update(ctx context.Context, objectID string, params UpdateParams) (*models.MediaObject, error) {
	if err := actions.ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = actions.SanitizeID(objectID)

	if params.Path == nil && params.ContentType == nil && params.Type == nil && params.SizeBytes == nil &&
		params.UsageHints == nil && params.ReferencedBy == nil && len(params.Extra) == 0 {
		obj, err := a.Get(ctx, objectID)
		if err != nil {
			return nil, err
		}
		if !actions.ExpectedVersionMatches(params.ExpectedVersion, obj.Version) {
			return nil, actions.NewPreconditionFailedError("object")
		}
		return obj, nil
	}

	// Begin transaction for atomic read-modify-write.
	tx, err := actions.BeginChangeTx(ctx, a.pool, "object update")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Fetch existing object with row lock
	var obj models.MediaObject
	err = tx.QueryRow(ctx, `
		SELECT object_id, path, content_type, type, json, created_at, updated_at, version
		FROM objects WHERE object_id = $1
		FOR UPDATE
	`, objectID).Scan(
		&obj.ObjectID, &obj.Path, &obj.ContentType, &obj.Type,
		&obj.JSON, &obj.CreatedAt, &obj.UpdatedAt, &obj.Version,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, actions.NewObjectNotFoundError(objectID)
		}
		return nil, fmt.Errorf("failed to get object: %w", err)
	}

	if !actions.ExpectedVersionMatches(params.ExpectedVersion, obj.Version) {
		return nil, actions.NewPreconditionFailedError("object")
	}

	// Parse existing JSON
	existingJSON, err := decodeObjectJSONForPatch(obj.JSON)
	if err != nil {
		return nil, fmt.Errorf("existing object json is corrupt or invalid: %w", err)
	}

	// Update columns if provided
	newPath := obj.Path
	if params.Path != nil {
		newPath = params.Path
	}

	newContentType := obj.ContentType
	if params.ContentType != nil {
		newContentType = params.ContentType
	}

	newType := obj.Type
	if params.Type != nil {
		trimmed := strings.TrimSpace(*params.Type)
		if trimmed == "" {
			newType = nil
		} else {
			newType = &trimmed
		}
	}

	// Update JSON fields
	if params.SizeBytes != nil {
		existingJSON["size_bytes"] = *params.SizeBytes
	}
	if params.UsageHints != nil {
		existingJSON["usage_hints"] = params.UsageHints
	}
	if params.ReferencedBy != nil {
		existingJSON["referenced_by"] = params.ReferencedBy
	}
	if params.Extra != nil {
		for k, v := range params.Extra {
			if k != "path" && k != "content_type" && k != "type" && k != "size_bytes" && k != "usage_hints" && k != "bucket" && k != "referenced_by" && k != "version" {
				existingJSON[k] = v
			}
		}
	}
	applyConfiguredObjectBucket(existingJSON, a.storage)
	if err := actions.ValidateObjectBlob(existingJSON); err != nil {
		return nil, err
	}

	jsonBytes, err := json.Marshal(existingJSON)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var out models.MediaObject
	err = tx.QueryRow(ctx, `
		UPDATE objects
		SET path = $1, content_type = $2, type = $3, json = $4,
			updated_at = clock_timestamp(),
			version = nextval('atlas_change_version_seq')
		WHERE object_id = $5
		RETURNING object_id, path, content_type, type, json, created_at, updated_at, version
	`, newPath, newContentType, newType, jsonBytes, objectID).Scan(
		&out.ObjectID, &out.Path, &out.ContentType, &out.Type,
		&out.JSON, &out.CreatedAt, &out.UpdatedAt, &out.Version,
	)
	if err != nil {
		if actions.IsUniqueViolation(err) {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) {
				switch pgErr.ConstraintName {
				case "objects_pkey":
					return nil, actions.NewObjectConflictError(objectID)
				case "objects_path_key":
					return nil, actions.NewObjectPathConflictError()
				default:
					return nil, actions.NewObjectPathConflictError()
				}
			}
			return nil, actions.NewObjectPathConflictError()
		}
		return nil, fmt.Errorf("failed to update object: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return &out, nil
}

func applyConfiguredObjectBucket(blob map[string]interface{}, storageClient objectStorage) {
	if storageClient == nil {
		delete(blob, "bucket")
		return
	}
	bucket := strings.TrimSpace(storageClient.Bucket())
	if bucket == "" {
		delete(blob, "bucket")
		return
	}
	blob["bucket"] = bucket
}
