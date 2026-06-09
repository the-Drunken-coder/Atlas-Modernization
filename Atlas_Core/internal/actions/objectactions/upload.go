package objectactions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/storage"
)

func objectUploadLockKey(objectID string) string {
	return "atlas-core-object-upload:" + objectID
}

func (a *Actions) beginLockedObjectTx(ctx context.Context, objectID, operation string) (pgx.Tx, error) {
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to begin %s transaction: %w", operation, err)
	}

	if err := actions.LockChangeVersion(ctx, tx); err != nil {
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

	if err := actions.ValidateObjectBlob(jsonData); err != nil {
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
		if actions.IsUniqueViolation(err) {
			return nil, actions.NewObjectPathConflictError()
		}
		return nil, fmt.Errorf("failed to persist uploaded object metadata: %w", err)
	}
	return &out, nil
}

func (a *Actions) cleanupUploadedPathAfterFailure(ctx context.Context, objectID, objectPath string, cause error) error {
	if objectPath == "" {
		return cause
	}
	if err := a.deleteObjectPathOrQueueRetry(ctx, objectID, objectPath); err != nil {
		return fmt.Errorf("%w (also %w)", cause, err)
	}
	return cause
}

func (a *Actions) deleteObjectPathOrQueueRetry(ctx context.Context, objectID, objectPath string) error {
	objectPath = strings.TrimSpace(objectPath)
	if objectPath == "" {
		return nil
	}

	if err := a.storage.DeleteObjectPath(ctx, objectPath); err != nil {
		if a.pool == nil {
			return fmt.Errorf("failed to remove uploaded object %q for %s: %w", objectPath, objectID, err)
		}
		if queueErr := a.queueStorageDeletionAfterFailure(ctx, a.storage.Bucket(), objectPath, objectID, err); queueErr != nil {
			return fmt.Errorf("failed to remove uploaded object %q for %s: %w (also failed to queue storage deletion retry: %w)", objectPath, objectID, err, queueErr)
		}
		return fmt.Errorf("failed to remove uploaded object %q for %s: %w (queued storage deletion retry)", objectPath, objectID, err)
	}
	return nil
}

// Upload uploads a file and creates/updates the object record.
func (a *Actions) Upload(ctx context.Context, objectID string, reader io.Reader, size int64, contentType, objType string, usageHint *string) (*models.MediaObject, error) {
	if err := actions.ValidateObjectID(objectID); err != nil {
		return nil, err
	}
	objectID = actions.SanitizeID(objectID)

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

	// The storage bucket is disposable runtime scratch. If the blob write
	// succeeds but metadata never commits, the orphan is acceptable until the
	// bucket is cleared/reset by the normal startup path.
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
	cleanupMetadataFailure := func(cause error) (*models.MediaObject, error) {
		_ = tx.Rollback(ctx)
		return nil, a.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, cause)
	}

	currentState, err := currentObjectStateForUpload(ctx, tx, objectID)
	if err != nil {
		return cleanupMetadataFailure(err)
	}
	if objectDeletedAfterUploadPreflight(preflightState, currentState) {
		return cleanupMetadataFailure(actions.NewObjectNotFoundError(objectID))
	}

	jsonBytes, err := uploadObjectJSON(currentState.json, bucket, uploadedInfo.SizeBytes, usageHints)
	if err != nil {
		return cleanupMetadataFailure(fmt.Errorf("failed to marshal object metadata JSON: %w", err))
	}

	out, err := upsertUploadedObjectMetadata(ctx, tx, objectID, objectPath, contentType, typePtr, jsonBytes)
	if err != nil {
		return cleanupMetadataFailure(err)
	}

	var queuedOldBucket, queuedOldPath string
	if currentState.path != nil {
		oldPath := strings.TrimSpace(*currentState.path)
		if oldPath != "" && oldPath != objectPath {
			queuedOldBucket = strings.TrimSpace(bucket)
			queuedOldPath = oldPath
			if err := a.queueStorageDeletionTx(ctx, tx, queuedOldBucket, queuedOldPath, objectID); err != nil {
				return cleanupMetadataFailure(err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, a.cleanupUploadedPathAfterFailure(
			ctx,
			objectID,
			objectPath,
			fmt.Errorf("failed to commit upload metadata transaction: %w", err),
		)
	}

	if queuedOldPath != "" {
		if err := a.attemptQueuedStorageDeletion(ctx, queuedOldBucket, queuedOldPath, objectID); err != nil {
			log.Warn().Err(err).Str("object_id", objectID).Str("old_path", queuedOldPath).Msg("Uploaded object metadata now points to a new blob, but queued old blob cleanup did not complete")
		}
	}

	return out, nil
}
