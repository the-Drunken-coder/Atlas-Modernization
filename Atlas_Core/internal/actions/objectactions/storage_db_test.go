package objectactions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/actionstest"
)

func TestCleanupUploadedPathAfterFailureQueuesDeleteRetry(t *testing.T) {
	pool, ctx, cancel := actionstest.OpenPool(t)
	defer cancel()
	defer pool.Close()

	objectID := fmt.Sprintf("cleanup-retry-%d", time.Now().UTC().UnixNano())
	objectPath := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRows(context.Background(), pool, objectID)

	storageClient := &recordingObjectStorage{deleteErr: errors.New("delete failed")}
	objActions := New(pool, storageClient)
	cause := errors.New("commit failed")

	err := objActions.cleanupUploadedPathAfterFailure(ctx, objectID, objectPath, cause)

	if !errors.Is(err, cause) || !errors.Is(err, storageClient.deleteErr) {
		t.Fatalf("cleanupUploadedPathAfterFailure error = %v, want cause and delete error", err)
	}
	if !strings.Contains(err.Error(), "queued storage deletion retry") {
		t.Fatalf("cleanup error should mention queued retry, got %q", err.Error())
	}

	var storedObjectID, lastError string
	var attempts int
	if err := pool.QueryRow(ctx, `
		SELECT object_id, attempts, last_error
		FROM storage_deletion_outbox
		WHERE bucket = 'atlas-media' AND path = $1
	`, objectPath).Scan(&storedObjectID, &attempts, &lastError); err != nil {
		t.Fatalf("query outbox row: %v", err)
	}
	if storedObjectID != objectID {
		t.Fatalf("queued object_id = %q, want %q", storedObjectID, objectID)
	}
	if attempts != 1 {
		t.Fatalf("queued attempts = %d, want 1", attempts)
	}
	if !strings.Contains(lastError, "delete failed") {
		t.Fatalf("queued last_error = %q, want delete failure", lastError)
	}
}

