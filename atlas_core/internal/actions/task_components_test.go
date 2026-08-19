package actions

import (
	"testing"
)

// TestValidateEntityComponents_NilAndEmpty tests nil and empty components
func TestValidateEntityComponents_NilAndEmpty(t *testing.T) {
	tests := []struct {
		name       string
		components map[string]interface{}
		wantError  bool
	}{
		{
			name:       "nil components",
			components: nil,
			wantError:  false,
		},
		{
			name:       "empty components",
			components: map[string]interface{}{},
			wantError:  false,
		},
		{
			name: "custom components only",
			components: map[string]interface{}{
				"custom_notes": "some notes",
				"custom_data":  map[string]interface{}{"key": "value"},
			},
			wantError: false,
		},
		{
			name: "checkin components: status, heartbeat, telemetry",
			components: map[string]interface{}{
				"status": map[string]interface{}{
					"value":       "active",
					"last_update": "2024-01-01T00:00:00Z",
				},
				"heartbeat": map[string]interface{}{
					"last_seen": "2024-01-01T00:00:00Z",
				},
				"telemetry": map[string]interface{}{
					"latitude":  40.7,
					"longitude": -73.9,
				},
			},
			wantError: false,
		},
		{
			name: "status component alone",
			components: map[string]interface{}{
				"status": map[string]interface{}{
					"value": "idle",
				},
			},
			wantError: false,
		},
		{
			name: "heartbeat component alone",
			components: map[string]interface{}{
				"heartbeat": map[string]interface{}{
					"last_seen": "2024-01-01T00:00:00Z",
				},
			},
			wantError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateEntityComponents(tt.components)
			if tt.wantError {
				if err == nil {
					t.Errorf("ValidateEntityComponents() expected error but got none")
				}
			} else {
				if err != nil {
					t.Errorf("ValidateEntityComponents() expected no error but got: %v", err)
				}
			}
		})
	}
}

// TestValidateTaskComponents tests task component validation
