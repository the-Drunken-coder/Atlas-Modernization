package actions

import (
	"math"
	"testing"
)

func TestValidateTelemetryComponent(t *testing.T) {
	tests := []struct {
		name      string
		telemetry map[string]interface{}
		wantError bool
		errMsg    string
	}{
		{
			name: "valid full telemetry",
			telemetry: map[string]interface{}{
				"latitude":    40.7,
				"longitude":   -73.9,
				"altitude_m":  100.0,
				"speed_m_s":   5.5,
				"heading_deg": 90.0,
			},
			wantError: false,
		},
		{
			name: "valid partial (lat/lng only)",
			telemetry: map[string]interface{}{
				"latitude":  40.7,
				"longitude": -73.9,
			},
			wantError: false,
		},
		{
			name:      "empty object",
			telemetry: map[string]interface{}{},
			wantError: false,
		},
		{
			name: "latitude out of range",
			telemetry: map[string]interface{}{
				"latitude": 91.0,
			},
			wantError: true,
			errMsg:    "telemetry.latitude: 91.000000 is out of range [-90, 90]",
		},
		{
			name: "longitude out of range",
			telemetry: map[string]interface{}{
				"longitude": -181.0,
			},
			wantError: true,
			errMsg:    "telemetry.longitude: -181.000000 is out of range [-180, 180]",
		},
		{
			name: "speed negative",
			telemetry: map[string]interface{}{
				"speed_m_s": -5.0,
			},
			wantError: true,
			errMsg:    "telemetry.speed_m_s: -5.000000 must be non-negative",
		},
		{
			name: "heading negative",
			telemetry: map[string]interface{}{
				"heading_deg": -1.0,
			},
			wantError: true,
			errMsg:    "telemetry.heading_deg: -1.000000 is out of range [0, 360)",
		},
		{
			name: "heading >= 360",
			telemetry: map[string]interface{}{
				"heading_deg": 360.0,
			},
			wantError: true,
			errMsg:    "telemetry.heading_deg: 360.000000 is out of range [0, 360)",
		},
		{
			name: "latitude is string",
			telemetry: map[string]interface{}{
				"latitude": "40.7",
			},
			wantError: true,
			errMsg:    "telemetry.latitude: expected number",
		},
		{
			name: "latitude is null",
			telemetry: map[string]interface{}{
				"latitude": nil,
			},
			wantError: false,
		},
		{
			name:      "latitude NaN",
			telemetry: map[string]interface{}{"latitude": math.NaN()},
			wantError: true,
			errMsg:    "must be finite",
		},
		{
			name:      "latitude +Inf",
			telemetry: map[string]interface{}{"latitude": math.Inf(1)},
			wantError: true,
			errMsg:    "must be finite",
		},
		{
			name:      "longitude -Inf",
			telemetry: map[string]interface{}{"longitude": math.Inf(-1)},
			wantError: true,
			errMsg:    "must be finite",
		},
		{
			name:      "speed_m_s NaN",
			telemetry: map[string]interface{}{"speed_m_s": math.NaN()},
			wantError: true,
			errMsg:    "must be finite",
		},
		{
			name:      "heading_deg +Inf",
			telemetry: map[string]interface{}{"heading_deg": math.Inf(1)},
			wantError: true,
			errMsg:    "must be finite",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateTelemetryComponent(tt.telemetry), tt.wantError, tt.errMsg)
		})
	}
}

// TestValidateHealthComponent tests health component validation
func TestValidateHealthComponent(t *testing.T) {
	tests := []struct {
		name    string
		health  map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid battery percent",
			health:  map[string]interface{}{"battery_percent": 75.5},
			wantErr: false,
		},
		{
			name:    "battery percent at boundary 0",
			health:  map[string]interface{}{"battery_percent": 0.0},
			wantErr: false,
		},
		{
			name:    "battery percent at boundary 100",
			health:  map[string]interface{}{"battery_percent": 100.0},
			wantErr: false,
		},
		{
			name:    "battery percent negative",
			health:  map[string]interface{}{"battery_percent": -1.0},
			wantErr: true,
			errMsg:  "health.battery_percent: -1.000000 is out of range [0, 100]",
		},
		{
			name:    "battery percent over 100",
			health:  map[string]interface{}{"battery_percent": 101.0},
			wantErr: true,
			errMsg:  "health.battery_percent: 101.000000 is out of range [0, 100]",
		},
		{
			name:    "battery percent is string",
			health:  map[string]interface{}{"battery_percent": "75"},
			wantErr: true,
			errMsg:  "health.battery_percent: expected number",
		},
		{
			name:    "battery percent NaN",
			health:  map[string]interface{}{"battery_percent": math.NaN()},
			wantErr: true,
			errMsg:  "must be finite",
		},
		{
			name:    "battery percent +Inf",
			health:  map[string]interface{}{"battery_percent": math.Inf(1)},
			wantErr: true,
			errMsg:  "must be finite",
		},
		{
			name:    "battery percent -Inf",
			health:  map[string]interface{}{"battery_percent": math.Inf(-1)},
			wantErr: true,
			errMsg:  "must be finite",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateHealthComponent(tt.health), tt.wantErr, tt.errMsg)
		})
	}
}

