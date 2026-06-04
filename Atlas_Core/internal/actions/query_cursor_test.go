package actions

import (
	"strings"
	"testing"
	"time"
)

func TestEncodeDecodeRowCursor_roundTrip(t *testing.T) {
	ts := time.Date(2026, 3, 20, 12, 0, 0, 123456789, time.UTC)
	id := "entity-abc"
	ub := time.Date(2026, 3, 20, 15, 30, 0, 0, time.UTC)
	enc, err := encodeRowCursor(ts, id, ub)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if enc == "" {
		t.Fatal("expected non-empty cursor")
	}
	gotTS, gotID, gotUB, err := decodeRowCursor(enc)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if gotID != id {
		t.Fatalf("id: got %q want %q", gotID, id)
	}
	if !gotTS.Equal(ts) {
		t.Fatalf("time: got %v want %v", gotTS, ts)
	}
	if !gotUB.Equal(ub) {
		t.Fatalf("upper bound: got %v want %v", gotUB, ub)
	}
}

func TestDecodeRowCursor_rejectsEmpty(t *testing.T) {
	_, _, _, err := decodeRowCursor("")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestDecodeRowCursor_specialChars(t *testing.T) {
	ts := time.Date(2026, 3, 20, 12, 0, 0, 123456789, time.UTC)
	id := "entity,with:chars+/=_-"
	ub := time.Date(2026, 3, 20, 15, 30, 0, 0, time.UTC)

	cursor, err := encodeRowCursor(ts, id, ub)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	gotTS, gotID, gotUB, err := decodeRowCursor(cursor)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if gotID != id {
		t.Fatalf("id: got %q want %q", gotID, id)
	}
	if !gotTS.Equal(ts) {
		t.Fatalf("time: got %v want %v", gotTS, ts)
	}
	if !gotUB.Equal(ub) {
		t.Fatalf("upper bound: got %v want %v", gotUB, ub)
	}
}

func TestDecodeRowCursor_malformedTruncated(t *testing.T) {
	tests := []string{
		// Not base64 at all.
		"not-base64",
		// Truncated base64 payload / missing padding.
		"eyJ0cyI6IjIwMjYtMDMtMjBUMTI6MDA6MDBaIiwiaWQiOiJlbnRpdHktMQ",
		// Valid base64 JSON, but the timestamp field is empty.
		"eyJ0cyI6IiIsImlkIjoiZW50aXR5LTEifQ",
	}

	for _, cursor := range tests {
		if _, _, _, err := decodeRowCursor(cursor); err == nil {
			t.Fatalf("expected error for cursor %q", cursor)
		}
	}
}

func TestParseQueryCursorReturnsValidationError(t *testing.T) {
	_, err := parseQueryCursor("not-base64", "cursor")
	if err == nil {
		t.Fatal("expected invalid cursor to fail")
	}
	if validationErr, ok := err.(*ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
		t.Fatalf("expected validation error, got %T %v", err, err)
	}
}

func TestContinuationUpperBoundMixedSnapshotsReturnsValidationError(t *testing.T) {
	ts := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)
	first := &parsedQueryCursor{
		timestamp:  ts,
		id:         "a",
		upperBound: ts.Add(time.Minute),
	}
	second := &parsedQueryCursor{
		timestamp:  ts,
		id:         "b",
		upperBound: ts.Add(2 * time.Minute),
	}

	_, _, err := continuationUpperBound(time.Now().UTC(), first, second)
	if err == nil {
		t.Fatal("expected mixed cursor snapshots to fail")
	}
	if validationErr, ok := err.(*ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
		t.Fatalf("expected validation error, got %T %v", err, err)
	}
}

func TestContinuationUpperBoundClampsFutureCursorSnapshot(t *testing.T) {
	current := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)
	cursor := &parsedQueryCursor{
		timestamp:  current.Add(-time.Minute),
		id:         "task-1",
		upperBound: current.Add(time.Hour),
	}

	got, continuation, err := continuationUpperBound(current, cursor)
	if err != nil {
		t.Fatalf("continuationUpperBound: %v", err)
	}
	if !continuation {
		t.Fatal("expected continuation")
	}
	if !got.Equal(current) {
		t.Fatalf("expected future upper bound to clamp to %v, got %v", current, got)
	}
}

func TestEffectiveCursorUpperBoundClampsAndDefaults(t *testing.T) {
	snapshot := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)

	if got := effectiveCursorUpperBound(nil, snapshot); !got.Equal(snapshot) {
		t.Fatalf("expected nil cursor to use snapshot %v, got %v", snapshot, got)
	}

	legacy := &parsedQueryCursor{timestamp: snapshot.Add(-time.Minute), id: "task-1"}
	if got := effectiveCursorUpperBound(legacy, snapshot); !got.Equal(snapshot) {
		t.Fatalf("expected legacy cursor to use snapshot %v, got %v", snapshot, got)
	}

	older := snapshot.Add(-time.Hour)
	oldCursor := &parsedQueryCursor{timestamp: snapshot.Add(-time.Minute), id: "task-1", upperBound: older}
	if got := effectiveCursorUpperBound(oldCursor, snapshot); !got.Equal(older) {
		t.Fatalf("expected older cursor upper bound %v, got %v", older, got)
	}

	futureCursor := &parsedQueryCursor{timestamp: snapshot.Add(-time.Minute), id: "task-1", upperBound: snapshot.Add(time.Hour)}
	if got := effectiveCursorUpperBound(futureCursor, snapshot); !got.Equal(snapshot) {
		t.Fatalf("expected future cursor upper bound to clamp to %v, got %v", snapshot, got)
	}
}

func TestEncodeDeletedCursorRejectsInvalidDeletedAt(t *testing.T) {
	_, err := encodeDeletedCursor(
		DeletedResource{ID: "deleted-entity-1", Type: "entity", DeletedAt: "not-a-timestamp"},
		time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC),
		"next_deleted_entity_cursor",
	)
	if err == nil {
		t.Fatal("expected invalid deleted_at to fail")
	}
	if !strings.Contains(err.Error(), "next_deleted_entity_cursor") {
		t.Fatalf("expected cursor field in error, got %v", err)
	}
}

func TestEncodeDeletedCursorRoundTrip(t *testing.T) {
	deletedAt := time.Date(2026, 3, 20, 11, 30, 0, 0, time.UTC)
	snapshot := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)

	cursor, err := encodeDeletedCursor(
		DeletedResource{ID: "deleted-task-1", Type: "task", DeletedAt: deletedAt.Format(time.RFC3339Nano)},
		snapshot,
		"next_deleted_task_cursor",
	)
	if err != nil {
		t.Fatalf("encodeDeletedCursor: %v", err)
	}

	gotTS, gotID, gotSnapshot, err := decodeRowCursor(cursor)
	if err != nil {
		t.Fatalf("decodeRowCursor: %v", err)
	}
	if gotID != "deleted-task-1" {
		t.Fatalf("id: got %q want %q", gotID, "deleted-task-1")
	}
	if !gotTS.Equal(deletedAt) {
		t.Fatalf("timestamp: got %v want %v", gotTS, deletedAt)
	}
	if !gotSnapshot.Equal(snapshot) {
		t.Fatalf("snapshot: got %v want %v", gotSnapshot, snapshot)
	}
}
