// Package objectactions provides media-object CRUD, upload, and storage
// deletion reconciliation business logic.
package objectactions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

type objectStorage interface {
	Bucket() string
	DeleteObjectPath(ctx context.Context, path string) error
	NewObjectPath(objectID string) string
	StreamObjectPath(ctx context.Context, objectID, path string) (io.ReadCloser, *storage.ObjectInfo, error)
	UploadObjectFromReaderToPath(ctx context.Context, objectID, path string, reader io.Reader, size int64, contentType string) (*storage.ObjectInfo, error)
}

// Actions handles object business logic.
type Actions struct {
	pool    *pgxpool.Pool
	storage objectStorage
}

// New creates a new object Actions instance.
func New(pool *pgxpool.Pool, storageClient objectStorage) *Actions {
	return &Actions{pool: pool, storage: storageClient}
}

// CreateParams holds parameters for creating an object.
type CreateParams struct {
	ObjectID     string
	Path         *string
	SizeBytes    *int64
	ContentType  *string
	Type         *string
	UsageHints   []string
	ReferencedBy []map[string]interface{}
	Extra        map[string]interface{}
}

// Create creates a new object record.
func (a *Actions) Create(ctx context.Context, params CreateParams) (*models.MediaObject, error) {
	if err := actions.ValidateObjectID(params.ObjectID); err != nil {
		return nil, err
	}
	objectID := actions.SanitizeID(params.ObjectID)
	normalizedType := normalizeOptionalObjectString(params.Type)

	// Build JSON payload
	jsonData := make(map[string]interface{})
	if params.SizeBytes != nil {
		jsonData["size_bytes"] = *params.SizeBytes
	}
	if params.UsageHints != nil {
		jsonData["usage_hints"] = params.UsageHints
	}
	if params.ReferencedBy != nil {
		jsonData["referenced_by"] = params.ReferencedBy
	}
	if params.Extra != nil {
		for k, v := range params.Extra {
			if k != "path" && k != "content_type" && k != "type" && k != "size_bytes" && k != "usage_hints" && k != "bucket" && k != "referenced_by" && k != "version" {
				jsonData[k] = v
			}
		}
	}
	applyConfiguredObjectBucket(jsonData, a.storage)
	if err := actions.ValidateObjectBlob(jsonData); err != nil {
		return nil, err
	}

	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	tx, err := actions.BeginChangeTx(ctx, a.pool, "object create")
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var obj models.MediaObject
	err = tx.QueryRow(ctx, `
		INSERT INTO objects (object_id, path, content_type, type, json)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING object_id, path, content_type, type, json, created_at, updated_at, version
	`, objectID, params.Path, params.ContentType, normalizedType, jsonBytes).Scan(
		&obj.ObjectID, &obj.Path, &obj.ContentType, &obj.Type,
		&obj.JSON, &obj.CreatedAt, &obj.UpdatedAt, &obj.Version,
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
		}
		return nil, fmt.Errorf("failed to create object: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit object create transaction: %w", err)
	}

	return &obj, nil
}

func normalizeOptionalObjectString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func decodeObjectJSONForPatch(raw json.RawMessage) (map[string]interface{}, error) {
	if raw == nil {
		return make(map[string]interface{}), nil
	}

	var data map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := jsondecode.Decode(decoder, &data); err != nil {
		return nil, err
	}
	if data == nil {
		return make(map[string]interface{}), nil
	}
	return data, nil
}

// Get retrieves an object by ID.
func (a *Actions) Get(ctx context.Context, objectID string) (*models.MediaObject, error) {
	if err := actions.ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = actions.SanitizeID(objectID)

	var obj models.MediaObject
	err := a.pool.QueryRow(ctx, `
		SELECT object_id, path, content_type, type, json, created_at, updated_at, version
		FROM objects WHERE object_id = $1
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

	return &obj, nil
}

// Delete removes an object and its storage.
func (a *Actions) Delete(ctx context.Context, objectID string) error {
	if err := actions.ValidateObjectID(objectID); err != nil {
		return err
	}
	objectID = actions.SanitizeID(objectID)

	tx, err := a.beginLockedObjectTx(ctx, objectID, "delete")
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	var objectPath *string
	err = tx.QueryRow(ctx, "DELETE FROM objects WHERE object_id = $1 RETURNING path", objectID).Scan(&objectPath)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return actions.NewObjectNotFoundError(objectID)
		}
		return fmt.Errorf("failed to delete object: %w", err)
	}

	// Record tombstone so changed-since can notify clients
	if _, err := tx.Exec(ctx,
		"INSERT INTO deletions (resource_type, resource_id) VALUES ('object', $1)", objectID); err != nil {
		return fmt.Errorf("failed to record object deletion tombstone: %w", err)
	}

	var queuedBucket, queuedPath string
	if a.storage != nil && objectPath != nil && strings.TrimSpace(*objectPath) != "" {
		queuedBucket = strings.TrimSpace(a.storage.Bucket())
		queuedPath = strings.TrimSpace(*objectPath)
		if err := a.queueStorageDeletionTx(ctx, tx, queuedBucket, queuedPath, objectID); err != nil {
			return err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit delete transaction: %w", err)
	}

	if queuedPath != "" {
		if err := a.attemptQueuedStorageDeletion(ctx, queuedBucket, queuedPath, objectID); err != nil {
			log.Error().Err(err).Str("object_id", objectID).Str("path", queuedPath).Msg("Object deleted from database but queued storage cleanup did not complete")
		}
	}

	return nil
}

// Download returns the object data and content type.
func (a *Actions) Download(ctx context.Context, objectID string) (io.ReadCloser, string, int64, error) {
	if err := actions.ValidateObjectID(objectID); err != nil {
		return nil, "", 0, err
	}
	objectID = actions.SanitizeID(objectID)

	if a.storage == nil {
		return nil, "", 0, &storage.StorageError{Message: "storage not configured"}
	}

	obj, err := a.Get(ctx, objectID)
	if err != nil {
		return nil, "", 0, err
	}
	if obj.Path == nil || strings.TrimSpace(*obj.Path) == "" {
		return nil, "", 0, &storage.ObjectNotFoundError{Bucket: a.storage.Bucket(), ObjectName: objectID}
	}

	reader, info, err := a.storage.StreamObjectPath(ctx, objectID, *obj.Path)
	if err != nil {
		return nil, "", 0, err
	}

	return reader, info.ContentType, info.SizeBytes, nil
}

// Count returns the total number of objects.
func (a *Actions) Count(ctx context.Context) (int, error) {
	var count int
	err := a.pool.QueryRow(ctx, "SELECT COUNT(*) FROM objects").Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count objects: %w", err)
	}
	return count, nil
}
