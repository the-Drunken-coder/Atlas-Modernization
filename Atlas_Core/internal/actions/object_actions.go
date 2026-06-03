package actions

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
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

// ObjectActions handles object business logic.
type ObjectActions struct {
	pool    *pgxpool.Pool
	storage objectStorage
}

// NewObjectActions creates a new ObjectActions instance.
func NewObjectActions(pool *pgxpool.Pool, storageClient objectStorage) *ObjectActions {
	return &ObjectActions{pool: pool, storage: storageClient}
}

// CreateObjectParams holds parameters for creating an object.
type CreateObjectParams struct {
	ObjectID     string
	Path         *string
	Bucket       *string
	SizeBytes    *int64
	ContentType  *string
	Type         *string
	UsageHints   []string
	ReferencedBy []map[string]interface{}
	Extra        map[string]interface{}
}

// Create creates a new object record.
func (a *ObjectActions) Create(ctx context.Context, params CreateObjectParams) (*models.MediaObject, error) {
	if err := ValidateObjectID(params.ObjectID); err != nil {
		return nil, err
	}
	objectID := SanitizeID(params.ObjectID)

	// Build JSON payload
	jsonData := make(map[string]interface{})
	if params.Bucket != nil {
		jsonData["bucket"] = *params.Bucket
	}
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
			if k != "path" && k != "content_type" && k != "type" && k != "size_bytes" && k != "usage_hints" && k != "bucket" && k != "referenced_by" {
				jsonData[k] = v
			}
		}
	}

	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var obj models.MediaObject
	err = a.pool.QueryRow(ctx, `
		INSERT INTO objects (object_id, path, content_type, type, json)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING object_id, path, content_type, type, json, created_at, updated_at
	`, objectID, params.Path, params.ContentType, params.Type, jsonBytes).Scan(
		&obj.ObjectID, &obj.Path, &obj.ContentType, &obj.Type,
		&obj.JSON, &obj.CreatedAt, &obj.UpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) {
				switch pgErr.ConstraintName {
				case "objects_pkey":
					return nil, NewObjectConflictError(objectID)
				case "objects_path_key":
					return nil, NewObjectPathConflictError()
				default:
					return nil, NewObjectPathConflictError()
				}
			}
		}
		return nil, fmt.Errorf("failed to create object: %w", err)
	}

	return &obj, nil
}

// Get retrieves an object by ID.
func (a *ObjectActions) Get(ctx context.Context, objectID string) (*models.MediaObject, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = SanitizeID(objectID)

	var obj models.MediaObject
	err := a.pool.QueryRow(ctx, `
		SELECT object_id, path, content_type, type, json, created_at, updated_at
		FROM objects WHERE object_id = $1
	`, objectID).Scan(
		&obj.ObjectID, &obj.Path, &obj.ContentType, &obj.Type,
		&obj.JSON, &obj.CreatedAt, &obj.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewObjectNotFoundError(objectID)
		}
		return nil, fmt.Errorf("failed to get object: %w", err)
	}

	return &obj, nil
}

