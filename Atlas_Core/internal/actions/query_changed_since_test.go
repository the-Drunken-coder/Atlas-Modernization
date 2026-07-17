package actions

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/models"
)

func TestParseChangedSinceCursorsPreservesIndependentStreams(t *testing.T) {
	cursor, err := encodeVersionCursor(42, "row", 100, 7)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	cursors := &ChangedSinceCursors{
		EntityCursor:        &cursor,
		TaskCursor:          &cursor,
		ObjectCursor:        &cursor,
		DeletedEntityCursor: &cursor,
		DeletedTaskCursor:   &cursor,
		DeletedObjectCursor: &cursor,
	}

	parsed, err := parseChangedSinceCursors(cursors)
	if err != nil {
		t.Fatalf("parse changed-since cursors: %v", err)
	}
	if upper, continuation, err := parsed.snapshot(7, 100); err != nil || upper != 100 || !continuation {
		t.Fatalf("snapshot = (%d, %v, %v), want (100, true, nil)", upper, continuation, err)
	}
	for name, parsedCursor := range map[string]*parsedVersionCursor{
		"entity":         parsed.entity,
		"task":           parsed.task,
		"object":         parsed.object,
		"deleted entity": parsed.deletedEntity,
		"deleted task":   parsed.deletedTask,
		"deleted object": parsed.deletedObject,
	} {
		if parsedCursor == nil || parsedCursor.version != 42 || parsedCursor.id != "row" {
			t.Errorf("%s cursor = %#v, want version 42 and id row", name, parsedCursor)
		}
	}
}

func TestParseChangedSinceCursorsHandlesAbsentMalformedAndStaleInputs(t *testing.T) {
	parsed, err := parseChangedSinceCursors(nil)
	if err != nil {
		t.Fatalf("parse absent cursors: %v", err)
	}
	if _, continuation, err := parsed.snapshot(0, 50); err != nil || continuation {
		t.Fatalf("absent cursor snapshot = (%v, %v), want no continuation", continuation, err)
	}

	malformed := "not-base64"
	_, err = parseChangedSinceCursors(&ChangedSinceCursors{EntityCursor: &malformed})
	validationErr, ok := err.(*ValidationError)
	if !ok || len(validationErr.Details) != 1 || !strings.Contains(validationErr.Details[0], "entity_cursor") {
		t.Fatalf("malformed cursor error = %v, want entity_cursor validation detail", err)
	}

	valid, err := encodeVersionCursor(42, "row", 30, 7)
	if err != nil {
		t.Fatalf("encode stale cursor: %v", err)
	}
	parsed, err = parseChangedSinceCursors(&ChangedSinceCursors{EntityCursor: &valid})
	if err != nil {
		t.Fatalf("parse stale cursor: %v", err)
	}
	if upper, continuation, err := parsed.snapshot(7, 50); err != nil || upper != 30 || !continuation {
		t.Fatalf("stale snapshot = (%d, %v, %v), want (30, true, nil)", upper, continuation, err)
	}
	_, _, err = parsed.snapshot(8, 50)
	validationErr, ok = err.(*ValidationError)
	if !ok || len(validationErr.Details) != 1 || !strings.Contains(validationErr.Details[0], "since_version") {
		t.Fatalf("since-version mismatch error = %v, want validation error", err)
	}
}

func TestGetDataChangedSincePreservesBeginDatabaseError(t *testing.T) {
	pool := openActionsTestPool(t)
	pool.Close()

	_, err := NewQueryActions(pool).GetDataChangedSince(context.Background(), 0, 1, nil)
	if err == nil || !strings.Contains(err.Error(), "begin transaction") {
		t.Fatalf("closed-pool error = %v, want begin transaction contract", err)
	}
}

func TestTrimToLimitWithMoreChangedSinceBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		items   []string
		limit   int
		want    []string
		hasMore bool
	}{
		{name: "exact page", items: []string{"a", "b"}, limit: 2, want: []string{"a", "b"}},
		{name: "one over page", items: []string{"a", "b", "c"}, limit: 2, want: []string{"a", "b"}, hasMore: true},
		{name: "empty page", items: nil, limit: 2, want: nil},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, hasMore := trimToLimitWithMore(test.items, test.limit)
			if len(got) != len(test.want) || hasMore != test.hasMore {
				t.Fatalf("page = %#v, hasMore=%v; want %#v, %v", got, hasMore, test.want, test.hasMore)
			}
			for i := range got {
				if got[i] != test.want[i] {
					t.Fatalf("page[%d] = %q, want %q", i, got[i], test.want[i])
				}
			}
		})
	}
}

