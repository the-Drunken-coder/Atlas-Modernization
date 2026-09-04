package actions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestQueueStorageDeletionRequeueResetsRetryState(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("requeue-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id, attempts, last_error, next_attempt_at)
		VALUES ('atlas-media', $1, $2, 5, 'old backoff', 'infinity'::timestamptz)
	`, path, "old-"+objectID); err != nil {
		t.Fatalf("insert stale outbox row: %v", err)
	}

	actions := NewObjectActions(pool, nil)
	if err := actions.queueStorageDeletionWithSQL(ctx, queueStorageDeletionSQL, "atlas-media", path, objectID); err != nil {
		t.Fatalf("queueStorageDeletion: %v", err)
	}

	var gotObjectID string
	var attempts int
	var lastError *string
	var dueNow bool
	if err := pool.QueryRow(ctx, `
		SELECT object_id, attempts, last_error, next_attempt_at <= clock_timestamp()
		FROM storage_deletion_outbox
		WHERE bucket = 'atlas-media' AND path = $1
	`, path).Scan(&gotObjectID, &attempts, &lastError, &dueNow); err != nil {
		t.Fatalf("query requeued outbox row: %v", err)
	}
	if gotObjectID != objectID {
		t.Fatalf("object_id = %q, want %q", gotObjectID, objectID)
	}
	if attempts != 0 {
		t.Fatalf("attempts = %d, want 0", attempts)
	}
	if lastError != nil {
		t.Fatalf("last_error = %q, want nil", *lastError)
	}
	if !dueNow {
		t.Fatal("next_attempt_at was not reset to an immediately due timestamp")
	}
}

func TestQueueStorageDeletionAfterFailurePreservesRetryAttempts(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("failure-requeue-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id, attempts, last_error, next_attempt_at)
		VALUES ('atlas-media', $1, $2, 5, 'old failure', clock_timestamp() + interval '1 hour')
	`, path, "old-"+objectID); err != nil {
		t.Fatalf("insert retrying outbox row: %v", err)
	}

	actions := NewObjectActions(pool, nil)
	if err := actions.queueStorageDeletionAfterFailure(ctx, "atlas-media", path, objectID, errors.New("delete failed again")); err != nil {
		t.Fatalf("queueStorageDeletionAfterFailure: %v", err)
	}

	var gotObjectID string
	var attempts int
	var lastError string
	var nextAttemptInFuture bool
	if err := pool.QueryRow(ctx, `
		SELECT object_id, attempts, last_error, next_attempt_at > clock_timestamp()
		FROM storage_deletion_outbox
		WHERE bucket = 'atlas-media' AND path = $1
	`, path).Scan(&gotObjectID, &attempts, &lastError, &nextAttemptInFuture); err != nil {
		t.Fatalf("query retrying outbox row: %v", err)
	}
	if gotObjectID != objectID {
		t.Fatalf("object_id = %q, want %q", gotObjectID, objectID)
	}
	if attempts != 6 {
		t.Fatalf("attempts = %d, want 6", attempts)
	}
	if lastError != "delete failed again" {
		t.Fatalf("last_error = %q, want delete failed again", lastError)
	}
	if !nextAttemptInFuture {
		t.Fatal("next_attempt_at was not scheduled for a future retry")
	}
}

func TestReconcileStorageDeletionDrainsQueueAfterUploadRecoveryFailure(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	recoveryObjectID := fmt.Sprintf("recovery-failure-%d", time.Now().UTC().UnixNano())
	recoveryPath := fmt.Sprintf("objects/%s/blob", recoveryObjectID)
	queuedObjectID := fmt.Sprintf("queued-after-recovery-failure-%d", time.Now().UTC().UnixNano())
	queuedPath := fmt.Sprintf("objects/%s/blob", queuedObjectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, recoveryObjectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, queuedObjectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_upload_intents
			(bucket, path, object_id, owner_id, expires_at, orphaned_at)
		VALUES ('atlas-media', $1, $2, $3, clock_timestamp() - interval '11 minutes', clock_timestamp() - interval '6 minutes')
	`, recoveryPath, recoveryObjectID, uuid.NewString()); err != nil {
		t.Fatalf("insert recoverable upload intent: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id)
		VALUES ('atlas-media', $1, $2)
	`, queuedPath, queuedObjectID); err != nil {
		t.Fatalf("insert independent queued deletion: %v", err)
	}

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	functionIdentifier := pgx.Identifier{"fail_recovery_outbox_function_" + suffix}.Sanitize()
	triggerIdentifier := pgx.Identifier{"fail_recovery_outbox_trigger_" + suffix}.Sanitize()
	if _, err := pool.Exec(ctx, `CREATE FUNCTION `+functionIdentifier+`() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			RAISE EXCEPTION 'forced upload recovery failure';
		END
	$$`); err != nil {
		t.Fatalf("create recovery failure function: %v", err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER `+triggerIdentifier+`
		BEFORE INSERT ON storage_deletion_outbox
		FOR EACH ROW WHEN (NEW.path = '`+strings.ReplaceAll(recoveryPath, "'", "''")+`')
		EXECUTE FUNCTION `+functionIdentifier+`()`); err != nil {
		t.Fatalf("create recovery failure trigger: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DROP TRIGGER IF EXISTS "+triggerIdentifier+" ON storage_deletion_outbox")
		_, _ = pool.Exec(cleanupCtx, "DROP FUNCTION IF EXISTS "+functionIdentifier+"()")
	})
	unrelatedPath := recoveryPath + "-unrelated"
	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id)
		VALUES ('atlas-media', $1, $2)
	`, unrelatedPath, recoveryObjectID); err != nil {
		t.Fatalf("insert unrelated outbox row while failure trigger is active: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM storage_deletion_outbox WHERE path = $1`, unrelatedPath); err != nil {
		t.Fatalf("clear unrelated outbox row: %v", err)
	}

	storageClient := &recordingObjectStorage{}
	deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, 10)
	if err == nil || !strings.Contains(err.Error(), "forced upload recovery failure") {
		t.Fatalf("ReconcileStorageDeletions error = %v, want recovery failure", err)
	}
	if deleted != 1 || len(storageClient.deletedPaths) != 1 || storageClient.deletedPaths[0] != queuedPath {
		t.Fatalf("reconciliation deleted=%d paths=%#v, want independent path %q", deleted, storageClient.deletedPaths, queuedPath)
	}

	var intentExists, pathTombstoned bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_upload_intents WHERE path = $1)`, recoveryPath).Scan(&intentExists); err != nil {
		t.Fatalf("check rolled-back upload intent: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM storage_deletion_outbox
			WHERE path = $1 AND next_attempt_at = 'infinity'::timestamptz
		)
	`, queuedPath).Scan(&pathTombstoned); err != nil {
		t.Fatalf("check drained deletion row: %v", err)
	}
	if !intentExists || !pathTombstoned {
		t.Fatalf("post-reconcile rows = intent:%t path-tombstone:%t, want true/true", intentExists, pathTombstoned)
	}
}

