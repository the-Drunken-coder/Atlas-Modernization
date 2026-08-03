package actions

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
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
		VALUES ('atlas-media', $1, $2, 5, 'old backoff', clock_timestamp() + interval '1 hour')
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

func TestCreateRejectsPathWhenQueuedDeletionClearsBeforeWriteLock(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
					AND query LIKE '%pg_advisory_xact_lock%'
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

	if _, err := pool.Exec(ctx, `DELETE FROM storage_deletion_outbox WHERE path = $1`, path); err != nil {
		t.Fatalf("clear queued deletion: %v", err)
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
		t.Fatal("Create committed a path whose queued blob deletion had completed")
	}
}
