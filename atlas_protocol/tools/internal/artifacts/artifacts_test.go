package artifacts

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	protocolvalidator "github.com/the-drunken-coder/atlas/atlas_protocol/validator"
)

func TestValidateExampleSetRunsSemanticValidators(t *testing.T) {
	root := t.TempDir()
	writeTestSchemaBundle(t, root)
	exampleDir := filepath.Join(root, "examples", "entities")
	if err := os.MkdirAll(exampleDir, 0o755); err != nil {
		t.Fatal(err)
	}
	invalidPolygon := []byte(`{
  "components": {
    "geometry": {
      "type": "Polygon",
      "coordinates": [
        [[0, 0], [1, 0], [1, 1], [0, 1]]
      ]
    }
  }
}`)
	if err := os.WriteFile(filepath.Join(exampleDir, "bad-polygon.json"), invalidPolygon, 0o644); err != nil {
		t.Fatal(err)
	}
	bundle, err := LoadSchemaBundle(root)
	if err != nil {
		t.Fatal(err)
	}
	compiler, err := schemaCompiler(bundle)
	if err != nil {
		t.Fatal(err)
	}

	err = validateExampleSet(root, compiler, exampleSet{
		pattern:            "entities",
		definition:         "EntityBlob",
		semanticValidation: protocolvalidator.ValidateEntityBlob,
	})
	if err == nil {
		t.Fatal("validateExampleSet accepted semantically invalid polygon example")
	}
	if !strings.Contains(err.Error(), "polygon ring must be closed") {
		t.Fatalf("validateExampleSet error = %q, want polygon closure error", err)
	}
}

func writeTestSchemaBundle(t *testing.T, root string) {
	t.Helper()
	source := filepath.Clean(filepath.Join("..", "..", "..", schemaBundlePath))
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, filepath.FromSlash(schemaBundlePath))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		t.Fatal(err)
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
		`Object.entries(value["extra"]).every(([key, item]) => atlasProtocolKnownKeys([], key) || atlasProtocolIsJSONValue(item))`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, text)
		}
	}
}

func TestTypeScriptSourceGeneratesMultipleRequestValidators(t *testing.T) {
	source, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"EntityCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"entity_id": { "$ref": "#/$defs/%23NonEmptyString" },
				"entity_type": { "$ref": "#/$defs/%23NonEmptyString" }
			},
			"required": ["entity_id", "entity_type"],
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" }
			}
		}`),
		"TaskUpdateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"minProperties": 1,
			"properties": {
				"status": { "$ref": "#/$defs/%23NonEmptyString" }
			},
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" }
			}
		}`),
	})
	if err != nil {
		t.Fatalf("typeScriptSource: %v", err)
	}
	text := string(source)
	for _, want := range []string{
		"export function isEntityCreateRequest(value: unknown): value is EntityCreateRequest",
		"export function isTaskUpdateRequest(value: unknown): value is TaskUpdateRequest",
		"Object.keys(value).length >= 1",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, text)
		}
	}
}

func TestRequestValidatorSourceDiscoversRequestDefinitions(t *testing.T) {
	generator := &typeScriptGenerator{defs: map[string]typeScriptSchema{
		"WidgetRequest": {
			"type":                 "object",
			"additionalProperties": false,
			"properties": map[string]any{
				"widget_id": map[string]any{"type": "string"},
			},
			"required": []any{"widget_id"},
		},
	}}
	source, err := requestValidatorSource(generator)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(source, "export function isWidgetRequest(value: unknown): value is WidgetRequest") {
		t.Fatalf("requestValidatorSource did not discover WidgetRequest:\n%s", source)
	}
}

func TestTypeScriptSourceGeneratesArrayBoundsAndStrictRFC3339Validators(t *testing.T) {
	source, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"EntityCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"entity_id": { "$ref": "#/$defs/%23NonEmptyString" },
				"entity_type": { "$ref": "#/$defs/%23NonEmptyString" },
				"position": {
					"type": "array",
					"minItems": 2,
					"maxItems": 3,
					"prefixItems": [
						{ "type": "number", "minimum": -180, "maximum": 180 },
						{ "type": "number", "minimum": -90, "maximum": 90 }
					],
					"items": { "type": "number" }
				},
				"published_at": { "type": "string", "format": "date-time" }
			},
			"required": ["entity_id", "entity_type"],
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" }
			}
		}`),
	})
	if err != nil {
		t.Fatalf("typeScriptSource: %v", err)
	}
	text := string(source)
	for _, want := range []string{
		`"position"?: [number, number, ...number[]];`,
		`value["position"].length >= 2`,
		`value["position"].length <= 3`,
		`value["position"][0] >= -180`,
		`value["position"][1] >= -90`,
		`value["position"].slice(2).every((item) => typeof item === "number" && Number.isFinite(item))`,
		`const atlasProtocolPatternCache = new Map<string, RegExp>();`,
		`const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);`,
		`day > atlasProtocolDaysInMonth(year, month)`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, text)
		}
	}
}

func TestTypeScriptSourceGeneratesExactOneOfValidators(t *testing.T) {
	source, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"TaskCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"choice": {
					"oneOf": [
						{ "type": "string" },
						{ "type": "string", "minLength": 2 }
					]
				},
				"task_id": { "$ref": "#/$defs/%23NonEmptyString" }
			},
			"required": ["choice", "task_id"],
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" }
			}
		}`),
	})
	if err != nil {
		t.Fatalf("typeScriptSource: %v", err)
	}
	text := string(source)
	for _, want := range []string{
		`[typeof value["choice"] === "string", typeof value["choice"] === "string" && value["choice"].length >= 2].filter((valid) => valid).length === 1`,
		`function atlasProtocolStringMatches(value: string, pattern: string): boolean`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, text)
		}
	}
}

