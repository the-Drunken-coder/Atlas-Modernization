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

func TestEncodeDecodeFullDatasetCursorRoundTrip(t *testing.T) {
	timestamp := time.Date(2026, 7, 10, 12, 0, 0, 123456789, time.UTC)
	upperBound := timestamp.Add(time.Minute)
	cursor, err := encodeFullDatasetCursor(timestamp, "entity-abc", upperBound, 42)
	if err != nil {
		t.Fatalf("encodeFullDatasetCursor: %v", err)
	}

	gotTimestamp, gotID, gotUpperBound, gotVersion, err := decodeFullDatasetCursor(cursor)
	if err != nil {
		t.Fatalf("decodeFullDatasetCursor: %v", err)
	}
	if !gotTimestamp.Equal(timestamp) || gotID != "entity-abc" || !gotUpperBound.Equal(upperBound) || gotVersion != 42 {
		t.Fatalf("decoded cursor = (%v, %q, %v, %d), want (%v, %q, %v, 42)", gotTimestamp, gotID, gotUpperBound, gotVersion, timestamp, "entity-abc", upperBound)
	}
}

func TestParseFullDatasetCursorRejectsMissingSnapshotVersion(t *testing.T) {
	timestamp := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	cursor, err := encodeRowCursor(timestamp, "entity-abc", timestamp.Add(time.Minute))
	if err != nil {
		t.Fatalf("encodeRowCursor: %v", err)
	}

	_, err = parseFullDatasetCursor(cursor, "entity_cursor")
	if err == nil {
		t.Fatal("expected full dataset cursor without snapshot version to fail")
	}
	validationErr, ok := err.(*ValidationError)
	if !ok || validationErr.Code != "VALIDATION_ERROR" || len(validationErr.Details) != 1 || !strings.Contains(validationErr.Details[0], "snapshot version") {
		t.Fatalf("expected snapshot-version validation error, got %T %#v", err, err)
	}
}

func TestFullDatasetSnapshotVersionRejectsMissingMixedAndFutureVersions(t *testing.T) {
	tests := []struct {
		name    string
		current int64
		cursors []*parsedQueryCursor
		detail  string
	}{
		{name: "missing", current: 100, cursors: []*parsedQueryCursor{{}}, detail: "must include"},
		{name: "mixed", current: 100, cursors: []*parsedQueryCursor{{upperVersion: 40}, {upperVersion: 41}}, detail: "same version snapshot"},
		{name: "future", current: 100, cursors: []*parsedQueryCursor{{upperVersion: 101}}, detail: "newer than current"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := fullDatasetSnapshotVersion(test.current, test.cursors...)
			if err == nil {
				t.Fatal("expected invalid full dataset snapshot version to fail")
			}
			validationErr, ok := err.(*ValidationError)
			if !ok || validationErr.Code != "VALIDATION_ERROR" || len(validationErr.Details) != 1 || !strings.Contains(validationErr.Details[0], test.detail) {
				t.Fatalf("expected validation detail containing %q, got %T %#v", test.detail, err, err)
			}
		})
	}
}

func TestFullDatasetSnapshotVersionUsesCurrentOrCursorBaseline(t *testing.T) {
	if got, err := fullDatasetSnapshotVersion(100); err != nil || got != 100 {
		t.Fatalf("initial snapshot version = %d, %v; want 100", got, err)
	}
	if got, err := fullDatasetSnapshotVersion(105, &parsedQueryCursor{upperVersion: 100}); err != nil || got != 100 {
		t.Fatalf("continuation snapshot version = %d, %v; want 100", got, err)
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
	cursor, err := encodeVersionCursor(42, 99, 7)
	if err != nil {
		t.Fatalf("encodeVersionCursor: %v", err)
	}

	gotVersion, gotUpperBound, gotSinceVersion, err := decodeVersionCursor(cursor)
	if err != nil {
		t.Fatalf("decodeVersionCursor: %v", err)
	}
	if gotVersion != 42 {
		t.Fatalf("version: got %d want 42", gotVersion)
	}
	if gotUpperBound != 99 {
		t.Fatalf("upper bound: got %d want 99", gotUpperBound)
	}
	if gotSinceVersion != 7 {
		t.Fatalf("since version: got %d want 7", gotSinceVersion)
	}
}

func TestEncodeVersionCursorAllowsZeroSinceVersion(t *testing.T) {
	cursor, err := encodeVersionCursor(42, 99, 0)
	if err != nil {
		t.Fatalf("encodeVersionCursor: %v", err)
	}

	_, _, gotSinceVersion, err := decodeVersionCursor(cursor)
	if err != nil {
		t.Fatalf("decodeVersionCursor: %v", err)
	}
	if gotSinceVersion != 0 {
		t.Fatalf("since version: got %d want 0", gotSinceVersion)
	}
}

func TestEncodeVersionCursorRejectsMissingUpperBound(t *testing.T) {
	cursor, err := encodeVersionCursor(42, 0, 7)
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
	cursor, err := encodeVersionCursor(42, 99, -1)
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
	raw, err := json.Marshal(versionCursor{V: 42})
	if err != nil {
		t.Fatalf("marshal version cursor: %v", err)
	}
	cursor := base64.RawURLEncoding.EncodeToString(raw)

	if _, _, _, err := decodeVersionCursor(cursor); err == nil {
		t.Fatal("expected missing upper bound to fail")
	} else if !strings.Contains(err.Error(), "upper bound") {
		t.Fatalf("expected upper bound error, got %v", err)
	}
}

func TestDecodeVersionCursorRejectsMissingSinceVersion(t *testing.T) {
	raw, err := json.Marshal(versionCursor{V: 42, UV: 99})
	if err != nil {
		t.Fatalf("marshal version cursor: %v", err)
	}
	cursor := base64.RawURLEncoding.EncodeToString(raw)

	if _, _, _, err := decodeVersionCursor(cursor); err == nil {
		t.Fatal("expected missing since_version to fail")
	} else if !strings.Contains(err.Error(), "since_version") {
		t.Fatalf("expected since_version error, got %v", err)
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
