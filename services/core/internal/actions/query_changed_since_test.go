package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestChangedSinceDefaultsToSmallPages(t *testing.T) {
	if got := changedSinceLimit(0); got != DefaultChangedSinceLimit {
		t.Fatalf("default changed-since limit = %d, want %d", got, DefaultChangedSinceLimit)
	}
	if got := changedSinceLimit(MaxChangedSinceLimit + 1); got != MaxChangedSinceLimit {
		t.Fatalf("capped changed-since limit = %d, want %d", got, MaxChangedSinceLimit)
	}
}

func TestChangedSincePagesNearMaximumResourcesByBytes(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	baseline, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read baseline version: %v", err)
	}
	entityActions := NewEntityActions(pool)
	const eventCount = 10
	ids := make([]string, 0, eventCount)
	for index := 0; index < eventCount; index++ {
		id := fmt.Sprintf("changed-byte-%d-%02d", time.Now().UTC().UnixNano(), index)
		if _, err := entityActions.Create(ctx, CreateEntityParams{
			EntityID:   id,
			EntityType: "asset",
			Extra: map[string]interface{}{
				"payload": strings.Repeat("x", maxStoredJSONBlobBytes-32*1024),
			},
		}); err != nil {
			t.Fatalf("create near-maximum entity %d: %v", index, err)
		}
		ids = append(ids, id)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM entities WHERE entity_id = ANY($1)`, ids)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM atlas_change_events WHERE event->>'resource_type' = 'entity' AND event->>'id' = ANY($1)`, ids)
	})

	var cursor *string
	seen := 0
	pageCount := 0
	for {
		page, err := NewQueryActions(pool).GetDataChangedSince(ctx, baseline, MaxChangedSinceLimit, cursor)
		if err != nil {
			t.Fatalf("read byte-bounded changed-since page: %v", err)
		}
		pageCount++
		pageBytes := 0
		for _, event := range page.Events {
			payload, err := json.Marshal(event)
			if err != nil {
				t.Fatalf("marshal returned event: %v", err)
			}
			pageBytes += len(payload)
			for _, id := range ids {
				if event.ID == id {
					seen++
				}
			}
		}
		if len(page.Events) > 1 && pageBytes > maxChangedSinceJSONBytes {
			t.Fatalf("changed-since page retained %d bytes, budget %d", pageBytes, maxChangedSinceJSONBytes)
		}
		if !page.HasMore {
			break
		}
		if page.NextCursor == "" {
			t.Fatal("byte-bounded page has_more without next_cursor")
		}
		cursor = &page.NextCursor
	}
	if pageCount < 2 || seen != eventCount {
		t.Fatalf("byte-bounded recovery used %d pages and returned %d/%d target events", pageCount, seen, eventCount)
	}
}

