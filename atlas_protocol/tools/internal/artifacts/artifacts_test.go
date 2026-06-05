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
