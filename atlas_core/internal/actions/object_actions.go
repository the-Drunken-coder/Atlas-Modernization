package actions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

// ObjectActions handles object business logic.
type ObjectActions struct {
	pool                  *pgxpool.Pool
	storage               objectStorage
	changeSink            ChangeSink
	uploadHeartbeatPeriod time.Duration
}

// NewObjectActions creates a new ObjectActions instance.
func NewObjectActions(pool *pgxpool.Pool, storageClient objectStorage) *ObjectActions {
	return NewObjectActionsWithChangeSink(pool, storageClient, nil)
}

// NewObjectActionsWithChangeSink creates a new ObjectActions instance that
// emits committed changes to sink.
func NewObjectActionsWithChangeSink(pool *pgxpool.Pool, storageClient objectStorage, sink ChangeSink) *ObjectActions {
	return &ObjectActions{
		pool:                  pool,
		storage:               storageClient,
		changeSink:            sink,
		uploadHeartbeatPeriod: storageUploadHeartbeatPeriod,
	}
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
	if params.Type != nil {
		if err := validateStringMaxLength("type", *params.Type, objectTypeMaxLength); err != nil {
			return nil, err
		}
	}
	normalizedType := normalizeOptionalObjectString(params.Type)
	if params.Path != nil {
		if err := validateStringMaxLength("path", *params.Path, objectPathMaxLength); err != nil {
			return nil, err
		}
	}
	if params.ContentType != nil {
		if err := validateStringMaxLength("content_type", *params.ContentType, objectContentMaxLength); err != nil {
			return nil, err
		}
	}

	// Build JSON payload
	jsonData := make(map[string]interface{})
	if params.SizeBytes != nil {
		jsonData[string(objectBlobFieldSizeBytes)] = *params.SizeBytes
	}
	if params.UsageHints != nil {
		jsonData[string(objectBlobFieldUsageHints)] = params.UsageHints
	}
	if params.ReferencedBy != nil {
		jsonData[string(objectBlobFieldReferencedBy)] = params.ReferencedBy
	}
	mergeBlobExtraFields(jsonData, params.Extra, objectPromotedBlobFields)
	applyConfiguredObjectBucket(jsonData, a.storage)

	jsonBytes, err := marshalValidatedJSONBlob(jsonData, ValidateObjectBlob)
	if err != nil {
		return nil, err
	}

	tx, err := beginChangeTx(ctx, a.pool, "object create", a.changeSink)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if params.Path != nil {
		if err := ensureObjectStoragePathAvailableTx(ctx, tx, *params.Path); err != nil {
			return nil, err
		}
	}

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

	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventCreate,
		ResourceType: ChangeResourceObject,
		ID:           obj.ObjectID,
		Version:      obj.Version,
		AfterObject:  cloneObjectModel(&obj),
	})

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
	return readCursorListPage(ctx, a.pool, cursorListPageOptions[*models.MediaObject]{
		limit:       limit,
		cursor:      cursor,
		cursorLabel: "cursor",
		operation:   "object list",
		cursorName:  "object",
		query: func(ctx context.Context, tx pgx.Tx, snapshotUpperBound time.Time, continuation bool, parsedCursor *parsedQueryCursor, limit int) ([]*models.MediaObject, bool, error) {
			return queryObjects(ctx, tx, "created_at", time.Time{}, snapshotUpperBound, continuation, parsedCursor, limit, 0)
		},
		rowCursor: func(object *models.MediaObject) (time.Time, string) {
			return object.CreatedAt, object.ObjectID
		},
	})
}

// UpdateObjectParams holds parameters for updating an object.
type UpdateObjectParams struct {
	Path            *string
	ContentType     *string
	Type            *string
	SizeBytes       *int64
	UsageHints      []string
	ReferencedBy    []map[string]interface{}
	Extra           map[string]interface{}
	RemoveExtraKeys []string
	ExpectedVersion *int64
}