// List retrieves objects with pagination.
func (a *ObjectActions) List(ctx context.Context, limit, offset int) ([]*models.MediaObject, int, error) {
	limit = ClampListLimit(limit)
	if offset < 0 {
		offset = 0
	}

	// Get objects with total count using window function (single query)
	rows, err := a.pool.Query(ctx, `
		SELECT object_id, path, content_type, type, json, created_at, updated_at,
		       COUNT(*) OVER() as total_count
		FROM objects
		ORDER BY created_at DESC, object_id DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list objects: %w", err)
	}
	defer rows.Close()

	var total int
	var objects []*models.MediaObject
	for rows.Next() {
		var o models.MediaObject
		if err := rows.Scan(&o.ObjectID, &o.Path, &o.ContentType, &o.Type, &o.JSON, &o.CreatedAt, &o.UpdatedAt, &total); err != nil {
			return nil, 0, fmt.Errorf("failed to scan object: %w", err)
		}
		objects = append(objects, &o)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("failed to iterate objects: %w", err)
	}

	if len(objects) == 0 {
		if err := a.pool.QueryRow(ctx, `SELECT COUNT(*) FROM objects`).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("failed to count objects: %w", err)
		}
	}

	return objects, total, nil
}

// UpdateObjectParams holds parameters for updating an object.
type UpdateObjectParams struct {
	Path         *string
	Bucket       *string
	ContentType  *string
	Type         *string
	SizeBytes    *int64
	UsageHints   []string
	ReferencedBy []map[string]interface{}
	Extra        map[string]interface{}
	IfMatch      *string // optional If-Match (weak ETag from GET /objects/{id})
}

// Update updates an object.
func (a *ObjectActions) Update(ctx context.Context, objectID string, params UpdateObjectParams) (*models.MediaObject, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = SanitizeID(objectID)

	if params.Path == nil && params.Bucket == nil && params.ContentType == nil && params.Type == nil && params.SizeBytes == nil &&
		params.UsageHints == nil && params.ReferencedBy == nil && len(params.Extra) == 0 {
		obj, err := a.Get(ctx, objectID)
		if err != nil {
			return nil, err
		}
		if params.IfMatch != nil && *params.IfMatch != "" && !ObjectIfMatchOK(*params.IfMatch, obj.UpdatedAt) {
			return nil, NewObjectPreconditionFailedError()
		}
		return obj, nil
	}

	// Begin transaction for atomic read-modify-write
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Fetch existing object with row lock
	var obj models.MediaObject
	err = tx.QueryRow(ctx, `
		SELECT object_id, path, content_type, type, json, created_at, updated_at
		FROM objects WHERE object_id = $1
		FOR UPDATE
	`, objectID).Scan(
		&obj.ObjectID, &obj.Path, &obj.ContentType, &obj.Type,
		&obj.JSON, &obj.CreatedAt, &obj.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, NewObjectNotFoundError(objectID)
		}
		return nil, fmt.Errorf("failed to get object: %w", err)
	}

	if params.IfMatch != nil && *params.IfMatch != "" && !ObjectIfMatchOK(*params.IfMatch, obj.UpdatedAt) {
		return nil, NewObjectPreconditionFailedError()
	}

	// Parse existing JSON
	var existingJSON map[string]interface{}
	if obj.JSON != nil {
		if err := json.Unmarshal(obj.JSON, &existingJSON); err != nil {
			return nil, fmt.Errorf("existing object json is corrupt or invalid: %w", err)
		}
		if existingJSON == nil {
			existingJSON = make(map[string]interface{})
		}
	} else {
		existingJSON = make(map[string]interface{})
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
	if params.Bucket != nil {
		existingJSON["bucket"] = *params.Bucket
	}
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
			if k != "path" && k != "content_type" && k != "type" && k != "size_bytes" && k != "usage_hints" && k != "bucket" && k != "referenced_by" {
				existingJSON[k] = v
			}
		}
	}

	jsonBytes, err := json.Marshal(existingJSON)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	var out models.MediaObject
	err = tx.QueryRow(ctx, `
		UPDATE objects SET path = $1, content_type = $2, type = $3, json = $4, updated_at = CURRENT_TIMESTAMP
		WHERE object_id = $5
		RETURNING object_id, path, content_type, type, json, created_at, updated_at
	`, newPath, newContentType, newType, jsonBytes, objectID).Scan(
		&out.ObjectID, &out.Path, &out.ContentType, &out.Type,
		&out.JSON, &out.CreatedAt, &out.UpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) {
				switch pgErr.ConstraintName {
				case "objects_pkey":
					return nil, NewObjectConflictError(objectID)
				case "objects_path_key":
					return nil, NewObjectPathConflictError()
				default:
					return nil, NewObjectPathConflictError()
				}
			}
			return nil, NewObjectPathConflictError()
		}
		return nil, fmt.Errorf("failed to update object: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return &out, nil
}

// Delete removes an object and its storage.
func (a *ObjectActions) Delete(ctx context.Context, objectID string) error {
	if err := ValidateObjectID(objectID); err != nil {
		return err
	}
	objectID = SanitizeID(objectID)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("failed to begin delete transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	var objectPath *string
	err = tx.QueryRow(ctx, "DELETE FROM objects WHERE object_id = $1 RETURNING path", objectID).Scan(&objectPath)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NewObjectNotFoundError(objectID)
		}
		return fmt.Errorf("failed to delete object: %w", err)
	}

	// Record tombstone so changed-since can notify clients
	if _, err := tx.Exec(ctx,
		"INSERT INTO deletions (resource_type, resource_id) VALUES ('object', $1)", objectID); err != nil {
		return fmt.Errorf("failed to record object deletion tombstone: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit delete transaction: %w", err)
	}

	if a.storage != nil && objectPath != nil && strings.TrimSpace(*objectPath) != "" {
		if err := a.storage.DeleteObjectPath(ctx, *objectPath); err != nil {
			log.Error().Err(err).Str("object_id", objectID).Str("path", *objectPath).Msg("Object deleted from database but storage delete failed; reconcile storage manually if needed")
		}
	}

	return nil
}

func objectUploadLockKeys(objectID string) (int32, int32) {
	sum := sha256.Sum256([]byte("atlas-core-object-upload:" + objectID))
	return int32(binary.BigEndian.Uint32(sum[0:4])), int32(binary.BigEndian.Uint32(sum[4:8]))
}

func (a *ObjectActions) beginObjectUploadTx(ctx context.Context, objectID string) (pgx.Tx, error) {
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin upload transaction: %w", err)
	}

	key1, key2 := objectUploadLockKeys(objectID)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, $2)`, key1, key2); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("failed to lock object upload: %w", err)
	}

	return tx, nil
}

