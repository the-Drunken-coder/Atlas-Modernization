package protocoltest

import (
	"testing"

	protocol "github.com/the-drunken-coder/atlas/packages/protocol/generated/go/atlasprotocol"
)

func TestMovementSampleQuantities(t *testing.T) {
	const at = "2026-09-09T12:00:00Z"
	for _, test := range []struct {
		name       string
		quantities map[string]any
		valid      bool
	}{
		{"missing", map[string]any{}, false},
		{"latitude only", map[string]any{"latitude": 0}, false},
		{"longitude only", map[string]any{"longitude": 0}, false},
		{"partial position with speed", map[string]any{"latitude": 0, "speed_m_s": 1}, false},
		{"position", map[string]any{"latitude": 0, "longitude": 0}, true},
		{"speed", map[string]any{"speed_m_s": 0}, true},
		{"altitude", map[string]any{"altitude_m": -5}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			sample := map[string]any{"sample_id": "sample"}
			for key, value := range test.quantities {
				sample[key] = value
			}
			batch := map[string]any{"entity_created_at": at, "samples": []any{sample}}
			if got := len(protocol.ValidateMovementHistoryBatchRequest(batch)) == 0; got != test.valid {
				t.Fatalf("batch accepted=%t, want %t", got, test.valid)
			}
			sample["time"], sample["received_at"], sample["time_is_arrival"] = at, at, true
			page := map[string]any{"entity_created_at": at, "from": at, "to": at, "retained_from": at, "snapshot": "1", "samples": []any{sample}}
			if got := len(protocol.ValidateMovementHistoryPage(page)) == 0; got != test.valid {
				t.Fatalf("page accepted=%t, want %t", got, test.valid)
			}
		})
	}
}
