package actions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/jsondecode"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
	protocol "github.com/the-drunken-coder/atlas/atlas_protocol/generated/go/atlasprotocol"
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
	if err := ValidateObjectBlob(jsonData); err != nil {
		return nil, err
	}

	jsonBytes, err := json.Marshal(jsonData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal JSON: %w", err)
	}

	tx, err := beginChangeTx(ctx, a.pool, "object create")
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
func (a *ObjectActions) Get(ctx context.Context, objectID string) (*models.MediaObject, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = SanitizeID(objectID)

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
			return nil, NewObjectNotFoundError(objectID)
		}
		return nil, fmt.Errorf("failed to get object: %w", err)
	}

	return &obj, nil
}

// List retrieves objects with pagination.
func (a *ObjectActions) List(ctx context.Context, limit int, cursor string) (*ListPage[*models.MediaObject], error) {
	limit = ClampListLimit(limit)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin object list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read object list snapshot timestamp: %w", err)
	}

	parsedCursor, err := parseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, continuation, err := continuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}
	objects, hasMore, err := queryObjects(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit object list transaction: %w", err)
	}

	page := &ListPage[*models.MediaObject]{
		Items:   objects,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(objects) > 0 {
		last := objects[len(objects)-1]
		page.NextCursor, err = encodeRowCursor(last.CreatedAt, last.ObjectID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode object cursor: %w", err)
		}
	}
	return page, nil
}

// UpdateObjectParams holds parameters for updating an object.
type UpdateObjectParams struct {
	Path         *string
	ContentType  *string
	Type         *string
	SizeBytes    *int64
	UsageHints   []string
	ReferencedBy []map[string]interface{}
	Extra        map[string]interface{}
	IfMatch      *string // optional If-Match (strong ETag from GET /objects/{id})
}

// Update updates an object.
func (a *ObjectActions) Update(ctx context.Context, objectID string, params UpdateObjectParams) (*models.MediaObject, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = SanitizeID(objectID)

	if params.Path == nil && params.ContentType == nil && params.Type == nil && params.SizeBytes == nil &&
		params.UsageHints == nil && params.ReferencedBy == nil && len(params.Extra) == 0 {
		obj, err := a.Get(ctx, objectID)
		if err != nil {
			return nil, err
		}
		if params.IfMatch != nil && *params.IfMatch != "" && !ObjectIfMatchOK(*params.IfMatch, obj.Version) {
			return nil, NewObjectPreconditionFailedError()
		}
		return obj, nil
	}

	// Begin transaction for atomic read-modify-write.
	tx, err := beginChangeTx(ctx, a.pool, "object update")
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
			return nil, NewObjectNotFoundError(objectID)
		}
		return nil, fmt.Errorf("failed to get object: %w", err)
	}

	if params.IfMatch != nil && *params.IfMatch != "" && !ObjectIfMatchOK(*params.IfMatch, obj.Version) {
		return nil, NewObjectPreconditionFailedError()
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
	if err := ValidateObjectBlob(existingJSON); err != nil {
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

// ValidateObjectBlob validates storage-facing object metadata.
func ValidateObjectBlob(blob map[string]interface{}) error {
	result := validationResultFromErrors(protocol.ValidateObjectBlob(blob))
	if !result.HasErrors() {
		return nil
	}
	return NewValidationErrorWithDetails(
		fmt.Sprintf("Object validation failed (%d errors)", len(result.Errors)),
		result.Errors,
	)
}

// Delete removes an object and its storage.
func (a *ObjectActions) Delete(ctx context.Context, objectID string) error {
	if err := ValidateObjectID(objectID); err != nil {
		return err
	}
	objectID = SanitizeID(objectID)

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

func objectUploadLockKey(objectID string) string {
	return "atlas-core-object-upload:" + objectID
}

func (a *ObjectActions) beginLockedObjectTx(ctx context.Context, objectID, operation string) (pgx.Tx, error) {
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin %s transaction: %w", operation, err)
	}

	if err := lockChangeVersion(ctx, tx); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("failed to lock %s change version: %w", operation, err)
	}

	lockKey := objectUploadLockKey(objectID)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, lockKey); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("failed to lock object for %s: %w", operation, err)
	}

	return tx, nil
}

