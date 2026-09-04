package actions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/services/core/internal/models"
	"github.com/the-drunken-coder/atlas/services/core/internal/storage"
)

func objectUploadLockKey(objectID string) string {
	return "atlas-core-object-upload:" + objectID
}

func (a *ObjectActions) beginLockedObjectTx(ctx context.Context, objectID, operation string) (pgx.Tx, error) {
	tx, err := beginChangeTx(ctx, a.pool, operation)
	if err != nil {
		return nil, err
	}

	lockKey := objectUploadLockKey(objectID)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, lockKey); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("failed to lock object for %s: %w", operation, err)
	}

	return tx, nil
}

type objectUploadState struct {
	path               *string
	json               map[string]interface{}
	resource           *models.MediaObject
	rowExists          bool
	maxDeletionVersion int64
}

func currentObjectStateForUpload(ctx context.Context, tx pgx.Tx, objectID string) (*objectUploadState, error) {
	state := &objectUploadState{
		json: make(map[string]interface{}),
	}

	object, err := scanObject(tx.QueryRow(ctx, `
		SELECT object_id, path, content_type, type, json, created_at, updated_at, version
		FROM objects WHERE object_id = $1
		FOR UPDATE
	`, objectID))
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("failed to lock existing object metadata: %w", err)
		}
	} else {
		state.path = object.Path
		state.resource = cloneObjectModel(object)
		state.rowExists = true

		decoded, err := decodeObjectJSONForPatch(object.JSON)
		if err != nil {
			return nil, fmt.Errorf("existing object json is corrupt or invalid: %w", err)
		}
		state.json = decoded
	}

	if err := tx.QueryRow(ctx, `
		SELECT COALESCE((SELECT version FROM object_deletion_fences WHERE object_id = $1), 0)
	`, objectID).Scan(&state.maxDeletionVersion); err != nil {
		return nil, fmt.Errorf("failed to read object deletion state: %w", err)
	}

	return state, nil
}

