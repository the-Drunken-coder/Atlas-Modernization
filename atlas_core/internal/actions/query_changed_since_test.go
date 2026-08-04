package actions

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

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
	if _, err := entityActions.Update(ctx, id, UpdateEntityParams{Alias: &alias, ExpectedVersion: &created.Version}); err != nil {
		t.Fatalf("update entity: %v", err)
	}
	if err := entityActions.Delete(ctx, id); err != nil {
		t.Fatalf("delete entity: %v", err)
	}

	var cursor *string
	var versions []int64
	for {
		page, err := NewQueryActions(pool).GetDataChangedSince(ctx, baseline, 1, cursor)
		if err != nil {
			t.Fatalf("changed-since page: %v", err)
		}
		if len(page.Events) != 1 {
			t.Fatalf("page events = %d, want 1", len(page.Events))
		}
		versions = append(versions, page.Events[0].Version)
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
	for index := 1; index < len(versions); index++ {
		if versions[index] <= versions[index-1] {
			t.Fatalf("event versions are not globally ordered: %v", versions)
		}
	}
}

func TestRolledBackChangeVersionIsNotBurned(t *testing.T) {
	pool := openActionsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	before, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read version before rollback: %v", err)
	}
	tx, err := beginChangeTx(ctx, pool, "rollback test")
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	allocated, err := nextChangeVersion(ctx, tx)
	if err != nil {
		t.Fatalf("allocate version: %v", err)
	}
	if allocated != before+1 {
		t.Fatalf("allocated version = %d, want %d", allocated, before+1)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback transaction: %v", err)
	}
	after, err := CurrentChangeVersion(ctx, pool)
	if err != nil {
		t.Fatalf("read version after rollback: %v", err)
	}
	if after != before {
		t.Fatalf("rollback advanced version from %d to %d", before, after)
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
