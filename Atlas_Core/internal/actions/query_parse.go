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

func clampCursorUpperBound(candidate, ceiling time.Time) time.Time {
	if candidate.IsZero() {
		return ceiling
	}
	if ceiling.IsZero() || candidate.Before(ceiling) || candidate.Equal(ceiling) {
		return candidate
	}
	return ceiling
}
