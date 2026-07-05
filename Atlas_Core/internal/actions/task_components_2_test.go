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
func TestValidateTaskComponents(t *testing.T) {
	tests := []struct {
		name       string
		components map[string]interface{}
		wantError  bool
		errMsg     []string
	}{
		{
			name: "valid task components",
			components: map[string]interface{}{
				"command": map[string]interface{}{
					"type": "move_to_location",
				},
				"parameters": map[string]interface{}{
					"latitude":  40.7,
					"longitude": -73.9,
				},
				"progress": map[string]interface{}{
					"percent": 50.0,
				},
			},
			wantError: false,
		},
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
			name: "string command is rejected",
			components: map[string]interface{}{
				"command": "legacy-cmd-id",
				"target": map[string]interface{}{
					"latitude": 40.0,
				},
			},
			wantError: true,
			errMsg:    []string{"command", "want object"},
		},
		{
			name: "unknown task component key",
			components: map[string]interface{}{
				"unknown_key": "value",
			},
			wantError: true,
			errMsg:    []string{"Unknown component 'unknown_key'"},
		},
		{
			name: "custom task component key",
			components: map[string]interface{}{
				"custom_metadata": map[string]interface{}{"key": "value"},
			},
			wantError: false,
		},
		{
			name: "invalid command type",
			components: map[string]interface{}{
				"command": map[string]interface{}{
					"type": "",
				},
			},
			wantError: true,
			errMsg:    []string{"command.type", "pattern"},
		},
		{
			name: "invalid parameters latitude",
			components: map[string]interface{}{
				"parameters": map[string]interface{}{
					"latitude": 91.0,
				},
			},
			wantError: true,
			errMsg:    []string{"parameters.latitude", "maximum"},
		},
		{
			name: "invalid progress percent",
			components: map[string]interface{}{
				"progress": map[string]interface{}{
					"percent": 150.0,
				},
			},
			wantError: true,
			errMsg:    []string{"progress.percent", "maximum"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateTaskComponents(tt.components)
			if tt.wantError {
				if err == nil {
					t.Errorf("ValidateTaskComponents() expected error but got none")
					return
				}
				validationErr, ok := err.(*ValidationError)
				if !ok {
					t.Errorf("ValidateTaskComponents() expected ValidationError, got %T", err)
					return
				}
				if len(tt.errMsg) > 0 {
					assertValidationErrorDetailsContainAll(t, validationErr.Details, tt.errMsg...)
				}
			} else {
				if err != nil {
					t.Errorf("ValidateTaskComponents() expected no error but got: %v", err)
				}
			}
		})
	}
}
