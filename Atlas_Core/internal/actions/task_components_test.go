package actions

import (
	"testing"
)

func TestValidateCommandComponent(t *testing.T) {
	tests := []struct {
		name    string
		command map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid command",
			command: map[string]interface{}{"type": "move_to_location"},
			wantErr: false,
		},
		{
			name:    "empty command type",
			command: map[string]interface{}{"type": ""},
			wantErr: true,
			errMsg:  "command.type: must be non-empty",
		},
		{
			name:    "whitespace-only command type",
			command: map[string]interface{}{"type": "   "},
			wantErr: true,
			errMsg:  "command.type: must be non-empty",
		},
		{
			name:    "missing command type",
			command: map[string]interface{}{"params": map[string]interface{}{}},
			wantErr: true,
			errMsg:  "command: missing required field 'type'",
		},
		{
			name:    "command type is number",
			command: map[string]interface{}{"type": 123},
			wantErr: true,
			errMsg:  "command.type: expected string",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateCommandComponent(tt.command), tt.wantErr, tt.errMsg)
		})
	}
}

// TestValidateTaskParametersComponent tests task parameters component validation
func TestValidateTaskParametersComponent(t *testing.T) {
	tests := []struct {
		name    string
		params  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid parameters",
			params: map[string]interface{}{
				"latitude":  40.7,
				"longitude": -73.9,
				"altitude":  100.0,
			},
			wantErr: false,
		},
		{
			name:    "empty parameters",
			params:  map[string]interface{}{},
			wantErr: false,
		},
		{
			name: "latitude out of range",
			params: map[string]interface{}{
				"latitude": 91.0,
			},
			wantErr: true,
			errMsg:  "parameters.latitude: 91.000000 is out of range [-90, 90]",
		},
		{
			name: "longitude out of range",
			params: map[string]interface{}{
				"longitude": -181.0,
			},
			wantErr: true,
			errMsg:  "parameters.longitude: -181.000000 is out of range [-180, 180]",
		},
		{
			name: "latitude is string",
			params: map[string]interface{}{
				"latitude": "40.7",
			},
			wantErr: true,
			errMsg:  "parameters.latitude: expected number",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateTaskParametersComponent(tt.params, "parameters."), tt.wantErr, tt.errMsg)
		})
	}
}

// TestValidateTaskProgressComponent tests task progress component validation
func TestValidateTaskProgressComponent(t *testing.T) {
	tests := []struct {
		name     string
		progress map[string]interface{}
		wantErr  bool
		errMsg   string
	}{
		{
			name: "valid progress",
			progress: map[string]interface{}{
				"percent":    75.5,
				"updated_at": "2024-01-15T10:30:00Z",
			},
			wantErr: false,
		},
		{
			name:     "empty progress",
			progress: map[string]interface{}{},
			wantErr:  false,
		},
		{
			name: "percent at boundary 0",
			progress: map[string]interface{}{
				"percent": 0.0,
			},
			wantErr: false,
		},
		{
			name: "percent at boundary 100",
			progress: map[string]interface{}{
				"percent": 100.0,
			},
			wantErr: false,
		},
		{
			name: "percent negative",
			progress: map[string]interface{}{
				"percent": -1.0,
			},
			wantErr: true,
			errMsg:  "progress.percent: -1.000000 is out of range [0, 100]",
		},
		{
			name: "percent over 100",
			progress: map[string]interface{}{
				"percent": 101.0,
			},
			wantErr: true,
			errMsg:  "progress.percent: 101.000000 is out of range [0, 100]",
		},
		{
			name: "percent is string",
			progress: map[string]interface{}{
				"percent": "75",
			},
			wantErr: true,
			errMsg:  "progress.percent: expected number",
		},
		{
			name: "invalid updated_at format",
			progress: map[string]interface{}{
				"updated_at": "2024-01-15",
			},
			wantErr: true,
			errMsg:  "progress.updated_at: invalid RFC3339 timestamp",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateTaskProgressComponent(tt.progress), tt.wantErr, tt.errMsg)
		})
	}
}

