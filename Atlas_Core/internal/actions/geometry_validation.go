package actions

import (
	"fmt"
	"math"
)

// ValidateGeometryComponent validates the geometry component
func ValidateGeometryComponent(geometry map[string]interface{}) *ValidationResult {
	result := &ValidationResult{}

	if len(geometry) == 0 {
		result.AddError("geometry: component cannot be empty")
		return result
	}

	// Check if it's GeoJSON format (has type and coordinates)
	typeValue, hasTypeKey := geometry["type"]
	coordinates, hasCoordinates := geometry["coordinates"]
	geoJSONType, hasType := typeValue.(string)

	if hasType && hasCoordinates {
		// GeoJSON format validation
		validateGeoJSONFormat(geoJSONType, coordinates, result)
	} else if hasTypeKey || hasCoordinates {
		// Partial GeoJSON - missing one field
		if !hasTypeKey {
			result.AddError("geometry: GeoJSON format requires 'type' field")
		} else if !hasType {
			result.AddError("geometry.type must be a string")
		}
		if !hasCoordinates {
			result.AddError("geometry: GeoJSON format requires 'coordinates' field")
		}
	} else {
		// Check for Atlas format
		hasAtlasFormat := false
		if _, hasLat := geometry["point_lat"]; hasLat {
			hasAtlasFormat = true
		}
		if _, hasLng := geometry["point_lng"]; hasLng {
			hasAtlasFormat = true
		}
		if _, hasPolygon := geometry["polygon"]; hasPolygon {
			hasAtlasFormat = true
		}
		if _, hasLine := geometry["line"]; hasLine {
			hasAtlasFormat = true
		}
		if _, hasRadius := geometry["radius_m"]; hasRadius {
			hasAtlasFormat = true
		}

		if hasAtlasFormat {
			validateAtlasFormat(geometry, result)
		} else {
			result.AddError("geometry: unrecognized format - must contain either (type + coordinates) or (point_lat + point_lng / polygon / line / radius_m)")
		}
	}

	return result
}

func validateGeoJSONFormat(geoType string, coordinates interface{}, result *ValidationResult) {
	// Validate type
	validTypes := map[string]bool{"Point": true, "LineString": true, "Polygon": true}
	if !validTypes[geoType] {
		result.AddError("geometry.type must be one of: Point, LineString, Polygon")
		return
	}

	// Validate coordinates is an array
	coordsArray, ok := coordinates.([]interface{})
	if !ok {
		result.AddError("geometry.coordinates must be an array")
		return
	}

	switch geoType {
	case "Point":
		validateGeoJSONPoint(coordsArray, result)
	case "LineString":
		if len(coordsArray) > 10000 {
			result.AddError("geometry.coordinates: exceeds maximum of 10,000 points")
			return
		}
		validateGeoJSONLineString(coordsArray, result)
	case "Polygon":
		validateGeoJSONPolygon(coordsArray, result)
	}
}

func validateGeoJSONPoint(coords []interface{}, result *ValidationResult) {
	if len(coords) < 2 {
		result.AddError("geometry.coordinates: Point requires at least [longitude, latitude]")
		return
	}

	for i, coord := range coords {
		num, ok := toFloat64(coord)
		if !ok {
			result.AddError(fmt.Sprintf("geometry.coordinates[%d]: expected number, got %T", i, coord))
			continue
		}
		if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError(fmt.Sprintf("geometry.coordinates[%d]: must be finite (not NaN or Inf)", i))
			continue
		}

		switch i {
		case 0:
			// Longitude
			if num < -180 || num > 180 {
				result.AddError(fmt.Sprintf("geometry.coordinates[0]: longitude %.6f is out of range [-180, 180]", num))
			}
		case 1:
			// Latitude
			if num < -90 || num > 90 {
				result.AddError(fmt.Sprintf("geometry.coordinates[1]: latitude %.6f is out of range [-90, 90]", num))
			}
		}
		// Additional ordinates (e.g. M, Z): require finite numeric values only.
	}
}

func validateGeoJSONLineString(coords []interface{}, result *ValidationResult) {
	if len(coords) < 2 {
		result.AddError("geometry.coordinates: LineString requires at least 2 positions")
		return
	}

	for i, pos := range coords {
		posArray, ok := pos.([]interface{})
		if !ok {
			result.AddError(fmt.Sprintf("geometry.coordinates[%d]: expected [longitude, latitude] array", i))
			continue
		}
		validatePosition(posArray, fmt.Sprintf("geometry.coordinates[%d]", i), result)
	}
}