func TestAssembleChangedSinceResultKeepsIndependentContinuationAndSnapshot(t *testing.T) {
	page := &changedSincePage{
		entities: []*models.Entity{
			{EntityID: "entity-first", Version: 11},
			{EntityID: "entity-last", Version: 10},
		},
		tasks:                  []*models.Task{{TaskID: "task-only", Version: 9}},
		deletedEntities:        []DeletedResource{{ID: "deleted-entity", Type: "entity", Version: 8}},
		deletedTasks:           []DeletedResource{{ID: "deleted-task", Type: "task", Version: 7}},
		deletedObjects:         []DeletedResource{{ID: "deleted-object", Type: "object", Version: 6}},
		hasMoreEntities:        true,
		hasMoreDeletedEntities: true,
		hasMoreDeletedTasks:    true,
		hasMoreDeletedObjects:  true,
	}
	timestamp := time.Date(2026, 7, 17, 20, 0, 0, 123456789, time.UTC)

	result, err := assembleChangedSinceResult(page, timestamp, 100, 7)
	if err != nil {
		t.Fatalf("assemble result: %v", err)
	}
	if result.Version != 100 || result.Timestamp != timestamp.Format(time.RFC3339Nano) {
		t.Fatalf("snapshot metadata = (%d, %q), want (100, %q)", result.Version, result.Timestamp, timestamp.Format(time.RFC3339Nano))
	}
	if !result.HasMoreEntities || result.HasMoreTasks || !result.HasMoreDeletedEntities || !result.HasMoreDeletedTasks || !result.HasMoreDeletedObjects {
		t.Fatalf("continuation flags = %#v, want only entity and tombstone streams with more rows", result)
	}
	if result.NextTaskCursor != "" || result.NextObjectCursor != "" {
		t.Fatalf("uncontinued cursors = task %q object %q, want empty", result.NextTaskCursor, result.NextObjectCursor)
	}

	for name, cursor := range map[string]string{
		"entity":         result.NextEntityCursor,
		"deleted entity": result.NextDeletedEntityCursor,
		"deleted task":   result.NextDeletedTaskCursor,
		"deleted object": result.NextDeletedObjectCursor,
	} {
		version, id, upper, since, err := decodeVersionCursor(cursor)
		if err != nil {
			t.Fatalf("decode %s cursor: %v", name, err)
		}
		if upper != 100 || since != 7 {
			t.Errorf("%s cursor snapshot = (%d, %d), want (100, 7)", name, upper, since)
		}
		wantID, wantVersion := map[string]struct {
			id      string
			version int64
		}{
			"entity":         {id: "entity-last", version: 10},
			"deleted entity": {id: "deleted-entity", version: 8},
			"deleted task":   {id: "deleted-task", version: 7},
			"deleted object": {id: "deleted-object", version: 6},
		}[name].id, map[string]int64{
			"entity":         10,
			"deleted entity": 8,
			"deleted task":   7,
			"deleted object": 6,
		}[name]
		if id != wantID || version != wantVersion {
			t.Errorf("%s cursor = (%d, %q), want (%d, %q)", name, version, id, wantVersion, wantID)
		}
	}
}

func TestAssembleChangedSinceResultPreservesCursorErrorContracts(t *testing.T) {
	_, err := assembleChangedSinceResult(&changedSincePage{
		entities:        []*models.Entity{{EntityID: "missing-version"}},
		hasMoreEntities: true,
	}, time.Time{}, 100, 7)
	if err == nil || !strings.Contains(err.Error(), "encode entity cursor") {
		t.Fatalf("entity cursor error = %v, want encode entity cursor contract", err)
	}

	_, err = assembleChangedSinceResult(&changedSincePage{
		deletedObjects:        []DeletedResource{{ID: "missing-version", Type: "object"}},
		hasMoreDeletedObjects: true,
	}, time.Time{}, 100, 7)
	if err == nil || !strings.Contains(err.Error(), "next_deleted_object_cursor") {
		t.Fatalf("deleted cursor error = %v, want next_deleted_object_cursor contract", err)
	}
}
