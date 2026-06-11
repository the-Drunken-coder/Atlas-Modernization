package artifacts

import (
	"reflect"
	"testing"
)

func TestNormalizeWildcardPatternProperties(t *testing.T) {
	jsonValue := map[string]any{"$ref": "#/$defs/%23JSONValue"}
	root := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"patternProperties": map[string]any{
			"": jsonValue,
		},
	}

	normalizeWildcardPatternProperties(root)

	if _, exists := root["patternProperties"]; exists {
		t.Fatalf("patternProperties = %#v, want removed", root["patternProperties"])
	}
	if got := root["additionalProperties"]; !reflect.DeepEqual(got, jsonValue) {
		t.Fatalf("additionalProperties = %#v, want %#v", got, jsonValue)
	}
}

func TestNormalizeWildcardPatternPropertiesPreservesSpecificPatterns(t *testing.T) {
	root := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"patternProperties": map[string]any{
			"":         map[string]any{"$ref": "#/$defs/%23JSONValue"},
			"^custom_": map[string]any{"type": "object"},
		},
	}

	normalizeWildcardPatternProperties(root)

	patternProperties, ok := root["patternProperties"].(map[string]any)
	if !ok {
		t.Fatal("patternProperties was removed, want specific patterns preserved")
	}
	if _, exists := patternProperties[""]; !exists {
		t.Fatal("wildcard pattern was removed from mixed patternProperties")
	}
	if got := root["additionalProperties"]; got != false {
		t.Fatalf("additionalProperties = %#v, want false", got)
	}
}

func TestNormalizeIntegerAllOf(t *testing.T) {
	root := map[string]any{
		"allOf": []any{
			map[string]any{"type": "number"},
			map[string]any{"type": "integer", "minimum": float64(0)},
		},
	}

	normalizeIntegerAllOf(root)

	if _, exists := root["allOf"]; exists {
		t.Fatalf("allOf = %#v, want removed", root["allOf"])
	}
	if got := root["type"]; got != "integer" {
		t.Fatalf("type = %#v, want integer", got)
	}
	if got := root["minimum"]; got != float64(0) {
		t.Fatalf("minimum = %#v, want 0", got)
	}
}

func TestNormalizeIntegerAllOfPreservesIntegerConstraints(t *testing.T) {
	root := map[string]any{
		"allOf": []any{
			map[string]any{"type": "integer", "minimum": float64(0), "maximum": float64(100), "multipleOf": float64(5), "exclusiveMinimum": true},
		},
	}

	normalizeIntegerAllOf(root)

	if _, exists := root["allOf"]; exists {
		t.Fatalf("normalizeIntegerAllOf left allOf = %#v, want removed", root["allOf"])
	}
	want := map[string]any{"type": "integer", "minimum": float64(0), "maximum": float64(100), "multipleOf": float64(5), "exclusiveMinimum": true}
	if !reflect.DeepEqual(root, want) {
		t.Fatalf("normalizeIntegerAllOf root = %#v, want %#v", root, want)
	}
}

func TestNormalizeIntegerAllOfLeavesAmbiguousOrInvalidAllOf(t *testing.T) {
	tests := []struct {
		name string
		root map[string]any
	}{
		{
			name: "conflicting type and minimum constraints",
			root: map[string]any{
				"allOf": []any{
					map[string]any{"type": "number", "minimum": float64(10)},
					map[string]any{"type": "integer", "minimum": float64(0)},
				},
			},
		},
		{name: "empty allOf", root: map[string]any{"allOf": []any{}}},
		{name: "non object entry", root: map[string]any{"allOf": []any{"integer"}}},
		{name: "no allOf", root: map[string]any{"type": "object"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := cloneMap(tt.root)

			normalizeIntegerAllOf(tt.root)

			if !reflect.DeepEqual(tt.root, before) {
				t.Fatalf("normalizeIntegerAllOf mutated root = %#v, want %#v", tt.root, before)
			}
		})
	}
}

func TestSchemaDetectorsAllowExtraProperties(t *testing.T) {
	objectReference := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"entity_id": map[string]any{"type": "string"},
			"task_id":   map[string]any{"type": "string"},
			"title":     map[string]any{"type": "string"},
		},
	}
	if !isObjectReferenceSchema(objectReference) {
		t.Fatal("isObjectReferenceSchema rejected object reference schema with extra metadata property")
	}
	for _, requiredProperty := range []string{"entity_id", "task_id"} {
		t.Run("object reference missing "+requiredProperty, func(t *testing.T) {
			candidate := cloneMap(objectReference)
			delete(candidate["properties"].(map[string]any), requiredProperty)
			if isObjectReferenceSchema(candidate) {
				t.Fatalf("isObjectReferenceSchema accepted schema without %s", requiredProperty)
			}
		})
	}

	geometry := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"point_lat":  map[string]any{"type": "number"},
			"point_lng":  map[string]any{"type": "number"},
			"radius_m":   map[string]any{"type": "number"},
			"line":       map[string]any{"type": "array"},
			"polygon":    map[string]any{"type": "array"},
			"confidence": map[string]any{"type": "number"},
		},
	}
	if !isAtlasGeometrySchema(geometry) {
		t.Fatal("isAtlasGeometrySchema rejected geometry schema with extra metadata property")
	}
	for _, requiredProperty := range []string{"point_lat", "point_lng", "radius_m", "line", "polygon"} {
		t.Run("geometry missing "+requiredProperty, func(t *testing.T) {
			candidate := cloneMap(geometry)
			delete(candidate["properties"].(map[string]any), requiredProperty)
			if isAtlasGeometrySchema(candidate) {
				t.Fatalf("isAtlasGeometrySchema accepted schema without %s", requiredProperty)
			}
		})
	}
}

func TestValidateEntityComponentSchemaKeys(t *testing.T) {
	if err := validateEntityComponentSchemaKeys(entityComponentSchemaKeys); err != nil {
		t.Fatalf("validateEntityComponentSchemaKeys canonical keys: %v", err)
	}

	extra := append([]string(nil), entityComponentSchemaKeys...)
	extra = append(extra, "new_component")
	if err := validateEntityComponentSchemaKeys(extra); err == nil {
		t.Fatal("validateEntityComponentSchemaKeys accepted missing descriptor for new_component")
	}

	missing := append([]string(nil), entityComponentSchemaKeys[:len(entityComponentSchemaKeys)-1]...)
	if err := validateEntityComponentSchemaKeys(missing); err == nil {
		t.Fatal("validateEntityComponentSchemaKeys accepted stale descriptor set")
	}
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = cloneValue(value)
	}
	return out
}

func cloneValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneMap(typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = cloneValue(item)
		}
		return out
	default:
		return typed
	}
}
