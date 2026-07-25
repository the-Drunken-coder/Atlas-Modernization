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