func validateGeoJSONPolygon(coords []interface{}, result *ValidationResult) {
	if len(coords) == 0 {
		result.AddError("geometry.coordinates: Polygon requires at least one ring")
		return
	}

	// Count total positions across all rings for the point limit check
	totalPositions := 0
	for _, ring := range coords {
		if ringArray, ok := ring.([]interface{}); ok {
			totalPositions += len(ringArray)
		}
	}

	if totalPositions > 10000 {
		result.AddError("geometry.coordinates: exceeds maximum of 10,000 total positions across all rings")
		return
	}

	for ringIdx, ring := range coords {
		ringArray, ok := ring.([]interface{})
		if !ok {
			result.AddError(fmt.Sprintf("geometry.coordinates[%d]: expected ring array", ringIdx))
			continue
		}

		if len(ringArray) < 4 {
			result.AddError(fmt.Sprintf("geometry.coordinates[%d]: Polygon ring requires at least 4 positions", ringIdx))
			continue
		}

		// Validate each position in the ring
		for posIdx, pos := range ringArray {
			posArray, ok := pos.([]interface{})
			if !ok {
				result.AddError(fmt.Sprintf("geometry.coordinates[%d][%d]: expected [longitude, latitude] array", ringIdx, posIdx))
				continue
			}
			validatePosition(posArray, fmt.Sprintf("geometry.coordinates[%d][%d]", ringIdx, posIdx), result)
		}

		// GeoJSON requires closed rings: first position equals last
		first, okF := ringArray[0].([]interface{})
		last, okL := ringArray[len(ringArray)-1].([]interface{})
		if okF && okL && !ringLonLatEqual(first, last) {
			result.AddError(fmt.Sprintf("geometry.coordinates[%d]: Polygon ring must be closed (first position must equal last)", ringIdx))
		}
	}
}

// ringLonLatEqual reports whether two GeoJSON positions are identical (all ordinates).
func ringLonLatEqual(a, b []interface{}) bool {
	if len(a) != len(b) || len(a) < 2 {
		return false
	}
	for i := range a {
		va, okA := toFloat64(a[i])
		vb, okB := toFloat64(b[i])
		if !okA || !okB || va != vb {
			return false
		}
	}
	return true
}

func validatePosition(pos []interface{}, path string, result *ValidationResult) {
	if len(pos) < 2 {
		result.AddError(fmt.Sprintf("%s: expected [longitude, latitude] array with at least 2 elements", path))
		return
	}

	for i, coord := range pos {
		num, ok := toFloat64(coord)
		if !ok {
			result.AddError(fmt.Sprintf("%s[%d]: expected number, got %T", path, i, coord))
			continue
		}
		if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError(fmt.Sprintf("%s[%d]: must be finite (not NaN or Inf)", path, i))
			continue
		}

		switch i {
		case 0:
			// Longitude
			if num < -180 || num > 180 {
				result.AddError(fmt.Sprintf("%s[0]: longitude %.6f is out of range [-180, 180]", path, num))
			}
		case 1:
			// Latitude
			if num < -90 || num > 90 {
				result.AddError(fmt.Sprintf("%s[1]: latitude %.6f is out of range [-90, 90]", path, num))
			}
		}
		// Additional ordinates: finite numeric values only (validated above).
	}
}

