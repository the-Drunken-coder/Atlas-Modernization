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
		errMsg     string
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
			errMsg:    "command component must be an object",
		},
		{
			name: "unknown task component key",
			components: map[string]interface{}{
				"unknown_key": "value",
			},
			wantError: true,
			errMsg:    "Unknown component 'unknown_key'",
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
			errMsg:    "command.type: must be non-empty",
		},
		{
			name: "invalid parameters latitude",
			components: map[string]interface{}{
				"parameters": map[string]interface{}{
					"latitude": 91.0,
				},
			},
			wantError: true,
			errMsg:    "parameters.latitude",
		},
		{
			name: "invalid progress percent",
			components: map[string]interface{}{
				"progress": map[string]interface{}{
					"percent": 150.0,
				},
			},
			wantError: true,
			errMsg:    "progress.percent",
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
				if tt.errMsg != "" {
					assertValidationErrorDetailsContain(t, validationErr.Details, tt.errMsg)
				}
			} else {
				if err != nil {
					t.Errorf("ValidateTaskComponents() expected no error but got: %v", err)
				}
			}
		})
	}
}

// TestToFloat64 tests the toFloat64 helper function
func TestToFloat64(t *testing.T) {
	tests := []struct {
		name     string
		input    interface{}
		expected float64
		ok       bool
	}{
		{"float64", float64(3.5), 3.5, true},
		{"float32", float32(2.5), 2.5, true},
		{"int", int(42), 42.0, true},
		{"int8", int8(42), 42.0, true},
		{"int16", int16(42), 42.0, true},
		{"int32", int32(42), 42.0, true},
		{"int64", int64(42), 42.0, true},
		{"uint", uint(42), 42.0, true},
		{"uint8", uint8(42), 42.0, true},
		{"uint16", uint16(42), 42.0, true},
		{"uint32", uint32(42), 42.0, true},
		{"uint64", uint64(42), 42.0, true},
		{"string", "42", 0, false},
		{"bool", true, 0, false},
		{"nil", nil, 0, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, ok := toFloat64(tt.input)
			if ok != tt.ok {
				t.Errorf("toFloat64(%v) ok = %v, want %v", tt.input, ok, tt.ok)
			}
			if ok && result != tt.expected {
				t.Errorf("toFloat64(%v) = %v, want %v", tt.input, result, tt.expected)
			}
		})
	}
}