// TestValidateMilViewComponent tests mil_view component validation
func TestValidateMilViewComponent(t *testing.T) {
	tests := []struct {
		name    string
		milView map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid classification friendly",
			milView: map[string]interface{}{"classification": "friendly"},
			wantErr: false,
		},
		{
			name:    "valid classification hostile",
			milView: map[string]interface{}{"classification": "hostile"},
			wantErr: false,
		},
		{
			name:    "valid classification neutral",
			milView: map[string]interface{}{"classification": "neutral"},
			wantErr: false,
		},
		{
			name:    "valid classification unknown",
			milView: map[string]interface{}{"classification": "unknown"},
			wantErr: false,
		},
		{
			name:    "valid classification civilian",
			milView: map[string]interface{}{"classification": "civilian"},
			wantErr: false,
		},
		{
			name:    "invalid classification",
			milView: map[string]interface{}{"classification": "enemy"},
			wantErr: true,
			errMsg:  "mil_view.classification: must be one of",
		},
		{
			name:    "classification is number",
			milView: map[string]interface{}{"classification": 123},
			wantErr: true,
			errMsg:  "mil_view.classification: expected string",
		},
		{
			name:    "valid last_seen",
			milView: map[string]interface{}{"last_seen": "2024-01-15T10:30:00Z"},
			wantErr: false,
		},
		{
			name:    "invalid last_seen format",
			milView: map[string]interface{}{"last_seen": "2024-01-15"},
			wantErr: true,
			errMsg:  "mil_view.last_seen: invalid RFC3339 timestamp",
		},
		{
			name:    "last_seen is number",
			milView: map[string]interface{}{"last_seen": 1705312200},
			wantErr: true,
			errMsg:  "mil_view.last_seen: expected string",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateMilViewComponent(tt.milView), tt.wantErr, tt.errMsg)
		})
	}
}

// TestValidateTaskCatalogComponent tests task_catalog component validation
func TestValidateTaskCatalogComponent(t *testing.T) {
	tests := []struct {
		name    string
		catalog map[string]interface{}
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid supported_tasks",
			catalog: map[string]interface{}{
				"supported_tasks": []interface{}{"move_to_location", "take_photo", "return_home"},
			},
			wantErr: false,
		},
		{
			name: "empty supported_tasks",
			catalog: map[string]interface{}{
				"supported_tasks": []interface{}{},
			},
			wantErr: false,
		},
		{
			name: "supported_tasks with empty string",
			catalog: map[string]interface{}{
				"supported_tasks": []interface{}{"move_to_location", ""},
			},
			wantErr: true,
			errMsg:  "task_catalog.supported_tasks[1]: must be non-empty",
		},
		{
			name: "supported_tasks is string",
			catalog: map[string]interface{}{
				"supported_tasks": "move_to_location",
			},
			wantErr: true,
			errMsg:  "task_catalog.supported_tasks: expected array of strings",
		},
		{
			name: "supported_tasks contains number",
			catalog: map[string]interface{}{
				"supported_tasks": []interface{}{"move_to_location", 123},
			},
			wantErr: true,
			errMsg:  "task_catalog.supported_tasks[1]: expected string",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateTaskCatalogComponent(tt.catalog), tt.wantErr, tt.errMsg)
		})
	}
}

// TestValidateMediaRefsComponent tests media_refs component validation
func TestValidateMediaRefsComponent(t *testing.T) {
	tests := []struct {
		name      string
		mediaRefs interface{}
		wantErr   bool
		errMsg    string
	}{
		{
			name: "valid media_refs",
			mediaRefs: []interface{}{
				map[string]interface{}{"object_id": "media-1", "role": "camera_feed"},
				map[string]interface{}{"object_id": "media-2", "role": "thumbnail"},
			},
			wantErr: false,
		},
		{
			name: "valid media_refs with heatmap_data",
			mediaRefs: []interface{}{
				map[string]interface{}{"object_id": "media-1", "role": "heatmap_data"},
			},
			wantErr: false,
		},
		{
			name:      "nil media_refs",
			mediaRefs: nil,
			wantErr:   false,
		},
		{
			name:      "empty media_refs",
			mediaRefs: []interface{}{},
			wantErr:   false,
		},
		{
			name:      "media_refs is object",
			mediaRefs: map[string]interface{}{"object_id": "media-1"},
			wantErr:   true,
			errMsg:    "media_refs: expected array",
		},
		{
			name: "media_refs missing object_id",
			mediaRefs: []interface{}{
				map[string]interface{}{"role": "camera_feed"},
			},
			wantErr: true,
			errMsg:  "media_refs[0]: missing required field 'object_id'",
		},
		{
			name: "media_refs empty object_id",
			mediaRefs: []interface{}{
				map[string]interface{}{"object_id": "", "role": "camera_feed"},
			},
			wantErr: true,
			errMsg:  "media_refs[0].object_id: must be non-empty",
		},
		{
			name: "media_refs missing role",
			mediaRefs: []interface{}{
				map[string]interface{}{"object_id": "media-1"},
			},
			wantErr: true,
			errMsg:  "media_refs[0]: missing required field 'role'",
		},
		{
			name: "media_refs empty role",
			mediaRefs: []interface{}{
				map[string]interface{}{"object_id": "media-1", "role": ""},
			},
			wantErr: true,
			errMsg:  "media_refs[0].role: must be non-empty",
		},
		{
			name: "media_refs invalid role",
			mediaRefs: []interface{}{
				map[string]interface{}{"object_id": "media-1", "role": "invalid_role"},
			},
			wantErr: true,
			errMsg:  "media_refs[0].role: must be one of",
		},
		{
			name: "media_refs role padded with whitespace",
			mediaRefs: []interface{}{
				map[string]interface{}{"object_id": "media-1", "role": " thumbnail "},
			},
			wantErr: true,
			errMsg:  "media_refs[0].role: must not include leading or trailing whitespace",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateMediaRefsComponent(tt.mediaRefs), tt.wantErr, tt.errMsg)
		})
	}
}
