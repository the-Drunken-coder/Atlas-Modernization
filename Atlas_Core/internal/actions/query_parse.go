package actions

import (
	"fmt"
	"strings"
	"time"
)

// ParsedQueryCursor is a decoded time-ordered continuation cursor.
type ParsedQueryCursor struct {
	Timestamp  time.Time
	ID         string
	UpperBound time.Time
}

// ParsedVersionCursor is a decoded version-ordered continuation cursor.
type ParsedVersionCursor struct {
	Version      int64
	ID           string
	UpperBound   int64
	SinceVersion int64
}

// LabeledVersionCursor pairs a version cursor with the request field it came from.
type LabeledVersionCursor struct {
	Label  string
	Cursor *ParsedVersionCursor
}

// ParseQueryCursor decodes an optional time-ordered cursor; empty input yields nil.
func ParseQueryCursor(raw, label string) (*ParsedQueryCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	ts, id, upperBound, err := decodeRowCursor(raw)
	if err != nil {
		return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{fmt.Sprintf("invalid %s: %v", label, err)})
	}
	return &ParsedQueryCursor{
		Timestamp:  ts,
		ID:         id,
		UpperBound: upperBound,
	}, nil
}

// ParseVersionQueryCursor decodes an optional version-ordered cursor; empty input yields nil.
func ParseVersionQueryCursor(raw, label string) (*ParsedVersionCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	version, id, upperBound, sinceVersion, err := decodeVersionCursor(raw)
	if err != nil {
		return nil, NewValidationErrorWithDetails("Invalid query cursor", []string{fmt.Sprintf("invalid %s: %v", label, err)})
	}
	return &ParsedVersionCursor{
		Version:      version,
		ID:           id,
		UpperBound:   upperBound,
		SinceVersion: sinceVersion,
	}, nil
}

// ContinuationUpperBound resolves the shared snapshot upper bound across the
// provided cursors and reports whether the request is a continuation page.
func ContinuationUpperBound(currentSnapshot time.Time, cursors ...*ParsedQueryCursor) (time.Time, bool, error) {
	continuation := false
	var sharedUpperBound time.Time
	for _, cursor := range cursors {
		if cursor == nil {
			continue
		}
		continuation = true
		if cursor.UpperBound.IsZero() {
			continue
		}
		if sharedUpperBound.IsZero() {
			sharedUpperBound = cursor.UpperBound
			continue
		}
		if !sharedUpperBound.Equal(cursor.UpperBound) {
			return time.Time{}, false, NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{"query cursors must come from the same snapshot"},
			)
		}
	}
	if !continuation {
		return currentSnapshot, false, nil
	}
	if sharedUpperBound.IsZero() {
		return currentSnapshot, true, nil
	}
	return clampCursorUpperBound(sharedUpperBound, currentSnapshot), true, nil
}

// EffectiveCursorUpperBound returns the snapshot bound a continuation page must
// honor: the cursor's embedded bound clamped to the current snapshot.
func EffectiveCursorUpperBound(cursor *ParsedQueryCursor, snapshotUpperBound time.Time) time.Time {
	if cursor == nil {
		return snapshotUpperBound
	}
	return clampCursorUpperBound(cursor.UpperBound, snapshotUpperBound)
}

// ContinuationVersionUpperBound resolves the shared snapshot version across the
// provided cursors and reports whether the request is a continuation page.
func ContinuationVersionUpperBound(currentSnapshot int64, cursors ...*ParsedVersionCursor) (int64, bool, error) {
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
			return 0, false, NewValidationErrorWithDetails(
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

// ValidateVersionCursorsSinceVersion rejects cursors created for a different since_version.
func ValidateVersionCursorsSinceVersion(sinceVersion int64, cursors ...LabeledVersionCursor) error {
	for _, item := range cursors {
		if item.Cursor == nil {
			continue
		}
		if item.Cursor.SinceVersion != sinceVersion {
			return NewValidationErrorWithDetails(
				"Invalid query cursor",
				[]string{fmt.Sprintf("%s was created for since_version %d, got %d", item.Label, item.Cursor.SinceVersion, sinceVersion)},
			)
		}
	}
	return nil
}

func effectiveVersionCursorUpperBound(cursor *ParsedVersionCursor, snapshotUpperBound int64) int64 {
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

func clampCursorUpperBound(candidate, ceiling time.Time) time.Time {
	if candidate.IsZero() {
		return ceiling
	}
	if ceiling.IsZero() || candidate.Before(ceiling) || candidate.Equal(ceiling) {
		return candidate
	}
	return ceiling
}
