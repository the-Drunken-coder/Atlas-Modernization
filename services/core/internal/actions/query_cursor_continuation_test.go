package actions

import (
	"strings"
	"testing"
	"time"
)

func TestContinuationUpperBound(t *testing.T) {
	now := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	upper := time.Date(2026, 3, 21, 11, 55, 0, 0, time.UTC)

	got, continuation, err := continuationUpperBound(
		now,
		&parsedQueryCursor{upperBound: upper},
		&parsedQueryCursor{upperBound: upper},
	)
	if err != nil {
		t.Fatalf("continuationUpperBound: %v", err)
	}
	if !continuation {
		t.Fatal("expected continuation=true")
	}
	if !got.Equal(upper) {
		t.Fatalf("expected shared upper bound %v, got %v", upper, got)
	}
}

func TestContinuationUpperBoundRejectsMissingSnapshot(t *testing.T) {
	now := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	_, _, err := continuationUpperBound(now, &parsedQueryCursor{})
	validationErr, ok := err.(*ValidationError)
	if !ok || len(validationErr.Details) != 1 || !strings.Contains(validationErr.Details[0], "snapshot time") {
		t.Fatalf("continuationUpperBound missing snapshot error = %#v, want snapshot time detail", err)
	}
}
