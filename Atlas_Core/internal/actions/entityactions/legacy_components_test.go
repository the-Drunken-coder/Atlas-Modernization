package entityactions

import (
	"testing"
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
