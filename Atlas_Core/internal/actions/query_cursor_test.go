package actions

import (
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
