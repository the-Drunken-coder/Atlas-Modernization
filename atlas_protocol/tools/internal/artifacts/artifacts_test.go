package artifacts

import (
	"reflect"
	"strings"
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

func TestTypeScriptGeneratorAddDefAllowsIdenticalSchema(t *testing.T) {
	schema := typeScriptSchema{"type": "object"}
	g := &typeScriptGenerator{defs: map[string]typeScriptSchema{}}

	if err := g.addDef("Thing", schema); err != nil {
		t.Fatalf("first addDef returned error: %v", err)
	}
	if err := g.addDef("Thing", cloneMap(schema)); err != nil {
		t.Fatalf("second addDef returned error: %v", err)
	}
	if !reflect.DeepEqual(g.defs["Thing"], schema) {
		t.Fatalf("defs[Thing] = %#v, want %#v", g.defs["Thing"], schema)
	}
}

func TestTypeScriptGeneratorAddDefAllowsIdenticalSchemaUnderDifferentName(t *testing.T) {
	schema := typeScriptSchema{"type": "object"}
	g := &typeScriptGenerator{defs: map[string]typeScriptSchema{}}

	if err := g.addDef("Thing1", schema); err != nil {
		t.Fatalf("addDef Thing1 returned error: %v", err)
	}
	if err := g.addDef("Thing2", cloneMap(schema)); err != nil {
		t.Fatalf("addDef Thing2 returned error: %v", err)
	}
	for _, name := range []string{"Thing1", "Thing2"} {
		if !reflect.DeepEqual(g.defs[name], schema) {
			t.Fatalf("defs[%s] = %#v, want %#v", name, g.defs[name], schema)
		}
	}
}

func TestTypeScriptGeneratorAddDefReplacesSelfRef(t *testing.T) {
	selfRef := typeScriptSchema{"$ref": "#/$defs/%23Thing"}
	replacement := typeScriptSchema{"type": "string"}
	g := &typeScriptGenerator{defs: map[string]typeScriptSchema{"Thing": selfRef}}

	if err := g.addDef("Thing", replacement); err != nil {
		t.Fatalf("addDef self-ref replacement returned error: %v", err)
	}
	if !reflect.DeepEqual(g.defs["Thing"], replacement) {
		t.Fatalf("defs[Thing] = %#v, want %#v", g.defs["Thing"], replacement)
	}
}

func TestTypeScriptGeneratorAddDefRejectsNameCollision(t *testing.T) {
	existing := typeScriptSchema{"type": "string"}
	colliding := typeScriptSchema{"type": "number"}
	g := &typeScriptGenerator{defs: map[string]typeScriptSchema{"Thing": existing}}

	err := g.addDef("Thing", colliding)
	if err == nil {
		t.Fatal("addDef accepted colliding schemas")
	}
	if !strings.Contains(err.Error(), "Thing") || !strings.Contains(err.Error(), "collision") {
		t.Fatalf("collision error = %q, want type name and collision context", err.Error())
	}
	if !reflect.DeepEqual(g.defs["Thing"], existing) {
		t.Fatalf("defs[Thing] = %#v after collision, want original %#v", g.defs["Thing"], existing)
	}
}

func TestTypeScriptGeneratorRequiresAtLeastOneProperty(t *testing.T) {
	g := &typeScriptGenerator{defs: map[string]typeScriptSchema{}}
	source := g.objectType(typeScriptSchema{
		"type":                 "object",
		"additionalProperties": false,
		"minProperties":        float64(1),
		"properties": map[string]any{
			"entity_id": map[string]any{"type": "string"},
			"task_id":   map[string]any{"type": "string"},
		},
	}, "ObjectReference", 0)

	for _, want := range []string{
		"RequireAtLeastOne<",
		`"entity_id"?: string;`,
		`"task_id"?: string;`,
		`"entity_id" | "task_id"`,
	} {
		if !strings.Contains(source, want) {
			t.Fatalf("generated TypeScript %q missing %q", source, want)
		}
	}
}

func TestTypeScriptSourceGeneratesTaskCreateValidatorFromSchema(t *testing.T) {
	source, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"TaskCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
				"properties": {
					"extra": {
						"type": "object",
						"additionalProperties": { "$ref": "#/$defs/%23JSONValue" }
					},
					"priority": { "$ref": "#/$defs/%23NonEmptyString" },
					"task_id": { "$ref": "#/$defs/%23NonEmptyString" }
				},
				"required": ["task_id"],
				"$defs": {
					"#JSONValue": {
						"oneOf": [
							{ "type": "null" },
							{ "type": "boolean" },
							{ "type": "string" },
							{ "type": "number" },
							{ "type": "array", "items": { "$ref": "#/$defs/%23JSONValue" } },
							{ "type": "object", "additionalProperties": { "$ref": "#/$defs/%23JSONValue" } }
						]
					},
					"#NonEmptyString": { "type": "string", "pattern": "\\S" }
				}
			}`),
	})
	if err != nil {
		t.Fatalf("typeScriptSource: %v", err)
	}
	text := string(source)
	for _, want := range []string{
		"export type TaskCreateRequest",
		`"extra"?: { [key: string]: JSONValue };`,
		`"priority"?: NonEmptyString;`,
		`"task_id": NonEmptyString;`,
		"export function isTaskCreateRequest(value: unknown): value is TaskCreateRequest",
		"atlasProtocolIsJSONValue",
		"return atlasProtocolIsJSONValueInternal(value, new WeakSet<object>())",
		"function atlasProtocolIsJSONValueInternal(value: unknown, seen: WeakSet<object>): value is JSONValue",
		"if (seen.has(value))",
		"seen.delete(value)",
		`Object.values(value.extra).every((item) => atlasProtocolIsJSONValue(item))`,
		"const prototype = Object.getPrototypeOf(value);",
		"return prototype === Object.prototype || prototype === null;",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, text)
		}
	}
}

func TestTypeScriptSourceRejectsUnsupportedTaskCreateValidatorSchema(t *testing.T) {
	_, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"TaskCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"task_id": { "$ref": "#/$defs/%23NonEmptyString" },
				"unsupported": { "$ref": "#/$defs/%23Unsupported" }
			},
			"required": ["task_id"],
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" },
				"#Unsupported": { "type": "array" }
			}
		}`),
	})
	if err == nil {
		t.Fatal("typeScriptSource accepted unsupported TaskCreateRequest validator schema")
	}
	if !strings.Contains(err.Error(), "unsupported runtime validator ref") {
		t.Fatalf("typeScriptSource error = %q, want unsupported runtime validator ref", err.Error())
	}
}

func TestTypeScriptSourceRejectsMalformedRevision(t *testing.T) {
	_, err := typeScriptSource("revision:unsafe", map[string][]byte{
		"thing": []byte(`{"type":"object"}`),
	})
	if err == nil {
		t.Fatal("typeScriptSource accepted malformed protocol revision")
	}
}

func TestValidateProtocolRevisionRequiresSha256Digest(t *testing.T) {
	valid := "sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF"
	if got, err := validateProtocolRevision(valid); err != nil || got != valid {
		t.Fatalf("validateProtocolRevision(%q) = %q, %v; want original without error", valid, got, err)
	}
	for _, invalid := range []string{"", "sha1:0123", "sha256:not-hex", "sha256:0123", "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg"} {
		if _, err := validateProtocolRevision(invalid); err == nil {
			t.Fatalf("validateProtocolRevision accepted %q", invalid)
		}
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