func currentObjectPathForUpdate(ctx context.Context, tx pgx.Tx, objectID string) (*string, error) {
	var objectPath *string
	err := tx.QueryRow(ctx, `SELECT path FROM objects WHERE object_id = $1 FOR UPDATE`, objectID).Scan(&objectPath)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to lock existing object metadata: %w", err)
	}
	return objectPath, nil
}

func uploadObjectJSON(bucket string, sizeBytes int64, usageHints []string) ([]byte, error) {
	jsonData := map[string]interface{}{
		"bucket":     bucket,
		"size_bytes": sizeBytes,
	}
	if usageHints != nil {
		jsonData["usage_hints"] = usageHints
	}
	return json.Marshal(jsonData)
}

func upsertUploadedObjectMetadata(
	ctx context.Context,
	tx pgx.Tx,
	objectID, objectPath, contentType string,
	objType *string,
	jsonBytes []byte,
) (*models.MediaObject, error) {
	var out models.MediaObject
	err := tx.QueryRow(ctx, `
		INSERT INTO objects (object_id, path, content_type, type, json)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (object_id) DO UPDATE SET
			path = EXCLUDED.path,
			content_type = EXCLUDED.content_type,
			type = EXCLUDED.type,
			json = objects.json || EXCLUDED.json,
			updated_at = CURRENT_TIMESTAMP
		RETURNING object_id, path, content_type, type, json, created_at, updated_at
	`, objectID, objectPath, contentType, objType, jsonBytes).Scan(
		&out.ObjectID, &out.Path, &out.ContentType, &out.Type,
		&out.JSON, &out.CreatedAt, &out.UpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, NewObjectPathConflictError()
		}
		return nil, fmt.Errorf("failed to persist uploaded object metadata: %w", err)
	}
	return &out, nil
}

func (a *ObjectActions) cleanupUploadedPathAfterFailure(ctx context.Context, objectID, objectPath string, cause error) error {
	if objectPath == "" {
		return cause
	}
	if err := a.storage.DeleteObjectPath(ctx, objectPath); err != nil {
		return fmt.Errorf("%w (also failed to remove uploaded object %q for %s: %v)", cause, objectPath, objectID, err)
	}
	return cause
}