func TestReconcileStorageDeletionPreservesPathThatBecameLive(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("live-deletion-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	createStoredObjectFixture(ctx, t, pool, objectID, path)
	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id)
		VALUES ('atlas-media', $1, $2)
	`, path, objectID); err != nil {
		t.Fatalf("insert queued deletion: %v", err)
	}

	storageClient := &recordingObjectStorage{}
	deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, 10)
	if err != nil {
		t.Fatalf("ReconcileStorageDeletions: %v", err)
	}
	if deleted != 0 || len(storageClient.deletedPaths) != 0 {
		t.Fatalf("reconciliation deleted=%d paths=%#v, want live path preserved", deleted, storageClient.deletedPaths)
	}

	var outboxExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_deletion_outbox WHERE path = $1)`, path).Scan(&outboxExists); err != nil {
		t.Fatalf("check deletion outbox: %v", err)
	}
	if outboxExists {
		t.Fatal("live path remained queued for deletion")
	}
}

func TestReconcileStorageDeletionRejectsLivePathWithoutBucket(t *testing.T) {
	pool := openActionsTestPool(t)
	for _, tt := range []struct {
		name     string
		metadata string
	}{
		{name: "missing", metadata: `{"size_bytes":3}`},
		{name: "blank", metadata: `{"bucket":" ","size_bytes":3}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			objectID := fmt.Sprintf("invalid-live-deletion-%s-%d", tt.name, time.Now().UTC().UnixNano())
			path := fmt.Sprintf("objects/%s/blob", objectID)
			defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

			createStoredObjectFixture(ctx, t, pool, objectID, path)
			if _, err := pool.Exec(ctx, `UPDATE objects SET json = $2::jsonb WHERE object_id = $1`, objectID, tt.metadata); err != nil {
				t.Fatalf("set invalid bucket metadata: %v", err)
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO storage_deletion_outbox (bucket, path, object_id)
				VALUES ('atlas-media', $1, $2)
			`, path, objectID); err != nil {
				t.Fatalf("insert queued deletion: %v", err)
			}

			storageClient := &recordingObjectStorage{}
			deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, 10)
			if err == nil || !strings.Contains(err.Error(), "missing bucket metadata") {
				t.Fatalf("ReconcileStorageDeletions error = %v, want missing bucket metadata", err)
			}
			if deleted != 0 || len(storageClient.deletedObjects) != 0 {
				t.Fatalf("reconciliation deleted=%d objects=%#v, want none", deleted, storageClient.deletedObjects)
			}

			var outboxExists bool
			if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_deletion_outbox WHERE path = $1)`, path).Scan(&outboxExists); err != nil {
				t.Fatalf("check deletion outbox: %v", err)
			}
			if !outboxExists {
				t.Fatal("invalid live path was removed from the deletion outbox")
			}
		})
	}
}

func TestReconcileStorageDeletionUsesQueuedBucketForSamePath(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("same-path-bucket-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	createStoredObjectFixture(ctx, t, pool, objectID, path)
	if _, err := pool.Exec(ctx, `UPDATE objects SET json = '{"bucket":"atlas-current"}'::jsonb WHERE object_id = $1`, objectID); err != nil {
		t.Fatalf("set current object bucket: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id)
		VALUES ('atlas-old', $1, $2)
	`, path, objectID); err != nil {
		t.Fatalf("insert old-bucket outbox row: %v", err)
	}

	storageClient := &recordingObjectStorage{bucket: "atlas-current"}
	deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, 10)
	if err != nil {
		t.Fatalf("ReconcileStorageDeletions: %v", err)
	}
	if deleted != 1 || len(storageClient.deletedObjects) != 1 || storageClient.deletedObjects[0] != (recordedStorageDelete{bucket: "atlas-old", path: path}) {
		t.Fatalf("reconciliation deleted=%d objects=%#v, want atlas-old/%q", deleted, storageClient.deletedObjects, path)
	}
}
