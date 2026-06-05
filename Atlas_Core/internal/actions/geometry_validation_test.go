package actions

import (
	"math"
	"testing"
)

func TestValidateGeometry_GeoJSON_LineString(t *testing.T) {
	tests := []struct {
		name      string
		geometry  map[string]interface{}
		wantError bool
		errMsg    string
	}{
		{
			name: "valid 2-point line",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": []interface{}{[]interface{}{-73.9, 40.7}, []interface{}{-73.8, 40.8}},
			},
			wantError: false,
		},
		{
			name: "valid 5-point line",
			geometry: map[string]interface{}{
				"type": "LineString",
				"coordinates": []interface{}{
					[]interface{}{-73.9, 40.7},
					[]interface{}{-73.8, 40.8},
					[]interface{}{-73.7, 40.9},
					[]interface{}{-73.6, 41.0},
					[]interface{}{-73.5, 41.1},
				},
			},
			wantError: false,
		},
		{
			name: "single point (too few)",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": []interface{}{[]interface{}{-73.9, 40.7}},
			},
			wantError: true,
			errMsg:    "LineString requires at least 2 positions",
		},
		{
			name: "empty coordinates",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": []interface{}{},
			},
			wantError: true,
			errMsg:    "LineString requires at least 2 positions",
		},
		{
			name: "one bad coordinate in array",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": []interface{}{[]interface{}{-73.9, 40.7}, []interface{}{"bad", 40.8}},
			},
			wantError: true,
			errMsg:    "expected number",
		},
		{
			name: "nested too deeply",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": []interface{}{[]interface{}{[]interface{}{-73.9, 40.7}}},
			},
			wantError: true,
			errMsg:    "LineString requires at least 2 positions",
		},
		{
			name: "wrong GeoJSON type keyword",
			geometry: map[string]interface{}{
				"type":        "MultiLineString",
				"coordinates": []interface{}{[]interface{}{-73.9, 40.7}, []interface{}{-73.8, 40.8}},
			},
			wantError: true,
			errMsg:    "geometry.type must be one of: Point, LineString, Polygon",
		},
		{
			name: "coordinates not an array",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": "not-an-array",
			},
			wantError: true,
			errMsg:    "geometry.coordinates must be an array",
		},
		{
			name: "valid with altitude on each position",
			geometry: map[string]interface{}{
				"type": "LineString",
				"coordinates": []interface{}{
					[]interface{}{-73.9, 40.7, 10.0},
					[]interface{}{-73.8, 40.8, 20.0},
				},
			},
			wantError: false,
		},
		{
			name: "wrong case type keyword",
			geometry: map[string]interface{}{
				"type":        "linestring",
				"coordinates": []interface{}{[]interface{}{0.0, 0.0}, []interface{}{1.0, 1.0}},
			},
			wantError: true,
			errMsg:    "geometry.type must be one of",
		},
		{
			name: "missing type",
			geometry: map[string]interface{}{
				"coordinates": []interface{}{[]interface{}{0.0, 0.0}, []interface{}{1.0, 1.0}},
			},
			wantError: true,
			errMsg:    "geometry: GeoJSON format requires 'type' field",
		},
		{
			name: "missing coordinates",
			geometry: map[string]interface{}{
				"type": "LineString",
			},
			wantError: true,
			errMsg:    "geometry: GeoJSON format requires 'coordinates' field",
		},
		{
			name: "position not nested array",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": []interface{}{"bad", []interface{}{1.0, 1.0}},
			},
			wantError: true,
			errMsg:    "expected [longitude, latitude] array",
		},
		{
			name: "NaN in ordinate",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": []interface{}{[]interface{}{math.NaN(), 0.0}, []interface{}{1.0, 1.0}},
			},
			wantError: true,
			errMsg:    "must be finite",
		},
		{
			name: "longitude out of range on first position",
			geometry: map[string]interface{}{
				"type":        "LineString",
				"coordinates": []interface{}{[]interface{}{200.0, 0.0}, []interface{}{1.0, 1.0}},
			},
			wantError: true,
			errMsg:    "longitude",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateGeometryComponent(tt.geometry), tt.wantError, tt.errMsg)
		})
	}
}