func TestTypeScriptSourceGeneratesStringPatternAndLengthValidators(t *testing.T) {
	source, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"TaskCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"code": {
					"type": "string",
					"pattern": "^[A-Z]+$",
					"minLength": 2,
					"maxLength": 4
				},
				"task_id": { "$ref": "#/$defs/%23NonEmptyString" }
			},
			"required": ["code", "task_id"],
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" }
			}
		}`),
	})
	if err != nil {
		t.Fatalf("typeScriptSource: %v", err)
	}
	text := string(source)
	for _, want := range []string{
		`typeof value["code"] === "string"`,
		`atlasProtocolStringMatches(value["code"], "^[A-Z]+$")`,
		`value["code"].length >= 2`,
		`value["code"].length <= 4`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, `atlasProtocolIsNonEmptyString(value["code"])`) {
		t.Fatalf("generated TypeScript collapsed code constraints to non-empty:\n%s", text)
	}
}

func TestTypeScriptSourceGeneratesDependentRequiredAndPatternOnlyValidators(t *testing.T) {
	source, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"EntityCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"entity_id": { "$ref": "#/$defs/%23NonEmptyString" },
				"entity_type": { "$ref": "#/$defs/%23NonEmptyString" },
				"reference": {
					"type": "object",
					"additionalProperties": false,
					"properties": {
						"url": { "type": "string" },
						"label": { "type": "string" }
					},
					"dependentRequired": {
						"url": ["label"]
					}
				},
				"labels": {
					"patternProperties": {
						"^custom_": { "type": "string" }
					},
					"additionalProperties": false
				}
			},
			"required": ["entity_id", "entity_type"],
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" }
			}
		}`),
	})
	if err != nil {
		t.Fatalf("typeScriptSource: %v", err)
	}
	text := string(source)
	for _, want := range []string{
		`"labels"?: {`,
		"[key: `custom_${string}`]: string;",
		`(!atlasProtocolHasOwn(value["reference"], "url") || (atlasProtocolHasOwn(value["reference"], "label")))`,
		`Object.entries(value["labels"]).every(([key, item]) => atlasProtocolKnownKeys([], key) || ((atlasProtocolKeyMatches(key, "^custom_")) ? ((!atlasProtocolKeyMatches(key, "^custom_") || (typeof item === "string"))) : false))`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("generated TypeScript missing %q:\n%s", want, text)
		}
	}
}

func TestTypeScriptSourceKeepsPatternPropertiesFromEscapingThroughFallback(t *testing.T) {
	source, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"EntityCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"entity_id": { "$ref": "#/$defs/%23NonEmptyString" },
				"entity_type": { "$ref": "#/$defs/%23NonEmptyString" },
				"labels": {
					"patternProperties": {
						"^custom_": { "type": "string" }
					}
				}
			},
			"required": ["entity_id", "entity_type"],
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" }
			}
		}`),
	})
	if err != nil {
		t.Fatalf("typeScriptSource: %v", err)
	}
	text := string(source)
	want := `Object.entries(value["labels"]).every(([key, item]) => atlasProtocolKnownKeys([], key) || ((atlasProtocolKeyMatches(key, "^custom_")) ? ((!atlasProtocolKeyMatches(key, "^custom_") || (typeof item === "string"))) : true))`
	if !strings.Contains(text, want) {
		t.Fatalf("generated TypeScript missing %q:\n%s", want, text)
	}
}

func TestTypeScriptSourceRejectsMissingTaskCreateValidatorRef(t *testing.T) {
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
				"#NonEmptyString": { "type": "string", "pattern": "\\S" }
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
				"#Unsupported": { "not": { "type": "string" } }
			}
		}`),
	})
	if err == nil {
		t.Fatal("typeScriptSource accepted unsupported TaskCreateRequest validator schema")
	}
	if !strings.Contains(err.Error(), "unsupported runtime validator schema") {
		t.Fatalf("typeScriptSource error = %q, want unsupported runtime validator schema", err.Error())
	}
}

func TestTypeScriptSourceRejectsCyclicTaskCreateValidatorRefs(t *testing.T) {
	_, err := typeScriptSource("sha256:0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF", map[string][]byte{
		"TaskCreateRequest": []byte(`{
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"task_id": { "$ref": "#/$defs/%23NonEmptyString" },
				"cyclic": { "$ref": "#/$defs/A" }
			},
			"required": ["task_id"],
			"$defs": {
				"#NonEmptyString": { "type": "string", "pattern": "\\S" },
				"A": { "$ref": "#/$defs/B" },
				"B": { "$ref": "#/$defs/A" }
			}
		}`),
	})
	if err == nil {
		t.Fatal("typeScriptSource accepted cyclic TaskCreateRequest validator refs")
	}
	if !strings.Contains(err.Error(), "cyclic runtime validator ref") {
		t.Fatalf("typeScriptSource error = %q, want cyclic runtime validator ref", err.Error())
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