func TestChangedSincePagesOneOrderedDurableStream(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	id := fmt.Sprintf("changed-stream-%d", time.Now().UTC().UnixNano())
	baseline, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read baseline version: %v", err)
	}
	entityActions := NewEntityActions(pool)
	created, err := entityActions.Create(ctx, CreateEntityParams{EntityID: id, EntityType: "asset"})
	if err != nil {
		t.Fatalf("create entity: %v", err)
	}
	alias := "changed-stream"
	updated, err := entityActions.Update(ctx, id, UpdateEntityParams{Alias: &alias, ExpectedVersion: &created.Version})
	if err != nil {
		t.Fatalf("update entity: %v", err)
	}
	if err := entityActions.Delete(ctx, id); err != nil {
		t.Fatalf("delete entity: %v", err)
	}

	var cursor *string
	var versions []int64
	var events []ChangeEvent
	var snapshotVersion int64
	for pageNumber := 0; ; pageNumber++ {
		if pageNumber >= 1000 {
			t.Fatalf("changed-since page budget exhausted with %d/3 target events seen", len(versions))
		}
		page, err := NewQueryActions(pool).GetDataChangedSince(ctx, baseline, 1, cursor)
		if err != nil {
			t.Fatalf("changed-since page: %v", err)
		}
		if snapshotVersion == 0 {
			snapshotVersion = page.Version
		} else if page.Version != snapshotVersion {
			t.Fatalf("page version = %d, want stable snapshot version %d", page.Version, snapshotVersion)
		}
		if len(page.Events) == 0 {
			t.Fatalf("changed-since returned an empty trailing page (has_more=%v)", page.HasMore)
		}
		if len(page.Events) != 1 {
			t.Fatalf("page events = %d, want 1", len(page.Events))
		}
		if event := page.Events[0]; event.ResourceType == ChangeResourceEntity && event.ID == id {
			versions = append(versions, event.Version)
			events = append(events, event.Event)
		}
		if !page.HasMore {
			break
		}
		if page.NextCursor == "" {
			t.Fatal("page has_more without next_cursor")
		}
		cursor = &page.NextCursor
	}
	if len(versions) != 3 {
		t.Fatalf("event versions = %v, want create, update, delete", versions)
	}
	if versions[0] != created.Version || versions[1] != updated.Version || versions[2] <= updated.Version {
		t.Fatalf("event versions = %v, want create %d, update %d, then a newer delete", versions, created.Version, updated.Version)
	}
	if events[0] != ChangeEventCreate || events[1] != ChangeEventUpdate || events[2] != ChangeEventDelete {
		t.Fatalf("events = %v, want create, update, delete", events)
	}
	nextPoll, err := NewQueryActions(pool).GetDataChangedSince(ctx, snapshotVersion, MaxChangedSinceLimit, nil)
	if err != nil {
		t.Fatalf("changed-since from drained snapshot: %v", err)
	}
	for _, event := range nextPoll.Events {
		if event.ResourceType == ChangeResourceEntity && event.ID == id {
			t.Fatalf("drained event repeated after snapshot boundary: %#v", event)
		}
	}
}

func TestRolledBackChangeVersionIsNotBurned(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tx, err := beginChangeTx(ctx, pool, "rollback test")
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	allocated, err := nextChangeVersion(ctx, tx)
	if err != nil {
		t.Fatalf("allocate version: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback transaction: %v", err)
	}

	id := fmt.Sprintf("rollback-version-%d", time.Now().UTC().UnixNano())
	created, err := NewEntityActions(pool).Create(ctx, CreateEntityParams{EntityID: id, EntityType: "asset"})
	if err != nil {
		t.Fatalf("create entity after rollback: %v", err)
	}
	defer func() { _ = NewEntityActions(pool).Delete(context.Background(), id) }()
	if created.Version == allocated {
		return
	}
	if created.Version < allocated {
		t.Fatalf("created version = %d, want at least rolled-back allocation %d", created.Version, allocated)
	}
	var committedAtAllocated bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM atlas_change_events WHERE version = $1)`, allocated).Scan(&committedAtAllocated); err != nil {
		t.Fatalf("check intervening committed version: %v", err)
	}
	if !committedAtAllocated {
		t.Fatalf("rolled-back version %d was skipped before created version %d", allocated, created.Version)
	}
}

func TestChangedSinceRejectsFutureVersion(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	current, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read current version: %v", err)
	}
	_, err = NewQueryActions(pool).GetDataChangedSince(ctx, current+1, 1, nil)
	var validationErr *ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("future since_version error = %v, want ValidationError", err)
	}
}

func TestChangedSinceRejectsPointerToBlankCursor(t *testing.T) {
	pool := openActionsTestPool(t)
	blank := "  "
	_, err := NewQueryActions(pool).GetDataChangedSince(context.Background(), 0, 1, &blank)
	var validationErr *ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("blank cursor error = %T %v, want ValidationError", err, err)
	}
}

func TestChangedSinceReturnsDatabaseErrorFromClosedPool(t *testing.T) {
	pool := openActionsTestPool(t)
	pool.Close()

	_, err := NewQueryActions(pool).GetDataChangedSince(context.Background(), 0, 1, nil)
	if err == nil {
		t.Fatal("expected closed pool to return an error")
	}
}