// TestValidateGeometry_GeoJSON_Polygon tests GeoJSON Polygon validation
func TestValidateGeometry_GeoJSON_Polygon(t *testing.T) {
	tests := []struct {
		name      string
		geometry  map[string]interface{}
		wantError bool
		errMsg    string
	}{
		{
			name: "valid closed triangle",
			geometry: map[string]interface{}{
				"type": "Polygon",
				"coordinates": []interface{}{
					[]interface{}{
						[]interface{}{0.0, 0.0},
						[]interface{}{1.0, 0.0},
						[]interface{}{0.0, 1.0},
						[]interface{}{0.0, 0.0},
					},
				},
			},
			wantError: false,
		},
		{
			name: "unclosed ring (3 unique points, no repeat)",
			geometry: map[string]interface{}{
				"type": "Polygon",
				"coordinates": []interface{}{
					[]interface{}{
						[]interface{}{0.0, 0.0},
						[]interface{}{1.0, 0.0},
						[]interface{}{0.0, 1.0},
					},
				},
			},
			wantError: true,
			errMsg:    "Polygon ring requires at least 4 positions",
		},
		{
			name: "4 positions but first and last differ (not closed)",
			geometry: map[string]interface{}{
				"type": "Polygon",
				"coordinates": []interface{}{
					[]interface{}{
						[]interface{}{0.0, 0.0},
						[]interface{}{1.0, 0.0},
						[]interface{}{1.0, 1.0},
						[]interface{}{0.0, 1.0},
					},
				},
			},
			wantError: true,
			errMsg:    "closed",
		},
		{
			name: "4 positions first and last same lon/lat but different third ordinate (not closed)",
			geometry: map[string]interface{}{
				"type": "Polygon",
				"coordinates": []interface{}{
					[]interface{}{
						[]interface{}{0.0, 0.0, 10.0},
						[]interface{}{1.0, 0.0},
						[]interface{}{1.0, 1.0},
						[]interface{}{0.0, 0.0, 20.0},
					},
				},
			},
			wantError: true,
			errMsg:    "closed",
		},
		{
			name: "only 2 unique points",
			geometry: map[string]interface{}{
				"type": "Polygon",
				"coordinates": []interface{}{
					[]interface{}{
						[]interface{}{0.0, 0.0},
						[]interface{}{1.0, 0.0},
						[]interface{}{0.0, 0.0},
					},
				},
			},
			wantError: true,
			errMsg:    "Polygon ring requires at least 4 positions",
		},
		{
			name: "empty outer ring",
			geometry: map[string]interface{}{
				"type":        "Polygon",
				"coordinates": []interface{}{[]interface{}{}},
			},
			wantError: true,
			errMsg:    "Polygon ring requires at least 4 positions",
		},
		{
			name: "no rings",
			geometry: map[string]interface{}{
				"type":        "Polygon",
				"coordinates": []interface{}{},
			},
			wantError: true,
			errMsg:    "Polygon requires at least one ring",
		},
		{
			name: "coordinates is flat array",
			geometry: map[string]interface{}{
				"type":        "Polygon",
				"coordinates": []interface{}{0.0, 0.0, 1.0, 0.0, 0.0, 1.0},
			},
			wantError: true,
			errMsg:    "expected ring array",
		},
		{
			name: "ring contains non-array element",
			geometry: map[string]interface{}{
				"type": "Polygon",
				"coordinates": []interface{}{
					[]interface{}{
						[]interface{}{0.0, 0.0},
						"bad",
						[]interface{}{0.0, 1.0},
						[]interface{}{0.0, 0.0},
					},
				},
			},
			wantError: true,
			errMsg:    "expected [longitude, latitude] array",
		},
		{
			name: "ring contains invalid coordinate",
			geometry: map[string]interface{}{
				"type": "Polygon",
				"coordinates": []interface{}{
					[]interface{}{
						[]interface{}{0.0, 0.0},
						[]interface{}{999.0, 0.0},
						[]interface{}{0.0, 1.0},
						[]interface{}{0.0, 0.0},
					},
				},
			},
			wantError: true,
			errMsg:    "longitude",
		},
		{
			name: "multiple rings exceed total position limit",
			geometry: map[string]interface{}{
				"type": "Polygon",
				"coordinates": func() []interface{} {
					// Two closed rings (first point == last), 5001 positions each → 10002 total (> 10k cap)
					ring1 := make([]interface{}, 5001)
					ring2 := make([]interface{}, 5001)
					for i := 0; i < 5000; i++ {
						lon := -180.0 + (float64(i) * 0.01)
						ring1[i] = []interface{}{lon, 0.0}
						ring2[i] = []interface{}{lon, 1.0}
					}
					ring1[5000] = ring1[0]
					ring2[5000] = ring2[0]
					return []interface{}{ring1, ring2}
				}(),
			},
			wantError: true,
			errMsg:    "exceeds maximum of 10000 total positions across all rings",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateGeometryComponent(tt.geometry), tt.wantError, tt.errMsg)
		})
	}
}

