package actions

import (
	"encoding/base64"
	"encoding/json"
	"strings"
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

func TestEncodeVersionCursorRoundTrip(t *testing.T) {
	cursor, err := EncodeVersionCursor(42, "entity-abc", 99, 7)
	if err != nil {
		t.Fatalf("encodeVersionCursor: %v", err)
	}

	gotVersion, gotID, gotUpperBound, gotSinceVersion, err := decodeVersionCursor(cursor)
	if err != nil {
		t.Fatalf("decodeVersionCursor: %v", err)
	}
	if gotVersion != 42 {
		t.Fatalf("Version: got %d want 42", gotVersion)
	}
	if gotID != "entity-abc" {
		t.Fatalf("ID: got %q want entity-abc", gotID)
	}
	if gotUpperBound != 99 {
		t.Fatalf("upper bound: got %d want 99", gotUpperBound)
	}
	if gotSinceVersion != 7 {
		t.Fatalf("since Version: got %d want 7", gotSinceVersion)
	}
}

func TestEncodeVersionCursorAllowsZeroSinceVersion(t *testing.T) {
	cursor, err := EncodeVersionCursor(42, "entity-abc", 99, 0)
	if err != nil {
		t.Fatalf("encodeVersionCursor: %v", err)
	}

	_, _, _, gotSinceVersion, err := decodeVersionCursor(cursor)
	if err != nil {
		t.Fatalf("decodeVersionCursor: %v", err)
	}
	if gotSinceVersion != 0 {
		t.Fatalf("since Version: got %d want 0", gotSinceVersion)
	}
}

func TestEncodeVersionCursorRejectsMissingUpperBound(t *testing.T) {
	cursor, err := EncodeVersionCursor(42, "entity-abc", 0, 7)
	if err == nil {
		t.Fatal("expected missing upper bound to fail")
	}
	if cursor != "" {
		t.Fatalf("expected empty cursor on error, got %q", cursor)
	}
	if !strings.Contains(err.Error(), "upper bound") {
		t.Fatalf("expected upper bound error, got %v", err)
	}
}

func TestEncodeVersionCursorRejectsNegativeSinceVersion(t *testing.T) {
	cursor, err := EncodeVersionCursor(42, "entity-abc", 99, -1)
	if err == nil {
		t.Fatal("expected negative since_version to fail")
	}
	if cursor != "" {
		t.Fatalf("expected empty cursor on error, got %q", cursor)
	}
	if !strings.Contains(err.Error(), "since_version") {
		t.Fatalf("expected since_version error, got %v", err)
	}
}

func TestDecodeVersionCursorRejectsMissingUpperBound(t *testing.T) {
	raw, err := json.Marshal(versionCursor{V: 42, ID: "entity-abc"})
	if err != nil {
		t.Fatalf("marshal version Cursor: %v", err)
	}
	cursor := base64.RawURLEncoding.EncodeToString(raw)

	if _, _, _, _, err := decodeVersionCursor(cursor); err == nil {
		t.Fatal("expected missing upper bound to fail")
	} else if !strings.Contains(err.Error(), "upper bound") {
		t.Fatalf("expected upper bound error, got %v", err)
	}
}

func TestDecodeVersionCursorRejectsMissingSinceVersion(t *testing.T) {
	raw, err := json.Marshal(versionCursor{V: 42, ID: "entity-abc", UV: 99})
	if err != nil {
		t.Fatalf("marshal version Cursor: %v", err)
	}
	cursor := base64.RawURLEncoding.EncodeToString(raw)

	if _, _, _, _, err := decodeVersionCursor(cursor); err == nil {
		t.Fatal("expected missing since_version to fail")
	} else if !strings.Contains(err.Error(), "since_version") {
		t.Fatalf("expected since_version error, got %v", err)
	}
}

func TestDecodeVersionCursorRejectsTimeCursor(t *testing.T) {
	timeCursor, err := EncodeRowCursor(time.Now().UTC(), "entity-abc", time.Now().UTC())
	if err != nil {
		t.Fatalf("encodeRowCursor: %v", err)
	}
	if _, _, _, _, err := decodeVersionCursor(timeCursor); err == nil {
		t.Fatal("expected time cursor to fail version decode")
	}
}

func TestEncodeDeletedCursorRejectsMissingVersion(t *testing.T) {
	_, err := EncodeDeletedCursor(
		DeletedResource{ID: "deleted-entity-1", Type: "entity"},
		100,
		7,
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

	cursor, err := EncodeDeletedCursor(
		DeletedResource{ID: "deleted-task-1", Type: "task", Version: 42},
		snapshotVersion,
		7,
		"next_deleted_task_cursor",
	)
	if err != nil {
		t.Fatalf("encodeDeletedCursor: %v", err)
	}

	gotVersion, gotID, gotSnapshotVersion, gotSinceVersion, err := decodeVersionCursor(cursor)
	if err != nil {
		t.Fatalf("decodeVersionCursor: %v", err)
	}
	if gotID != "deleted-task-1" {
		t.Fatalf("ID: got %q want %q", gotID, "deleted-task-1")
	}
	if gotVersion != 42 {
		t.Fatalf("Version: got %d want 42", gotVersion)
	}
	if gotSnapshotVersion != snapshotVersion {
		t.Fatalf("snapshot: got %d want %d", gotSnapshotVersion, snapshotVersion)
	}
	if gotSinceVersion != 7 {
		t.Fatalf("since Version: got %d want 7", gotSinceVersion)
	}
}

func TestValidateVersionCursorsSinceVersionRejectsMismatch(t *testing.T) {
	err := ValidateVersionCursorsSinceVersion(
		8,
		LabeledVersionCursor{
			Label: "entity_cursor",
			Cursor: &ParsedVersionCursor{
				Version:      42,
				ID:           "entity-abc",
				UpperBound:   99,
				SinceVersion: 7,
			},
		},
	)
	if err == nil {
		t.Fatal("expected mismatched since_version to fail")
	}
	validationErr, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("expected validation error, got %T %v", err, err)
	}
	if validationErr.Code != "VALIDATION_ERROR" {
		t.Fatalf("expected validation code, got %q", validationErr.Code)
	}
	if len(validationErr.Details) != 1 || !strings.Contains(validationErr.Details[0], "entity_cursor") || !strings.Contains(validationErr.Details[0], "since_version") {
		t.Fatalf("expected cursor mismatch detail, got %#v", validationErr.Details)
	}
}
