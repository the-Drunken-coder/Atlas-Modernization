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

	if _, err := pool.Exec(ctx, `INSERT INTO objects (object_id, path) VALUES ($1, $2)`, objectID, path); err != nil {
		t.Fatalf("insert live object: %v", err)
	}
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

func TestCreateRejectsPathWhileReconcileDeletesBlob(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("deletion-create-race-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id)
		VALUES ('atlas-media', $1, $2)
	`, path, objectID); err != nil {
		t.Fatalf("insert queued deletion: %v", err)
	}

	storageClient := newPausingDeleteObjectStorage()
	defer storageClient.releaseDelete()
	type reconcileResult struct {
		deleted int
		err     error
	}
	reconcileDone := make(chan reconcileResult, 1)
	go func() {
		deleted, err := NewObjectActions(pool, storageClient).ReconcileStorageDeletions(ctx, 10)
		reconcileDone <- reconcileResult{deleted: deleted, err: err}
	}()
	if deletedPath := storageClient.waitForDeleteStart(t); deletedPath != path {
		t.Fatalf("reconciler deleting %q, want %q", deletedPath, path)
	}

	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin write blocker: %v", err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if err := lockChangeVersion(ctx, blocker); err != nil {
		t.Fatalf("lock object writes: %v", err)
	}
	var blockerPID int32
	if err := blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatalf("read blocker backend pid: %v", err)
	}

	createDone := make(chan error, 1)
	go func() {
		_, err := NewObjectActions(pool, nil).Create(ctx, CreateObjectParams{ObjectID: objectID, Path: &path})
		createDone <- err
	}()

	var createErr error
	createReturned := false
	deadline := time.Now().Add(5 * time.Second)
waitForCreate:
	for {
		select {
		case createErr = <-createDone:
			createReturned = true
			break waitForCreate
		default:
		}

		var blocked bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_stat_activity
				WHERE $1 = ANY(pg_blocking_pids(pid))
					AND wait_event_type = 'Lock'
			)
		`, blockerPID).Scan(&blocked); err != nil {
			t.Fatalf("check blocked Create: %v", err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Create neither rejected the queued path nor waited for the write lock")
		}
		time.Sleep(10 * time.Millisecond)
	}

	storageClient.releaseDelete()
	select {
	case result := <-reconcileDone:
		if result.err != nil || result.deleted != 1 {
			t.Fatalf("reconciliation result = (%d, %v), want (1, nil)", result.deleted, result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reconciliation did not finish after storage deletion")
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release write blocker: %v", err)
	}

	if !createReturned {
		select {
		case createErr = <-createDone:
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent Create did not finish")
		}
	}
	var conflict *ConflictError
	if !errors.As(createErr, &conflict) {
		t.Fatalf("concurrent Create error = %v, want object path conflict", createErr)
	}

	var objectExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM objects WHERE object_id = $1)`, objectID).Scan(&objectExists); err != nil {
		t.Fatalf("check object row: %v", err)
	}
	if objectExists {
		t.Fatal("Create committed metadata for a blob deleted by reconciliation")
	}
}

func TestCreateRejectsDeletedPathAfterPassingPreflight(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	objectID := fmt.Sprintf("deletion-preflight-race-%d", time.Now().UTC().UnixNano())
	path := fmt.Sprintf("objects/%s/blob", objectID)
	defer cleanupObjectRaceTestRowsWithTimeout(t, pool, objectID)

	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin write blocker: %v", err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if err := lockChangeVersion(ctx, blocker); err != nil {
		t.Fatalf("lock object writes: %v", err)
	}
	var blockerPID int32
	if err := blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatalf("read blocker backend pid: %v", err)
	}

	createDone := make(chan error, 1)
	go func() {
		_, err := NewObjectActions(pool, nil).Create(ctx, CreateObjectParams{ObjectID: objectID, Path: &path})
		createDone <- err
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_locks waiting
				JOIN pg_locks held
					ON waiting.locktype = held.locktype
					AND waiting.database IS NOT DISTINCT FROM held.database
					AND waiting.classid IS NOT DISTINCT FROM held.classid
					AND waiting.objid IS NOT DISTINCT FROM held.objid
					AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
				WHERE waiting.locktype = 'advisory'
					AND NOT waiting.granted
					AND held.granted
					AND held.pid = $1
			)
		`, blockerPID).Scan(&blocked); err != nil {
			t.Fatalf("check blocked Create: %v", err)
		}
		if blocked {
			break
		}
		select {
		case createErr := <-createDone:
			t.Fatalf("Create returned before the deletion reservation appeared: %v", createErr)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("Create did not pass preflight and wait for the write lock")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO storage_deletion_outbox (bucket, path, object_id)
		VALUES ('atlas-media', $1, $2)
	`, path, objectID); err != nil {
		t.Fatalf("insert concurrent deletion reservation: %v", err)
	}
	storageClient := &recordingObjectStorage{}
	if err := NewObjectActions(pool, storageClient).deleteQueuedStoragePathNow(ctx, "atlas-media", path); err != nil {
		t.Fatalf("complete concurrent storage deletion: %v", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release write blocker: %v", err)
	}

	select {
	case createErr := <-createDone:
		var conflict *ConflictError
		if !errors.As(createErr, &conflict) {
			t.Fatalf("concurrent Create error = %v, want object path conflict", createErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Create did not finish after releasing the write lock")
	}
	if len(storageClient.deletedPaths) != 1 || storageClient.deletedPaths[0] != path {
		t.Fatalf("deleted paths = %#v, want %q", storageClient.deletedPaths, path)
	}

	var objectExists, pathTombstoned bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM objects WHERE object_id = $1)`, objectID).Scan(&objectExists); err != nil {
		t.Fatalf("check object row: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM storage_deletion_outbox
			WHERE path = $1 AND next_attempt_at = 'infinity'::timestamptz
		)
	`, path).Scan(&pathTombstoned); err != nil {
		t.Fatalf("check completed path tombstone: %v", err)
	}
	if objectExists || !pathTombstoned {
		t.Fatalf("post-race state = object:%t path-tombstone:%t, want false/true", objectExists, pathTombstoned)
	}
}