// TestValidateGeometry_AtlasFormat tests Atlas format geometry validation
func TestValidateGeometry_AtlasFormat(t *testing.T) {
	tests := []struct {
		name      string
		geometry  map[string]interface{}
		wantError bool
		errMsg    string
	}{
		{
			name: "valid point",
			geometry: map[string]interface{}{
				"point_lat": 40.7,
				"point_lng": -73.9,
			},
			wantError: false,
		},
		{
			name: "valid circle",
			geometry: map[string]interface{}{
				"point_lat": 40.7,
				"point_lng": -73.9,
				"radius_m":  500.0,
			},
			wantError: false,
		},
		{
			name: "valid polygon",
			geometry: map[string]interface{}{
				"polygon": []interface{}{
					[]interface{}{40.7, -73.9},
					[]interface{}{40.8, -73.8},
					[]interface{}{40.7, -73.8},
				},
			},
			wantError: false,
		},
		{
			name: "valid line",
			geometry: map[string]interface{}{
				"line": []interface{}{
					[]interface{}{40.7, -73.9},
					[]interface{}{40.8, -73.8},
				},
			},
			wantError: false,
		},
		{
			name: "point_lat is string",
			geometry: map[string]interface{}{
				"point_lat": "40.7",
				"point_lng": -73.9,
			},
			wantError: true,
			errMsg:    "geometry.point_lat: expected number",
		},
		{
			name: "point_lat out of range",
			geometry: map[string]interface{}{
				"point_lat": 95.0,
				"point_lng": -73.9,
			},
			wantError: true,
			errMsg:    "geometry.point_lat: latitude",
		},
		{
			name: "only point_lat without point_lng",
			geometry: map[string]interface{}{
				"point_lat": 40.7,
			},
			wantError: true,
			errMsg:    "geometry: point_lat and point_lng must be provided together",
		},
		{
			name: "only point_lng without point_lat",
			geometry: map[string]interface{}{
				"point_lng": -73.9,
			},
			wantError: true,
			errMsg:    "geometry: point_lat and point_lng must be provided together",
		},
		{
			name: "radius_m without point coordinates",
			geometry: map[string]interface{}{
				"radius_m": 500.0,
			},
			wantError: true,
			errMsg:    "geometry: radius_m requires both point_lat and point_lng",
		},
		{
			name: "radius_m with only point_lat",
			geometry: map[string]interface{}{
				"point_lat": 40.7,
				"radius_m":  500.0,
			},
			wantError: true,
			errMsg:    "geometry: point_lat and point_lng must be provided together",
		},
		{
			name: "radius_m is negative",
			geometry: map[string]interface{}{
				"point_lat": 40.7,
				"point_lng": -73.9,
				"radius_m":  -100.0,
			},
			wantError: true,
			errMsg:    "geometry.radius_m: must be positive",
		},
		{
			name: "radius_m is zero",
			geometry: map[string]interface{}{
				"point_lat": 40.7,
				"point_lng": -73.9,
				"radius_m":  0.0,
			},
			wantError: true,
			errMsg:    "geometry.radius_m: must be positive",
		},
		{
			name: "polygon has only 2 points",
			geometry: map[string]interface{}{
				"polygon": []interface{}{
					[]interface{}{40.7, -73.9},
					[]interface{}{40.8, -73.8},
				},
			},
			wantError: true,
			errMsg:    "geometry.polygon: requires at least 3 points",
		},
		{
			name: "polygon contains non-array element",
			geometry: map[string]interface{}{
				"polygon": []interface{}{
					[]interface{}{40.7, -73.9},
					"bad",
				},
			},
			wantError: true,
			errMsg:    "geometry.polygon[1]: expected [lat, lng] array",
		},
		{
			name: "line has only 1 point",
			geometry: map[string]interface{}{
				"line": []interface{}{
					[]interface{}{40.7, -73.9},
				},
			},
			wantError: true,
			errMsg:    "geometry.line: requires at least 2 points",
		},
		{
			name:      "empty object",
			geometry:  map[string]interface{}{},
			wantError: true,
			errMsg:    "geometry: component cannot be empty",
		},
		{
			name: "no recognizable fields",
			geometry: map[string]interface{}{
				"foo": "bar",
			},
			wantError: true,
			errMsg:    "geometry: unrecognized format",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertValidationResult(t, ValidateGeometryComponent(tt.geometry), tt.wantError, tt.errMsg)
		})
	}
}
