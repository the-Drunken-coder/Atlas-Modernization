package syncactions

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
)

func TestEncodeVersionCursorRoundTrip(t *testing.T) {
	cursor, err := encodeVersionCursor(42, "entity-abc", 99, 7)
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
	cursor, err := encodeVersionCursor(42, "entity-abc", 99, 0)
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
	cursor, err := encodeVersionCursor(42, "entity-abc", 0, 7)
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
	cursor, err := encodeVersionCursor(42, "entity-abc", 99, -1)
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
	timeCursor, err := actions.EncodeRowCursor(time.Now().UTC(), "entity-abc", time.Now().UTC())
	if err != nil {
		t.Fatalf("encodeRowCursor: %v", err)
	}
	if _, _, _, _, err := decodeVersionCursor(timeCursor); err == nil {
		t.Fatal("expected time cursor to fail version decode")
	}
}

func TestEncodeDeletedCursorRejectsMissingVersion(t *testing.T) {
	_, err := encodeDeletedCursor(
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

	cursor, err := encodeDeletedCursor(
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
	err := validateVersionCursorsSinceVersion(
		8,
		labeledVersionCursor{
			Label: "entity_cursor",
			Cursor: &parsedVersionCursor{
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
	validationErr, ok := err.(*actions.ValidationError)
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