// TestValidateEntityComponents_MultipleErrors tests that multiple validation errors are collected
func TestValidateEntityComponents_MultipleErrors(t *testing.T) {
	tests := []struct {
		name         string
		components   map[string]interface{}
		wantErrCount int
	}{
		{
			name: "geometry bad + telemetry bad",
			components: map[string]interface{}{
				"geometry": map[string]interface{}{
					"type":        "InvalidType",
					"coordinates": []interface{}{-73.9, 40.7},
				},
				"telemetry": map[string]interface{}{
					"latitude": 91.0,
				},
			},
			wantErrCount: 2,
		},
		{
			name: "3 components each with 1 error",
			components: map[string]interface{}{
				"geometry": map[string]interface{}{
					"type":        "Point",
					"coordinates": "not an array",
				},
				"telemetry": map[string]interface{}{
					"speed_m_s": -5.0,
				},
				"health": map[string]interface{}{
					"battery_percent": 150.0,
				},
			},
			wantErrCount: 3,
		},
		{
			name: "unknown key + bad geometry",
			components: map[string]interface{}{
				"geomtry": map[string]interface{}{
					"type":        "Point",
					"coordinates": []interface{}{-73.9, 40.7},
				},
				"telemetry": map[string]interface{}{
					"latitude": 91.0,
				},
			},
			wantErrCount: 2,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateEntityComponents(tt.components)
			if err == nil {
				t.Errorf("ValidateEntityComponents() expected error but got none")
				return
			}

			validationErr, ok := err.(*ValidationError)
			if !ok {
				t.Errorf("ValidateEntityComponents() expected ValidationError, got %T", err)
				return
			}

			if len(validationErr.Details) != tt.wantErrCount {
				t.Errorf("ValidateEntityComponents() expected %d errors, got %d: %v", tt.wantErrCount, len(validationErr.Details), validationErr.Details)
			}
		})
	}
}

func TestValidateEntityComponents_TypeChecking(t *testing.T) {
	tests := []struct {
		name       string
		components map[string]interface{}
		wantErr    bool
		errMsg     string
	}{
		{
			name: "geometry is string",
			components: map[string]interface{}{
				"geometry": "not an object",
			},
			wantErr: true,
			errMsg:  "geometry component must be an object",
		},
		{
			name: "telemetry is array",
			components: map[string]interface{}{
				"telemetry": []interface{}{1, 2, 3},
			},
			wantErr: true,
			errMsg:  "telemetry component must be an object",
		},
		{
			name: "health is number",
			components: map[string]interface{}{
				"health": 100,
			},
			wantErr: true,
			errMsg:  "health component must be an object",
		},
		{
			name: "mil_view is null",
			components: map[string]interface{}{
				"mil_view": nil,
			},
			wantErr: true,
			errMsg:  "mil_view component must be an object",
		},
		{
			name: "task_catalog is string",
			components: map[string]interface{}{
				"task_catalog": "bad",
			},
			wantErr: true,
			errMsg:  "task_catalog component must be an object",
		},
		{
			name: "communications is boolean",
			components: map[string]interface{}{
				"communications": true,
			},
			wantErr: true,
			errMsg:  "communications component must be an object",
		},
		{
			name: "task_queue is array",
			components: map[string]interface{}{
				"task_queue": []interface{}{},
			},
			wantErr: true,
			errMsg:  "task_queue component must be an object",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateEntityComponents(tt.components)
			if tt.wantErr {
				if err == nil {
					t.Errorf("ValidateEntityComponents() expected error but got none")
					return
				}
				validationErr, ok := err.(*ValidationError)
				if !ok {
					t.Errorf("ValidateEntityComponents() expected ValidationError, got %T", err)
					return
				}
				if tt.errMsg != "" {
					assertValidationErrorDetailsContain(t, validationErr.Details, tt.errMsg)
				}
			} else {
				if err != nil {
					t.Errorf("ValidateEntityComponents() expected no error but got: %v", err)
				}
			}
		})
	}
}

func TestValidateTaskComponents_TypeChecking(t *testing.T) {
	tests := []struct {
		name       string
		components map[string]interface{}
		wantErr    bool
		errMsg     string
	}{
		{
			name: "command is string",
			components: map[string]interface{}{
				"command": "not an object",
			},
			wantErr: true,
			errMsg:  "command component must be an object",
		},
		{
			name: "parameters is array",
			components: map[string]interface{}{
				"parameters": []interface{}{1, 2, 3},
			},
			wantErr: true,
			errMsg:  "parameters component must be an object",
		},
		{
			name: "progress is null",
			components: map[string]interface{}{
				"progress": nil,
			},
			wantErr: true,
			errMsg:  "progress component must be an object",
		},
		{
			name: "valid command object",
			components: map[string]interface{}{
				"command": map[string]interface{}{
					"type": "move_to_location",
				},
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateTaskComponents(tt.components)
			if tt.wantErr {
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