func validateAtlasFormat(geometry map[string]interface{}, result *ValidationResult) {
	// Check if point coordinates are provided together
	hasPointLat := false
	hasPointLng := false
	hasRadius := false

	if _, ok := geometry["point_lat"]; ok {
		hasPointLat = true
	}
	if _, ok := geometry["point_lng"]; ok {
		hasPointLng = true
	}
	if _, ok := geometry["radius_m"]; ok {
		hasRadius = true
	}

	// If either point_lat or point_lng is present, both must be present
	if hasPointLat != hasPointLng {
		result.AddError("geometry: point_lat and point_lng must be provided together")
	}

	// If radius is present, both point coordinates must be present (for circle)
	if hasRadius && (!hasPointLat || !hasPointLng) {
		result.AddError("geometry: radius_m requires both point_lat and point_lng")
	}

	// Validate point fields
	if lat, ok := geometry["point_lat"]; ok {
		num, ok := toFloat64(lat)
		if !ok {
			result.AddError("geometry.point_lat: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("geometry.point_lat: must be finite (not NaN or Inf)")
		} else if num < -90 || num > 90 {
			result.AddError(fmt.Sprintf("geometry.point_lat: latitude %.6f is out of range [-90, 90]", num))
		}
	}

	if lng, ok := geometry["point_lng"]; ok {
		num, ok := toFloat64(lng)
		if !ok {
			result.AddError("geometry.point_lng: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("geometry.point_lng: must be finite (not NaN or Inf)")
		} else if num < -180 || num > 180 {
			result.AddError(fmt.Sprintf("geometry.point_lng: longitude %.6f is out of range [-180, 180]", num))
		}
	}

	// Validate radius
	if radius, ok := geometry["radius_m"]; ok {
		num, ok := toFloat64(radius)
		if !ok {
			result.AddError("geometry.radius_m: expected number")
		} else if math.IsNaN(num) || math.IsInf(num, 0) {
			result.AddError("geometry.radius_m: must be finite (not NaN or Inf)")
		} else if num <= 0 {
			result.AddError(fmt.Sprintf("geometry.radius_m: must be positive, got %.6f", num))
		}
	}

	// Validate polygon
	if polygon, ok := geometry["polygon"]; ok {
		polygonArray, ok := polygon.([]interface{})
		if !ok {
			result.AddError("geometry.polygon: expected array of [lat, lng] pairs")
		} else {
			if len(polygonArray) < 3 {
				result.AddError(fmt.Sprintf("geometry.polygon: requires at least 3 points, got %d", len(polygonArray)))
			}
			if len(polygonArray) > 10000 {
				result.AddError("geometry.polygon: exceeds maximum of 10,000 points")
			}
			for i, point := range polygonArray {
				pointArray, ok := point.([]interface{})
				if !ok {
					result.AddError(fmt.Sprintf("geometry.polygon[%d]: expected [lat, lng] array", i))
					continue
				}
				validateAtlasPoint(pointArray, fmt.Sprintf("geometry.polygon[%d]", i), result)
			}
		}
	}

	// Validate line
	if line, ok := geometry["line"]; ok {
		lineArray, ok := line.([]interface{})
		if !ok {
			result.AddError("geometry.line: expected array of [lat, lng] pairs")
		} else {
			if len(lineArray) < 2 {
				result.AddError(fmt.Sprintf("geometry.line: requires at least 2 points, got %d", len(lineArray)))
			}
			if len(lineArray) > 10000 {
				result.AddError("geometry.line: exceeds maximum of 10,000 points")
			}
			for i, point := range lineArray {
				pointArray, ok := point.([]interface{})
				if !ok {
					result.AddError(fmt.Sprintf("geometry.line[%d]: expected [lat, lng] array", i))
					continue
				}
				validateAtlasPoint(pointArray, fmt.Sprintf("geometry.line[%d]", i), result)
			}
		}
	}
}

func validateAtlasPoint(point []interface{}, path string, result *ValidationResult) {
	if len(point) != 2 {
		result.AddError(fmt.Sprintf("%s: expected [lat, lng] array with exactly 2 elements", path))
		return
	}

	// Latitude (first element in Atlas format)
	lat, ok := toFloat64(point[0])
	if !ok {
		result.AddError(fmt.Sprintf("%s[0]: expected number for latitude", path))
	} else if math.IsNaN(lat) || math.IsInf(lat, 0) {
		result.AddError(fmt.Sprintf("%s[0]: latitude must be finite (not NaN or Inf)", path))
	} else if lat < -90 || lat > 90 {
		result.AddError(fmt.Sprintf("%s[0]: latitude %.6f is out of range [-90, 90]", path, lat))
	}

	// Longitude (second element in Atlas format)
	lng, ok := toFloat64(point[1])
	if !ok {
		result.AddError(fmt.Sprintf("%s[1]: expected number for longitude", path))
	} else if math.IsNaN(lng) || math.IsInf(lng, 0) {
		result.AddError(fmt.Sprintf("%s[1]: longitude must be finite (not NaN or Inf)", path))
	} else if lng < -180 || lng > 180 {
		result.AddError(fmt.Sprintf("%s[1]: longitude %.6f is out of range [-180, 180]", path, lng))
	}
}