func TestQueueStorageDeletionResetsDuplicateRetryState(t *testing.T) {
	pool, ctx, cancel := actionstest.OpenPool(t)
	defer cancel()
	defer pool.Close()

	objectID := fmt.Sprintf("outbox-reset-%d", time.Now().UTC().UnixNano())
	objectPath := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRows(context.Background(), pool, objectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id, attempts, last_error, next_attempt_at)
		VALUES ('atlas-media', $1, $2, 4, 'old failure', clock_timestamp() + interval '1 hour')
	`, objectPath, objectID); err != nil {
		t.Fatalf("insert outbox row: %v", err)
	}

	objActions := New(pool, &recordingObjectStorage{})
	if err := objActions.queueStorageDeletion(ctx, "atlas-media", objectPath, objectID+"-new"); err != nil {
		t.Fatalf("queueStorageDeletion: %v", err)
	}

	var storedObjectID string
	var attempts int
	var lastError *string
	var dueNow bool
	if err := pool.QueryRow(ctx, `
		SELECT object_id, attempts, last_error, next_attempt_at <= clock_timestamp()
		FROM storage_deletion_outbox
		WHERE bucket = 'atlas-media' AND path = $1
	`, objectPath).Scan(&storedObjectID, &attempts, &lastError, &dueNow); err != nil {
		t.Fatalf("query outbox row: %v", err)
	}
	if storedObjectID != objectID+"-new" {
		t.Fatalf("object_id = %q, want refreshed id", storedObjectID)
	}
	if attempts != 0 {
		t.Fatalf("attempts = %d, want reset to 0", attempts)
	}
	if lastError != nil {
		t.Fatalf("last_error = %q, want nil", *lastError)
	}
	if !dueNow {
		t.Fatal("next_attempt_at should be due immediately after duplicate queue")
	}
}

func TestReconcileStorageDeletionsDeletesQueuedPath(t *testing.T) {
	pool, ctx, cancel := actionstest.OpenPool(t)
	defer cancel()
	defer pool.Close()

	objectID := fmt.Sprintf("outbox-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRows(context.Background(), pool, objectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id)
		VALUES ('atlas-media', $1, $2)
	`, path, objectID); err != nil {
		t.Fatalf("insert outbox row: %v", err)
	}

	storageClient := &recordingObjectStorage{}
	objActions := New(pool, storageClient)
	deleted, err := objActions.ReconcileStorageDeletions(ctx, 10)
	if err != nil {
		t.Fatalf("ReconcileStorageDeletions: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}
	if len(storageClient.deletedPaths) != 1 || storageClient.deletedPaths[0] != path {
		t.Fatalf("deleted paths = %#v, want %q", storageClient.deletedPaths, path)
	}

	var rowExists bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM storage_deletion_outbox
			WHERE bucket = 'atlas-media' AND path = $1
		)
	`, path).Scan(&rowExists); err != nil {
		t.Fatalf("check outbox row: %v", err)
	}
	if rowExists {
		t.Fatal("outbox row still exists after successful reconciliation")
	}
}

func TestUploadDoesNotResurrectObjectDeletedDuringBlobWrite(t *testing.T) {
	pool, ctx, cancel := actionstest.OpenPool(t)
	defer cancel()
	defer pool.Close()

	storageClient := newBlockingObjectStorage()
	defer storageClient.releaseUpload()
	objActions := New(pool, storageClient)

	objectID := fmt.Sprintf("race-%d", time.Now().UTC().UnixNano())
	initialPath := fmt.Sprintf("objects/%s/initial", objectID)
	contentType := "text/plain"
	sizeBytes := int64(3)
	defer cleanupObjectRaceTestRows(context.Background(), pool, objectID)

	if _, err := objActions.Create(ctx, CreateParams{
		ObjectID:    objectID,
		Path:        &initialPath,
		ContentType: &contentType,
		SizeBytes:   &sizeBytes,
	}); err != nil {
		t.Fatalf("create initial object: %v", err)
	}

	uploadErr := make(chan error, 1)
	go func() {
		_, err := objActions.Upload(ctx, objectID, strings.NewReader("new"), sizeBytes, contentType, "data", nil)
		uploadErr <- err
	}()

	uploadedPath := storageClient.waitForUploadStart(t)

	deleteCtx, deleteCancel := context.WithTimeout(ctx, 2*time.Second)
	defer deleteCancel()
	if err := objActions.Delete(deleteCtx, objectID); err != nil {
		t.Fatalf("delete while upload storage write is paused: %v", err)
	}

	storageClient.releaseUpload()

	select {
	case err := <-uploadErr:
		var notFound *actions.NotFoundError
		if !errors.As(err, &notFound) {
			t.Fatalf("upload error = %v, want object not found after concurrent delete", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish after storage write was released")
	}

	var rowExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM objects WHERE object_id = $1)`, objectID).Scan(&rowExists); err != nil {
		t.Fatalf("check object row: %v", err)
	}
	if rowExists {
		t.Fatal("object row was resurrected after delete won the upload race")
	}
	if !storageClient.deletedPath(initialPath) {
		t.Fatalf("delete did not remove initial path %q; deleted paths = %#v", initialPath, storageClient.deletedPathsSnapshot())
	}
	if !storageClient.deletedPath(uploadedPath) {
		t.Fatalf("failed upload did not clean uploaded path %q; deleted paths = %#v", uploadedPath, storageClient.deletedPathsSnapshot())
	}
}

func cleanupObjectRaceTestRows(ctx context.Context, pool *pgxpool.Pool, objectID string) {
	_, _ = pool.Exec(ctx, `DELETE FROM objects WHERE object_id = $1`, objectID)
	_, _ = pool.Exec(ctx, `DELETE FROM deletions WHERE resource_type = 'object' AND resource_id = $1`, objectID)
	_, _ = pool.Exec(ctx, `DELETE FROM storage_deletion_outbox WHERE object_id = $1`, objectID)
}
