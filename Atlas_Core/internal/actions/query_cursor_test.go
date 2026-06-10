package actions

import (
	"testing"
	"time"
)

func TestEncodeDecodeRowCursor_roundTrip(t *testing.T) {
	ts := time.Date(2026, 3, 20, 12, 0, 0, 123456789, time.UTC)
	id := "entity-abc"
	ub := time.Date(2026, 3, 20, 15, 30, 0, 0, time.UTC)
	enc, err := EncodeRowCursor(ts, id, ub)
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
		t.Fatalf("ID: got %q want %q", gotID, id)
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
	if cursor, err := EncodeRowCursor(ts, "", time.Time{}); err == nil || cursor != "" {
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

	cursor, err := EncodeRowCursor(ts, id, ub)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	gotTS, gotID, gotUB, err := decodeRowCursor(cursor)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if gotID != id {
		t.Fatalf("ID: got %q want %q", gotID, id)
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
	_, err := ParseQueryCursor("not-base64", "cursor")
	if err == nil {
		t.Fatal("expected invalid cursor to fail")
	}
	if validationErr, ok := err.(*ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
		t.Fatalf("expected validation error, got %T %v", err, err)
	}
}

func TestContinuationUpperBoundMixedSnapshotsReturnsValidationError(t *testing.T) {
	ts := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)
	first := &ParsedQueryCursor{
		Timestamp:  ts,
		ID:         "a",
		UpperBound: ts.Add(time.Minute),
	}
	second := &ParsedQueryCursor{
		Timestamp:  ts,
		ID:         "b",
		UpperBound: ts.Add(2 * time.Minute),
	}

	_, _, err := ContinuationUpperBound(time.Now().UTC(), first, second)
	if err == nil {
		t.Fatal("expected mixed cursor snapshots to fail")
	}
	if validationErr, ok := err.(*ValidationError); !ok || validationErr.Code != "VALIDATION_ERROR" {
		t.Fatalf("expected validation error, got %T %v", err, err)
	}
}

func TestContinuationUpperBoundClampsFutureCursorSnapshot(t *testing.T) {
	current := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)
	cursor := &ParsedQueryCursor{
		Timestamp:  current.Add(-time.Minute),
		ID:         "task-1",
		UpperBound: current.Add(time.Hour),
	}

	got, continuation, err := ContinuationUpperBound(current, cursor)
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

	if got := EffectiveCursorUpperBound(nil, snapshot); !got.Equal(snapshot) {
		t.Fatalf("expected nil cursor to use snapshot %v, got %v", snapshot, got)
	}

	legacy := &ParsedQueryCursor{Timestamp: snapshot.Add(-time.Minute), ID: "task-1"}
	if got := EffectiveCursorUpperBound(legacy, snapshot); !got.Equal(snapshot) {
		t.Fatalf("expected legacy cursor to use snapshot %v, got %v", snapshot, got)
	}

	older := snapshot.Add(-time.Hour)
	oldCursor := &ParsedQueryCursor{Timestamp: snapshot.Add(-time.Minute), ID: "task-1", UpperBound: older}
	if got := EffectiveCursorUpperBound(oldCursor, snapshot); !got.Equal(older) {
		t.Fatalf("expected older cursor upper bound %v, got %v", older, got)
	}

	futureCursor := &ParsedQueryCursor{Timestamp: snapshot.Add(-time.Minute), ID: "task-1", UpperBound: snapshot.Add(time.Hour)}
	if got := EffectiveCursorUpperBound(futureCursor, snapshot); !got.Equal(snapshot) {
		t.Fatalf("expected future cursor upper bound to clamp to %v, got %v", snapshot, got)
	}
}