func recordObjectDeletionFenceTx(ctx context.Context, tx pgx.Tx, objectID string, version int64) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO object_deletion_fences (object_id, version)
		VALUES ($1, $2)
		ON CONFLICT (object_id) DO UPDATE SET
			version = GREATEST(object_deletion_fences.version, EXCLUDED.version),
			deleted_at = CASE
				WHEN EXCLUDED.version > object_deletion_fences.version THEN clock_timestamp()
				ELSE object_deletion_fences.deleted_at
			END
	`, objectID, version); err != nil {
		return fmt.Errorf("record object deletion fence: %w", err)
	}
	return nil
}

func objectDeletedAfterUploadPreflight(preflight, current *objectUploadState) bool {
	return current.maxDeletionVersion > preflight.maxDeletionVersion || (preflight.rowExists && !current.rowExists)
}

func uploadObjectJSON(existingJSON map[string]interface{}, bucket string, sizeBytes int64, usageHints []string) ([]byte, error) {
	jsonData := make(map[string]interface{}, len(existingJSON)+3)
	for key, value := range existingJSON {
		jsonData[key] = value
	}
	jsonData["bucket"] = bucket
	jsonData["size_bytes"] = sizeBytes
	if usageHints != nil {
		mergedHints, err := mergeUploadUsageHints(existingJSON["usage_hints"], usageHints)
		if err != nil {
			return nil, err
		}
		jsonData["usage_hints"] = mergedHints
	}

	return marshalValidatedJSONBlob(jsonData, ValidateObjectBlob)
}

func mergeUploadUsageHints(existing interface{}, additions []string) ([]string, error) {
	merged := make([]string, 0, len(additions))
	switch hints := existing.(type) {
	case nil:
	case []interface{}:
		merged = make([]string, 0, len(hints)+len(additions))
		for index, value := range hints {
			hint, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("existing usage_hints[%d] is not a string", index)
			}
			merged = append(merged, hint)
		}
	default:
		return nil, fmt.Errorf("existing usage_hints has unsupported type %T", existing)
	}
	return append(merged, additions...), nil
}

func upsertUploadedObjectMetadata(
	ctx context.Context,
	tx pgx.Tx,
	objectID, objectPath, contentType string,
	objType *string,
	jsonBytes []byte,
	version int64,
) (*models.MediaObject, error) {
	out, err := scanObject(tx.QueryRow(ctx, `
		INSERT INTO objects (object_id, path, content_type, type, json, version)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (object_id) DO UPDATE SET
			path = EXCLUDED.path,
			content_type = EXCLUDED.content_type,
			type = EXCLUDED.type,
			json = EXCLUDED.json,
			updated_at = clock_timestamp(),
			version = EXCLUDED.version
		RETURNING object_id, path, content_type, type, json, created_at, updated_at, version
	`, objectID, objectPath, contentType, objType, jsonBytes, version))
	if err != nil {
		if isUniqueViolation(err) {
			return nil, NewObjectPathConflictError()
		}
		return nil, fmt.Errorf("failed to persist uploaded object metadata: %w", err)
	}
	return out, nil
}

func (a *ObjectActions) cleanupUploadedPathAfterFailure(ctx context.Context, objectID, objectPath string, cause error) error {
	if objectPath == "" {
		return cause
	}
	if err := a.deleteObjectPathOrQueueRetry(ctx, a.storage.Bucket(), objectID, objectPath); err != nil {
		return fmt.Errorf("%w (also %w)", cause, err)
	}
	return cause
}

func (a *ObjectActions) deleteObjectPathOrQueueRetry(ctx context.Context, bucket, objectID, objectPath string) error {
	objectPath = strings.TrimSpace(objectPath)
	if objectPath == "" {
		return nil
	}

	if err := a.storage.DeleteObjectPath(ctx, bucket, objectPath); err != nil {
		if a.pool == nil {
			return fmt.Errorf("failed to remove uploaded object %q for %s: %w", objectPath, objectID, err)
		}
		if queueErr := a.queueStorageDeletionAfterFailure(ctx, bucket, objectPath, objectID, err); queueErr != nil {
			return fmt.Errorf("failed to remove uploaded object %q for %s: %w (also failed to queue storage deletion retry: %w)", objectPath, objectID, err, queueErr)
		}
		return fmt.Errorf("failed to remove uploaded object %q for %s: %w (queued storage deletion retry)", objectPath, objectID, err)
	}
	return nil
}

// Upload uploads a file and creates/updates the object record.
func (a *ObjectActions) Upload(ctx context.Context, objectID string, reader io.Reader, size int64, contentType, objType string, usageHint *string) (*models.MediaObject, error) {
	if err := ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = SanitizeID(objectID)
	if err := validateStringMaxLength("content_type", contentType, objectContentMaxLength); err != nil {
		return nil, err
	}
	if err := validateStringMaxLength("type", objType, objectTypeMaxLength); err != nil {
		return nil, err
	}
	objType = strings.TrimSpace(objType)

	if a.storage == nil {
		return nil, &storage.StorageError{Message: "storage not configured"}
	}
	objectPath := a.storage.NewObjectPath(objectID)
	if err := validateStringMaxLength("path", objectPath, objectPathMaxLength); err != nil {
		return nil, err
	}
	if err := ensureObjectStoragePathAvailable(ctx, a.pool, objectPath, objectID); err != nil {
		return nil, err
	}

	var usageHints []string
	if usageHint != nil && *usageHint != "" {
		usageHints = []string{*usageHint}
	}

	bucket := a.storage.Bucket()
	ownerID := uuid.NewString()
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
	if err := a.createStorageUploadIntentTx(ctx, tx, bucket, objectPath, objectID, ownerID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit upload preflight transaction: %w", err)
	}

	uploadCtx, cancelUpload := context.WithCancel(ctx)
	var heartbeatOnce sync.Once
	heartbeatFailure := make(chan error, 1)
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		a.runStorageUploadHeartbeat(uploadCtx, bucket, objectPath, ownerID, a.uploadHeartbeatPeriod, func(err error) {
			heartbeatOnce.Do(func() {
				heartbeatFailure <- err
				cancelUpload()
			})
		})
	}()

	uploadedInfo, err := a.storage.UploadObjectFromReaderToPath(uploadCtx, objectID, objectPath, reader, size, contentType)
	cancelUpload()
	<-heartbeatDone
	select {
	case heartbeatErr := <-heartbeatFailure:
		err = heartbeatErr
	default:
	}
	if err != nil {
		return nil, a.abandonStorageUpload(ctx, bucket, objectPath, objectID, ownerID, fmt.Errorf("failed to upload to storage: %w", err))
	}

	tx, err = a.beginLockedObjectTx(ctx, objectID, "upload metadata")
	if err != nil {
		return nil, a.abandonStorageUpload(ctx, bucket, objectPath, objectID, ownerID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cleanupMetadataFailure := func(cause error) (*models.MediaObject, error) {
		_ = tx.Rollback(ctx)
		return nil, a.abandonStorageUpload(ctx, bucket, objectPath, objectID, ownerID, cause)
	}
	if err := a.lockOwnedStorageUploadIntentTx(ctx, tx, bucket, objectPath, ownerID); err != nil {
		return cleanupMetadataFailure(err)
	}

	currentState, err := currentObjectStateForUpload(ctx, tx, objectID)
	if err != nil {
		return cleanupMetadataFailure(err)
	}
	if objectDeletedAfterUploadPreflight(preflightState, currentState) {
		return cleanupMetadataFailure(NewObjectNotFoundError(objectID))
	}
	if typePtr == nil && currentState.resource != nil {
		typePtr = currentState.resource.Type
	}

	jsonBytes, err := uploadObjectJSON(currentState.json, bucket, uploadedInfo.SizeBytes, usageHints)
	if err != nil {
		return cleanupMetadataFailure(fmt.Errorf("failed to marshal object metadata JSON: %w", err))
	}

	version, err := nextChangeVersion(ctx, tx)
	if err != nil {
		return cleanupMetadataFailure(err)
	}
	out, err := upsertUploadedObjectMetadata(ctx, tx, objectID, objectPath, contentType, typePtr, jsonBytes, version)
	if err != nil {
		return cleanupMetadataFailure(err)
	}
	var oldBucket, oldPath string
	if currentState.path != nil && strings.TrimSpace(*currentState.path) != "" && *currentState.path != objectPath {
		oldPath = strings.TrimSpace(*currentState.path)
		oldBucket, err = persistedObjectBucket(currentState.resource)
		if err != nil {
			return cleanupMetadataFailure(err)
		}
		if err := a.queueStorageDeletionTx(ctx, tx, oldBucket, oldPath, objectID); err != nil {
			return cleanupMetadataFailure(err)
		}
	}
	if err := a.deleteStorageUploadIntentTx(ctx, tx, bucket, objectPath, ownerID); err != nil {
		return cleanupMetadataFailure(err)
	}

	event := ChangeEventCreate
	if currentState.rowExists {
		event = ChangeEventUpdate
	}
	if err := RecordResourceChange(ctx, tx, ResourceChange{
		Event:        event,
		ResourceType: ChangeResourceObject,
		ID:           out.ObjectID,
		Version:      out.Version,
		AfterObject:  cloneObjectModel(out),
	}); err != nil {
		return cleanupMetadataFailure(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, a.abandonStorageUpload(ctx, bucket, objectPath, objectID, ownerID, fmt.Errorf("failed to commit upload metadata transaction: %w", err))
	}

	if oldPath != "" {
		if err := a.deleteQueuedStoragePathNow(ctx, oldBucket, oldPath); err != nil {
			log.Warn().Err(err).Str("object_id", objectID).Str("old_path", oldPath).Msg("Uploaded object metadata now points to a new blob, but old blob cleanup failed")
		}
	}

	return out, nil
}