// Update updates an object.
func (a *ObjectActions) Update(ctx context.Context, objectID string, params UpdateObjectParams) (*models.MediaObject, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = SanitizeID(objectID)
	if params.Path != nil {
		if err := validateStringMaxLength("path", *params.Path, objectPathMaxLength); err != nil {
			return nil, err
		}
	}
	if params.ContentType != nil {
		if err := validateStringMaxLength("content_type", *params.ContentType, objectContentMaxLength); err != nil {
			return nil, err
		}
	}
	if params.Type != nil {
		if err := validateStringMaxLength("type", *params.Type, objectTypeMaxLength); err != nil {
			return nil, err
		}
	}
	normalizedType := normalizeOptionalObjectString(params.Type)

	if params.Path == nil && params.ContentType == nil && params.Type == nil && params.SizeBytes == nil &&
		params.UsageHints == nil && params.ReferencedBy == nil && len(params.Extra) == 0 && len(params.RemoveExtraKeys) == 0 {
		if params.ExpectedVersion != nil {
			return a.lockObjectAndCheckExpectedVersion(ctx, objectID, params.ExpectedVersion)
		}
		obj, err := a.Get(ctx, objectID)
		if err != nil {
			return nil, err
		}
		return obj, nil
	}

	// Begin transaction for atomic read-modify-write.
	tx, err := beginChangeTx(ctx, a.pool, "object update", a.changeSink)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if params.Path != nil {
		if err := ensureObjectStoragePathAvailableTx(ctx, tx, *params.Path); err != nil {
			return nil, err
		}
	}

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

	if err := checkExpectedVersion("object", params.ExpectedVersion, obj.Version); err != nil {
		return nil, err
	}
	before := cloneObjectModel(&obj)

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
		newType = normalizedType
	}

	jsonBytes, err := patchValidatedJSONBlob(objectJSONPatch(obj.JSON, params, a.storage))
	if err != nil {
		return nil, err
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

	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventUpdate,
		ResourceType: ChangeResourceObject,
		ID:           out.ObjectID,
		Version:      out.Version,
		BeforeObject: before,
		AfterObject:  cloneObjectModel(&out),
	})

	return &out, nil
}

func beginObjectPreconditionTx(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin object precondition transaction: %w", err)
	}
	return tx, nil
}

func (a *ObjectActions) lockObjectAndCheckExpectedVersion(ctx context.Context, objectID string, expectedVersion *int64) (*models.MediaObject, error) {
	// This no-op update path only verifies the current row version. It locks the
	// row but does not allocate a change version, so the global write-version
	// advisory lock is unnecessary here.
	tx, err := beginObjectPreconditionTx(ctx, a.pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

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
	if err := checkExpectedVersion("object", expectedVersion, obj.Version); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit object precondition transaction: %w", err)
	}
	return &obj, nil
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

	var object models.MediaObject
	err = tx.QueryRow(ctx, `
		DELETE FROM objects WHERE object_id = $1
		RETURNING object_id, path, content_type, type, json, created_at, updated_at, version
	`, objectID).Scan(
		&object.ObjectID, &object.Path, &object.ContentType, &object.Type,
		&object.JSON, &object.CreatedAt, &object.UpdatedAt, &object.Version,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return NewObjectNotFoundError(objectID)
		}
		return fmt.Errorf("failed to delete object: %w", err)
	}

	// Record tombstone so changed-since can notify clients.
	var tombstoneVersion int64
	if err := tx.QueryRow(ctx,
		"INSERT INTO deletions (resource_type, resource_id, context) VALUES ($1, $2, '{}'::jsonb) RETURNING version",
		ChangeResourceObject, objectID,
	).Scan(&tombstoneVersion); err != nil {
		return fmt.Errorf("failed to record object deletion tombstone: %w", err)
	}

	var queuedBucket, queuedPath string
	if a.storage != nil && object.Path != nil && strings.TrimSpace(*object.Path) != "" {
		queuedBucket = strings.TrimSpace(a.storage.Bucket())
		queuedPath = strings.TrimSpace(*object.Path)
		if err := a.queueStorageDeletionTx(ctx, tx, queuedBucket, queuedPath, objectID); err != nil {
			return err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit delete transaction: %w", err)
	}

	publishChange(a.changeSink, ResourceChange{
		Event:        ChangeEventDelete,
		ResourceType: ChangeResourceObject,
		ID:           object.ObjectID,
		Version:      tombstoneVersion,
		BeforeObject: cloneObjectModel(&object),
	})

	if queuedPath != "" {
		if err := a.storage.DeleteObjectPath(ctx, queuedPath); err != nil {
			if recordErr := a.recordQueuedStorageDeletionFailure(ctx, queuedBucket, queuedPath, err); recordErr != nil {
				log.Error().Err(recordErr).Str("object_id", objectID).Str("path", queuedPath).Msg("Storage deletion failed and retry metadata could not be updated")
			}
			log.Error().Err(err).Str("object_id", objectID).Str("path", queuedPath).Msg("Object deleted from database but storage delete failed; queued retry")
		} else if err := a.clearQueuedStorageDeletion(ctx, queuedBucket, queuedPath); err != nil {
			log.Error().Err(err).Str("object_id", objectID).Str("path", queuedPath).Msg("Storage deletion succeeded but queued retry could not be cleared")
		}
	}

	return nil
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
