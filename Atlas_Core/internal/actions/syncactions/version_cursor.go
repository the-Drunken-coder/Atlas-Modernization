package syncactions

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions"
)

type versionCursor struct {
	V  int64  `json:"v"`
	ID string `json:"id"`
	UV int64  `json:"uv"` // upper bound snapshot version
	SV *int64 `json:"sv"` // original since_version; pointer distinguishes missing from valid zero
}

type parsedVersionCursor struct {
	Version      int64
	ID           string
	UpperBound   int64
	SinceVersion int64
}

type labeledVersionCursor struct {
	Label  string
	Cursor *parsedVersionCursor
}

func encodeVersionCursor(version int64, id string, upperBound int64, sinceVersion int64) (string, error) {
	if version <= 0 {
		return "", fmt.Errorf("marshal version cursor: version must be positive")
	}
	if id == "" {
		return "", fmt.Errorf("marshal version cursor: empty id")
	}
	if upperBound <= 0 {
		return "", fmt.Errorf("marshal version cursor: upper bound version must be positive")
	}
	if sinceVersion < 0 {
		return "", fmt.Errorf("marshal version cursor: since_version must be non-negative")
	}
	cursorSinceVersion := sinceVersion
	p := versionCursor{
		V:  version,
		ID: id,
		UV: upperBound,
		SV: &cursorSinceVersion,
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("marshal version cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func decodeVersionCursor(s string) (int64, string, int64, int64, error) {
	if s == "" {
		return 0, "", 0, 0, fmt.Errorf("empty cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, "", 0, 0, fmt.Errorf("decode cursor: %w", err)
	}
	var p versionCursor
	if err := json.Unmarshal(raw, &p); err != nil {
		return 0, "", 0, 0, fmt.Errorf("parse cursor json: %w", err)
	}
	if p.ID == "" {
		return 0, "", 0, 0, fmt.Errorf("cursor missing id")
	}
	if p.V <= 0 {
		return 0, "", 0, 0, fmt.Errorf("cursor version must be positive")
	}
	if p.UV <= 0 {
		return 0, "", 0, 0, fmt.Errorf("cursor upper bound version must be positive")
	}
	if p.SV == nil {
		return 0, "", 0, 0, fmt.Errorf("cursor missing since_version")
	}
	if *p.SV < 0 {
		return 0, "", 0, 0, fmt.Errorf("cursor since_version must be non-negative")
	}
	return p.V, p.ID, p.UV, *p.SV, nil
}

func parseVersionQueryCursor(raw, label string) (*parsedVersionCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	version, id, upperBound, sinceVersion, err := decodeVersionCursor(raw)
	if err != nil {
		return nil, actions.NewValidationErrorWithDetails("Invalid query cursor", []string{fmt.Sprintf("invalid %s: %v", label, err)})
	}
	return &parsedVersionCursor{
		Version:      version,
		ID:           id,
		UpperBound:   upperBound,
		SinceVersion: sinceVersion,
	}, nil
}

func continuationVersionUpperBound(currentSnapshot int64, cursors ...*parsedVersionCursor) (int64, bool, error) {
	continuation := false
	var sharedUpperBound int64
	for _, cursor := range cursors {
		if cursor == nil {
			continue
		}
		continuation = true
		if cursor.UpperBound == 0 {
			continue
		}
		if sharedUpperBound == 0 {
			sharedUpperBound = cursor.UpperBound
			continue
		}
		if sharedUpperBound != cursor.UpperBound {
			return 0, false, actions.NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{"query cursors must come from the same snapshot"},
			)
		}
	}
	if !continuation {
		return currentSnapshot, false, nil
	}
	if sharedUpperBound == 0 {
		return currentSnapshot, true, nil
	}
	return clampVersionCursorUpperBound(sharedUpperBound, currentSnapshot), true, nil
}

func validateVersionCursorsSinceVersion(sinceVersion int64, cursors ...labeledVersionCursor) error {
	for _, item := range cursors {
		if item.Cursor == nil {
			continue
		}
		if item.Cursor.SinceVersion != sinceVersion {
			return actions.NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{fmt.Sprintf("%s was created for since_version %d, got %d", item.Label, item.Cursor.SinceVersion, sinceVersion)},
			)
		}
	}
	return nil
}

func effectiveVersionCursorUpperBound(cursor *parsedVersionCursor, snapshotUpperBound int64) int64 {
	if cursor == nil {
		return snapshotUpperBound
	}
	return clampVersionCursorUpperBound(cursor.UpperBound, snapshotUpperBound)
}

func clampVersionCursorUpperBound(candidate, ceiling int64) int64 {
	if candidate <= 0 {
		return ceiling
	}
	if ceiling <= 0 || candidate <= ceiling {
		return candidate
	}
	return ceiling
}

func encodeDeletedCursor(resource DeletedResource, snapshotUpperVersion, sinceVersion int64, cursorField string) (string, error) {
	cursor, err := encodeVersionCursor(resource.Version, resource.ID, snapshotUpperVersion, sinceVersion)
	if err != nil {
		return "", fmt.Errorf("build %s: %w", cursorField, err)
	}
	return cursor, nil
}
