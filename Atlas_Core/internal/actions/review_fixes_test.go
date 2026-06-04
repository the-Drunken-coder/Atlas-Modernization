package actions

import (
	"testing"
	"time"
)

func TestNormalizeLegacyEntityComponents(t *testing.T) {
	components := map[string]interface{}{
		"status":    "idle",
		"heartbeat": "2026-03-21T00:00:00Z",
	}

	normalizeLegacyEntityComponents(components)

	status, ok := components["status"].(map[string]interface{})
	if !ok || status["value"] != "idle" {
		t.Fatalf("expected normalized status component, got %#v", components["status"])
	}
	heartbeat, ok := components["heartbeat"].(map[string]interface{})
	if !ok || heartbeat["last_seen"] != "2026-03-21T00:00:00Z" {
		t.Fatalf("expected normalized heartbeat component, got %#v", components["heartbeat"])
	}
}

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

func TestContinuationUpperBoundRejectsMixedSnapshots(t *testing.T) {
	now := time.Date(2026, 3, 21, 12, 0, 0, 0, time.UTC)
	_, _, err := continuationUpperBound(
		now,
		&parsedQueryCursor{upperBound: time.Date(2026, 3, 21, 12, 5, 0, 0, time.UTC)},
		&parsedQueryCursor{upperBound: time.Date(2026, 3, 21, 12, 6, 0, 0, time.UTC)},
	)
	if err == nil {
		t.Fatal("expected mismatched upper bounds to be rejected")
	}
}
