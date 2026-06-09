package actions

import (
	"math"
	"testing"
)

// TestValidateGeometry_GeoJSON_Point tests GeoJSON Point validation
func TestValidateGeometry_GeoJSON_Point(t *testing.T) {
	tests := []struct {
		name      string
		geometry  map[string]interface{}
		wantError bool
		errMsg    string
	}{
		{
			name: "valid point",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{-73.9, 40.7},
			},
			wantError: false,
		},
		{
			name: "valid point with altitude",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{-73.9, 40.7, 100.0},
			},
			wantError: false,
		},
		{
			name: "type wrong case",
			geometry: map[string]interface{}{
				"type":        "point",
				"coordinates": []interface{}{-73.9, 40.7},
			},
			wantError: true,
			errMsg:    "geometry.type must be one of",
		},
		{
			name: "missing type",
			geometry: map[string]interface{}{
				"coordinates": []interface{}{-73.9, 40.7},
			},
			wantError: true,
			errMsg:    "geometry: GeoJSON format requires 'type' field",
		},
		{
			name: "missing coordinates",
			geometry: map[string]interface{}{
				"type": "Point",
			},
			wantError: true,
			errMsg:    "geometry: GeoJSON format requires 'coordinates' field",
		},
		{
			name: "coordinates is string",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": "[-73.9, 40.7]",
			},
			wantError: true,
			errMsg:    "geometry.coordinates must be an array",
		},
		{
			name: "coordinates is object",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": map[string]interface{}{"x": 1, "y": 2},
			},
			wantError: true,
			errMsg:    "geometry.coordinates must be an array",
		},
		{
			name: "coordinates empty array",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{},
			},
			wantError: true,
			errMsg:    "Point requires at least",
		},
		{
			name: "coordinates single element",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{-73.9},
			},
			wantError: true,
			errMsg:    "Point requires at least",
		},
		{
			name: "longitude out of range",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{181.0, 40.7},
			},
			wantError: true,
			errMsg:    "longitude",
		},
		{
			name: "latitude out of range",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{-73.9, 91.0},
			},
			wantError: true,
			errMsg:    "latitude",
		},
		{
			name: "coordinates contain string",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{"abc", 40.7},
			},
			wantError: true,
			errMsg:    "expected number",
		},
		{
			name: "coordinates contain null",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{nil, 40.7},
			},
			wantError: true,
			errMsg:    "expected number",
		},
		{
			name: "coordinates contain NaN",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{math.NaN(), 40.7},
			},
			wantError: true,
			errMsg:    "must be finite",
		},
		{
			name: "coordinates contain Inf",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{math.Inf(1), 40.7},
			},
			wantError: true,
			errMsg:    "must be finite",
		},
		{
			name: "boundary: longitude exactly -180",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{-180.0, 0.0},
			},
			wantError: false,
		},
		{
			name: "boundary: longitude exactly 180",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{180.0, 0.0},
			},
			wantError: false,
		},
		{
			name: "boundary: latitude exactly -90",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{0.0, -90.0},
			},
			wantError: false,
		},
		{
			name: "boundary: latitude exactly 90",
			geometry: map[string]interface{}{
				"type":        "Point",
				"coordinates": []interface{}{0.0, 90.0},
			},
			wantError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateGeometryComponent(tt.geometry), tt.wantError, tt.errMsg)
		})
	}
}

// GeoJSON LineString, Polygon, and Atlas-format geometry tests live in geometry_validation_test.go.

func TestValidateStatusComponent(t *testing.T) {
	tests := []struct {
		name      string
		status    map[string]interface{}
		wantError bool
		errMsg    string
	}{
		{
			name: "valid value only",
			status: map[string]interface{}{
				"value": "online",
			},
			wantError: false,
		},
		{
			name: "valid value and last_update RFC3339",
			status: map[string]interface{}{
				"value":       "busy",
				"last_update": "2030-01-01T12:00:00Z",
			},
			wantError: false,
		},
		{
			name: "missing value",
			status: map[string]interface{}{
				"last_update": "2030-01-01T12:00:00Z",
			},
			wantError: true,
			errMsg:    "status.value is required",
		},
		{
			name: "value not string",
			status: map[string]interface{}{
				"value": 42,
			},
			wantError: true,
			errMsg:    "status.value is required",
		},
		{
			name: "value whitespace only",
			status: map[string]interface{}{
				"value": "   ",
			},
			wantError: true,
			errMsg:    "status.value is required",
		},
		{
			name: "last_update not string",
			status: map[string]interface{}{
				"value":       "ok",
				"last_update": 12345,
			},
			wantError: true,
			errMsg:    "status.last_update must be a string",
		},
		{
			name: "last_update invalid RFC3339",
			status: map[string]interface{}{
				"value":       "ok",
				"last_update": "not-a-date",
			},
			wantError: true,
			errMsg:    "status.last_update must be a valid RFC3339",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateStatusComponent(tt.status), tt.wantError, tt.errMsg)
		})
	}
}

func TestValidateHeartbeatComponent(t *testing.T) {
	tests := []struct {
		name      string
		heartbeat map[string]interface{}
		wantError bool
		errMsg    string
	}{
		{
			name: "valid last_seen",
			heartbeat: map[string]interface{}{
				"last_seen": "2030-06-15T08:30:00Z",
			},
			wantError: false,
		},
		{
			name:      "missing last_seen",
			heartbeat: map[string]interface{}{},
			wantError: true,
			errMsg:    "heartbeat.last_seen is required",
		},
		{
			name: "last_seen not string",
			heartbeat: map[string]interface{}{
				"last_seen": 123,
			},
			wantError: true,
			errMsg:    "heartbeat.last_seen is required",
		},
		{
			name: "last_seen whitespace only",
			heartbeat: map[string]interface{}{
				"last_seen": "  ",
			},
			wantError: true,
			errMsg:    "heartbeat.last_seen is required",
		},
		{
			name: "last_seen invalid RFC3339",
			heartbeat: map[string]interface{}{
				"last_seen": "yesterday",
			},
			wantError: true,
			errMsg:    "heartbeat.last_seen must be a valid RFC3339",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateHeartbeatComponent(tt.heartbeat), tt.wantError, tt.errMsg)
		})
	}
}