type objectUploadState struct {
	path          *string
	json          map[string]interface{}
	rowExists     bool
	maxDeletionID int64
}

func currentObjectStateForUpload(ctx context.Context, tx pgx.Tx, objectID string) (*objectUploadState, error) {
	state := &objectUploadState{
		json: make(map[string]interface{}),
	}

	var objectPath *string
	var objectJSON json.RawMessage
	err := tx.QueryRow(ctx, `SELECT path, json FROM objects WHERE object_id = $1 FOR UPDATE`, objectID).Scan(&objectPath, &objectJSON)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("failed to lock existing object metadata: %w", err)
		}
	} else {
		state.path = objectPath
		state.rowExists = true

		decoded, err := decodeObjectJSONForPatch(objectJSON)
		if err != nil {
			return nil, fmt.Errorf("existing object json is corrupt or invalid: %w", err)
		}
		state.json = decoded
	}

	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(id), 0)
		FROM deletions
		WHERE resource_type = 'object' AND resource_id = $1
	`, objectID).Scan(&state.maxDeletionID); err != nil {
		return nil, fmt.Errorf("failed to read object deletion state: %w", err)
	}

	return state, nil
}

func objectDeletedAfterUploadPreflight(preflight, current *objectUploadState) bool {
	return preflight.rowExists && current.maxDeletionID > preflight.maxDeletionID
}

func uploadObjectJSON(existingJSON map[string]interface{}, bucket string, sizeBytes int64, usageHints []string) ([]byte, error) {
	jsonData := make(map[string]interface{}, len(existingJSON)+3)
	for key, value := range existingJSON {
		jsonData[key] = value
	}
	jsonData["bucket"] = bucket
	jsonData["size_bytes"] = sizeBytes
	if usageHints != nil {
		jsonData["usage_hints"] = usageHints
	}

	if err := ValidateObjectBlob(jsonData); err != nil {
		return nil, err
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
			json = EXCLUDED.json,
			updated_at = clock_timestamp(),
			version = nextval('atlas_change_version_seq')
		RETURNING object_id, path, content_type, type, json, created_at, updated_at, version
	`, objectID, objectPath, contentType, objType, jsonBytes).Scan(
		&out.ObjectID, &out.Path, &out.ContentType, &out.Type,
		&out.JSON, &out.CreatedAt, &out.UpdatedAt, &out.Version,
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
		return fmt.Errorf("%w (also failed to remove uploaded object %q for %s: %w)", cause, objectPath, objectID, err)
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

	tx, err := a.beginLockedObjectTx(ctx, objectID, "upload")
	if err != nil {
		return nil, err
	}

	preflightState, err := currentObjectStateForUpload(ctx, tx, objectID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit upload preflight transaction: %w", err)
	}

	objectPath := a.storage.NewObjectPath(objectID)
	uploadedInfo, err := a.storage.UploadObjectFromReaderToPath(ctx, objectID, objectPath, reader, size, contentType)
	if err != nil {
		return nil, fmt.Errorf("failed to upload to storage: %w", err)
	}

	tx, err = a.beginLockedObjectTx(ctx, objectID, "upload metadata")
	if err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	currentState, err := currentObjectStateForUpload(ctx, tx, objectID)
	if err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, err)
	}
	if objectDeletedAfterUploadPreflight(preflightState, currentState) {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, NewObjectNotFoundError(objectID))
	}

	jsonBytes, err := uploadObjectJSON(currentState.json, bucket, uploadedInfo.SizeBytes, usageHints)
	if err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, fmt.Errorf("failed to marshal object metadata JSON: %w", err))
	}

	out, err := upsertUploadedObjectMetadata(ctx, tx, objectID, objectPath, contentType, typePtr, jsonBytes)
	if err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(
			ctx,
			objectID,
			objectPath,
			fmt.Errorf("failed to commit upload metadata transaction: %w", err),
		)
	}

	if currentState.path != nil && strings.TrimSpace(*currentState.path) != "" && *currentState.path != objectPath {
		if err := a.storage.DeleteObjectPath(ctx, *currentState.path); err != nil {
			log.Warn().Err(err).Str("object_id", objectID).Str("old_path", *currentState.path).Msg("Uploaded object metadata now points to a new blob, but old blob cleanup failed")
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
func (a *ObjectActions) GetByEntity(ctx context.Context, entityID string, limit int, cursor string) (*ListPage[*models.MediaObject], error) {
	return a.getObjectsByJSONReference(ctx, "entity_id", entityID, ValidateEntityID, limit, cursor)
}

// GetByTask retrieves objects referenced by a task.
func (a *ObjectActions) GetByTask(ctx context.Context, taskID string, limit int, cursor string) (*ListPage[*models.MediaObject], error) {
	return a.getObjectsByJSONReference(ctx, "task_id", taskID, ValidateTaskID, limit, cursor)
}

func (a *ObjectActions) getObjectsByJSONReference(
	ctx context.Context,
	refKey, id string,
	validate func(string) error,
	limit int,
	cursor string,
) (*ListPage[*models.MediaObject], error) {
	if err := validate(id); err != nil {
		return nil, err
	}
	id = SanitizeID(id)

	limit = ClampListLimit(limit)

	refData := []map[string]string{{refKey: id}}
	refJSONBytes, err := json.Marshal(refData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal reference JSON: %w", err)
	}
	refJSON := string(refJSONBytes)

	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin object reference list transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var txUpperBound time.Time
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&txUpperBound); err != nil {
		return nil, fmt.Errorf("read object reference list snapshot timestamp: %w", err)
	}

	parsedCursor, err := parseQueryCursor(cursor, "cursor")
	if err != nil {
		return nil, err
	}
	snapshotUpperBound, _, err := continuationUpperBound(txUpperBound, parsedCursor)
	if err != nil {
		return nil, err
	}

	whereClauses := []string{"json->'referenced_by' @> $1::jsonb"}
	args := []interface{}{refJSON}
	if parsedCursor != nil {
		cursorUpperBound := parsedCursor.upperBound
		if cursorUpperBound.IsZero() {
			cursorUpperBound = snapshotUpperBound
		}
		if !cursorUpperBound.IsZero() {
			whereClauses = append(whereClauses, fmt.Sprintf("created_at <= $%d::timestamptz", len(args)+1))
			args = append(args, cursorUpperBound)
		}
		whereClauses = append(whereClauses, fmt.Sprintf("(created_at, object_id) < ($%d::timestamptz, $%d::varchar)", len(args)+1, len(args)+2))
		args = append(args, parsedCursor.timestamp, parsedCursor.id)
	} else {
		whereClauses = append(whereClauses, fmt.Sprintf("created_at <= $%d::timestamptz", len(args)+1))
		args = append(args, snapshotUpperBound)
	}

	limitPos := len(args) + 1
	args = append(args, limit+1)
	query := fmt.Sprintf(`
		SELECT object_id, path, content_type, type, json, created_at, updated_at, version
		FROM objects
		WHERE %s
		ORDER BY created_at DESC, object_id DESC
		LIMIT $%d
	`, strings.Join(whereClauses, " AND "), limitPos)

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query objects: %w", err)
	}
	defer rows.Close()

	var objects []*models.MediaObject
	for rows.Next() {
		var o models.MediaObject
		if err := rows.Scan(&o.ObjectID, &o.Path, &o.ContentType, &o.Type, &o.JSON, &o.CreatedAt, &o.UpdatedAt, &o.Version); err != nil {
			return nil, fmt.Errorf("failed to scan object: %w", err)
		}
		objects = append(objects, &o)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate objects: %w", err)
	}

	objects, hasMore := trimToLimitWithMore(objects, limit)

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit object reference list transaction: %w", err)
	}

	page := &ListPage[*models.MediaObject]{
		Items:   objects,
		Limit:   limit,
		HasMore: hasMore,
	}
	if hasMore && len(objects) > 0 {
		last := objects[len(objects)-1]
		page.NextCursor, err = encodeRowCursor(last.CreatedAt, last.ObjectID, snapshotUpperBound)
		if err != nil {
			return nil, fmt.Errorf("encode object reference cursor: %w", err)
		}
	}
	return page, nil
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
