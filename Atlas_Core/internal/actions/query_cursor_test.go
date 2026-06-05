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

func TestEncodeRowCursorRejectsEmptyID(t *testing.T) {
	ts := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)
	if cursor, err := encodeRowCursor(ts, "", time.Time{}); err == nil || cursor != "" {
		t.Fatalf("encodeRowCursor empty id = %q, %v; want empty cursor and error", cursor, err)
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

func TestEncodeVersionCursorRoundTrip(t *testing.T) {
	cursor, err := encodeVersionCursor(42, "entity-abc", 99)
	if err != nil {
		t.Fatalf("encodeVersionCursor: %v", err)
	}

	gotVersion, gotID, gotUpperBound, err := decodeVersionCursor(cursor)
	if err != nil {
		t.Fatalf("decodeVersionCursor: %v", err)
	}
	if gotVersion != 42 {
		t.Fatalf("version: got %d want 42", gotVersion)
	}
	if gotID != "entity-abc" {
		t.Fatalf("id: got %q want entity-abc", gotID)
	}
	if gotUpperBound != 99 {
		t.Fatalf("upper bound: got %d want 99", gotUpperBound)
	}
}

func TestDecodeVersionCursorRejectsTimeCursor(t *testing.T) {
	timeCursor, err := encodeRowCursor(time.Now().UTC(), "entity-abc", time.Now().UTC())
	if err != nil {
		t.Fatalf("encodeRowCursor: %v", err)
	}
	if _, _, _, err := decodeVersionCursor(timeCursor); err == nil {
		t.Fatal("expected time cursor to fail version decode")
	}
}

func TestEncodeDeletedCursorRejectsMissingVersion(t *testing.T) {
	_, err := encodeDeletedCursor(
		DeletedResource{ID: "deleted-entity-1", Type: "entity"},
		100,
		"next_deleted_entity_cursor",
	)
	if err == nil {
		t.Fatal("expected missing version to fail")
	}
	if !strings.Contains(err.Error(), "next_deleted_entity_cursor") {
		t.Fatalf("expected cursor field in error, got %v", err)
	}
}

func TestEncodeDeletedCursorRoundTrip(t *testing.T) {
	snapshotVersion := int64(100)

	cursor, err := encodeDeletedCursor(
		DeletedResource{ID: "deleted-task-1", Type: "task", Version: 42},
		snapshotVersion,
		"next_deleted_task_cursor",
	)
	if err != nil {
		t.Fatalf("encodeDeletedCursor: %v", err)
	}

	gotVersion, gotID, gotSnapshotVersion, err := decodeVersionCursor(cursor)
	if err != nil {
		t.Fatalf("decodeVersionCursor: %v", err)
	}
	if gotID != "deleted-task-1" {
		t.Fatalf("id: got %q want %q", gotID, "deleted-task-1")
	}
	if gotVersion != 42 {
		t.Fatalf("version: got %d want 42", gotVersion)
	}
	if gotSnapshotVersion != snapshotVersion {
		t.Fatalf("snapshot: got %d want %d", gotSnapshotVersion, snapshotVersion)
	}
}
