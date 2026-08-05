package actions

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestPruneChangeRecordsExpiresCursorAndPreservesObjectFence(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var baseline, originalMin int64
	if err := pool.QueryRow(ctx, `SELECT version, min_retained_version FROM atlas_change_clock WHERE singleton`).Scan(&baseline, &originalMin); err != nil {
		t.Fatalf("read initial change state: %v", err)
	}
	objectID := fmt.Sprintf("retention-fence-%d", time.Now().UTC().UnixNano())
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM objects WHERE object_id = $1`, objectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM atlas_change_events WHERE event->>'resource_type' = 'object' AND event->>'id' = $1`, objectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM object_deletion_fences WHERE object_id = $1`, objectID)
		_, _ = pool.Exec(cleanupCtx, `UPDATE atlas_change_clock SET min_retained_version = $1 WHERE singleton`, originalMin)
	})

	objectActions := NewObjectActions(pool, nil)
	if _, err := objectActions.Create(ctx, CreateObjectParams{ObjectID: objectID}); err != nil {
		t.Fatalf("create object: %v", err)
	}
	if err := objectActions.Delete(ctx, objectID); err != nil {
		t.Fatalf("delete object: %v", err)
	}
	var deleteVersion int64
	if err := pool.QueryRow(ctx, `
		UPDATE atlas_change_events
		SET created_at = clock_timestamp() - interval '8 days'
		WHERE event->>'resource_type' = 'object' AND event->>'event' = 'delete' AND event->>'id' = $1
		RETURNING version
	`, objectID).Scan(&deleteVersion); err != nil {
		t.Fatalf("age object delete event: %v", err)
	}

	deleted, err := PruneChangeRecords(ctx, pool, time.Now().Add(-ChangeRecordRetention))
	if err != nil {
		t.Fatalf("prune change records: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("pruned records = %d, want 1", deleted)
	}
	_, err = NewQueryActions(pool).GetDataChangedSince(ctx, baseline, 1, nil)
	var expired *CursorExpiredError
	if !errors.As(err, &expired) || expired.MinRetainedVersion != deleteVersion {
		t.Fatalf("changed-since error = %#v, want cursor expired at %d", err, deleteVersion)
	}
	if _, err := NewQueryActions(pool).GetDataChangedSince(ctx, deleteVersion, 1, nil); err != nil {
		t.Fatalf("minimum retained cursor was rejected: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin fence read: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	state, err := currentObjectStateForUpload(ctx, tx, objectID)
	if err != nil {
		t.Fatalf("read upload deletion fence: %v", err)
	}
	if state.maxDeletionVersion != deleteVersion {
		t.Fatalf("object deletion fence = %d, want %d", state.maxDeletionVersion, deleteVersion)
	}
}
