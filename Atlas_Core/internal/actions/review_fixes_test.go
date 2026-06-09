package actions

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestContinuationUpperBound(t *testing.T) {
	now := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	upper := time.Date(2026, 3, 21, 11, 55, 0, 0, time.UTC)

	got, continuation, err := ContinuationUpperBound(
		now,
		&ParsedQueryCursor{UpperBound: upper},
		&ParsedQueryCursor{UpperBound: upper},
	)
	if err != nil {
		t.Fatalf("ContinuationUpperBound: %v", err)
	}
	if !continuation {
		t.Fatal("expected continuation=true")
	}
	if !got.Equal(upper) {
		t.Fatalf("expected shared upper bound %v, got %v", upper, got)
	}
}

func TestContinuationUpperBoundRejectsMixedSnapshots(t *testing.T) {
	now := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	_, _, err := ContinuationUpperBound(
		now,
		&ParsedQueryCursor{UpperBound: time.Date(2026, 3, 21, 12, 5, 0, 0, time.UTC)},
		&ParsedQueryCursor{UpperBound: time.Date(2026, 3, 21, 12, 6, 0, 0, time.UTC)},
	)
	if err == nil {
		t.Fatal("expected mismatched upper bounds to be rejected")
	}
}

func TestOpenCursorPagedRowsRequiresCursorForContinuation(t *testing.T) {
	rows, err := openCursorPagedRows(context.Background(), nil, cursorPageOpts{continuation: true})
	if err == nil {
		t.Fatal("expected missing continuation cursor to fail")
	}
	if rows != nil {
		t.Fatalf("expected no rows, got %v", rows)
	}
	if !strings.Contains(err.Error(), "requires a cursor") {
		t.Fatalf("expected cursor error, got %v", err)
	}
}