// Upload uploads a file and creates/updates the object record.
func (a *ObjectActions) Upload(ctx context.Context, objectID string, reader io.Reader, size int64, contentType, objType string, usageHint *string) (*models.MediaObject, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = SanitizeID(objectID)

	if a.storage == nil {
		return nil, &storage.StorageError{Message: "storage not configured"}
	}

	objectPath := a.storage.NewObjectPath(objectID)
	uploadedInfo, err := a.storage.UploadObjectFromReaderToPath(ctx, objectID, objectPath, reader, size, contentType)
	if err != nil {
		return nil, fmt.Errorf("failed to upload to storage: %w", err)
	}

	var usageHints []string
	if usageHint != nil && *usageHint != "" {
		usageHints = []string{*usageHint}
	}

	bucket := a.storage.Bucket()
	objType = strings.TrimSpace(objType)
	var typePtr *string
	if objType != "" {
		typePtr = &objType
	}

	jsonBytes, err := uploadObjectJSON(bucket, uploadedInfo.SizeBytes, usageHints)
	if err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, fmt.Errorf("failed to marshal object metadata JSON: %w", err))
	}

	tx, err := a.beginObjectUploadTx(ctx, objectID)
	if err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	oldPath, err := currentObjectPathForUpdate(ctx, tx, objectID)
	if err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, err)
	}

	out, err := upsertUploadedObjectMetadata(ctx, tx, objectID, objectPath, contentType, typePtr, jsonBytes)
	if err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit upload metadata transaction: %w", err)
	}

	if oldPath != nil && strings.TrimSpace(*oldPath) != "" && *oldPath != objectPath {
		if err := a.storage.DeleteObjectPath(ctx, *oldPath); err != nil {
			log.Warn().Err(err).Str("object_id", objectID).Str("old_path", *oldPath).Msg("Uploaded object metadata now points to a new blob, but old blob cleanup failed")
		}
	}

	return out, nil
}

// Download returns the object data and content type.
func (a *ObjectActions) Download(ctx context.Context, objectID string) (io.ReadCloser, string, int64, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return nil, "", 0, err
	}
	objectID = SanitizeID(objectID)

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

// GetByEntity retrieves objects referenced by an entity.
func (a *ObjectActions) GetByEntity(ctx context.Context, entityID string, limit, offset int) ([]*models.MediaObject, int, error) {
	return a.getObjectsByJSONReference(ctx, "entity_id", entityID, ValidateEntityID, limit, offset)
}

// GetByTask retrieves objects referenced by a task.
func (a *ObjectActions) GetByTask(ctx context.Context, taskID string, limit, offset int) ([]*models.MediaObject, int, error) {
	return a.getObjectsByJSONReference(ctx, "task_id", taskID, ValidateTaskID, limit, offset)
}

func (a *ObjectActions) getObjectsByJSONReference(
	ctx context.Context,
	refKey, id string,
	validate func(string) error,
	limit, offset int,
) ([]*models.MediaObject, int, error) {
	if err := validate(id); err != nil {
		return nil, 0, err
	}
	id = SanitizeID(id)

	limit = ClampListLimit(limit)
	if offset < 0 {
		offset = 0
	}

	refData := []map[string]string{{refKey: id}}
	refJSONBytes, err := json.Marshal(refData)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to marshal reference JSON: %w", err)
	}
	refJSON := string(refJSONBytes)

	query := `
		SELECT object_id, path, content_type, type, json, created_at, updated_at,
		       COUNT(*) OVER() as total_count
		FROM objects
		WHERE json->'referenced_by' @> $1::jsonb
		ORDER BY created_at DESC, object_id DESC
		LIMIT $2 OFFSET $3
	`

	rows, err := a.pool.Query(ctx, query, refJSON, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query objects: %w", err)
	}
	defer rows.Close()

	var total int
	var objects []*models.MediaObject
	for rows.Next() {
		var o models.MediaObject
		if err := rows.Scan(&o.ObjectID, &o.Path, &o.ContentType, &o.Type, &o.JSON, &o.CreatedAt, &o.UpdatedAt, &total); err != nil {
			return nil, 0, fmt.Errorf("failed to scan object: %w", err)
		}
		objects = append(objects, &o)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("failed to iterate objects: %w", err)
	}

	if len(objects) == 0 {
		if err := a.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM objects
			WHERE json->'referenced_by' @> $1::jsonb
		`, refJSON).Scan(&total); err != nil {
			return nil, 0, fmt.Errorf("failed to count objects: %w", err)
		}
	}

	return objects, total, nil
}

// Count returns the total number of objects.
func (a *ObjectActions) Count(ctx context.Context) (int, error) {
	var count int
	err := a.pool.QueryRow(ctx, "SELECT COUNT(*) FROM objects").Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count objects: %w", err)
	}
	return count, nil
}
