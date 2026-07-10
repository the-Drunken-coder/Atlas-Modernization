package artifacts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateGoContractsMatchesCanonicalSchema(t *testing.T) {
	root, bundle := canonicalGoContractFixture(t)
	if err := validateGoContracts(root, bundle); err != nil {
		t.Fatalf("validateGoContracts canonical schema: %v", err)
	}
}

func TestValidateGoContractsRejectsSchemaDrift(t *testing.T) {
	root, canonical := canonicalGoContractFixture(t)
	tests := []struct {
		name   string
		mutate func(t *testing.T, bundle schemaBundle)
		want   string
	}{
		{
			name: "field set",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaProperties(t, bundle, "EntityResource")["call_sign"] = map[string]any{"type": "string"}
			},
			want: "EntityResource fields drifted",
		},
		{
			name: "requiredness",
			mutate: func(t *testing.T, bundle schemaBundle) {
				definition := schemaDefinition(t, bundle, "EntityResource")
				definition["required"] = append(definition["required"].([]any), "extra")
			},
			want: "field extra optionality drifted",
		},
		{
			name: "nullability",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaProperties(t, bundle, "EntityResource")["alias"] = map[string]any{"$ref": "#/$defs/NonEmptyString"}
			},
			want: "field alias type drifted",
		},
		{
			name: "field type",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaProperties(t, bundle, "ObjectResource")["size_bytes"] = map[string]any{"type": "string"}
			},
			want: "field size_bytes type drifted",
		},
		{
			name: "direct enum",
			mutate: func(t *testing.T, bundle schemaBundle) {
				definition := schemaDefinition(t, bundle, "ErrorCode")
				definition["enum"] = append(definition["enum"].([]any), "NEW_ERROR")
			},
			want: "Go enum ErrorCode drifted",
		},
		{
			name: "enum sibling constraint",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaDefinition(t, bundle, "ErrorCode")["not"] = map[string]any{"const": "BODY_TOO_LARGE"}
			},
			want: "unsupported schema keywords [not]",
		},
		{
			name: "union discriminator",
			mutate: func(t *testing.T, bundle schemaBundle) {
				constant := schemaDefinition(t, bundle, "SubscribeAllMessage")["const"].(map[string]any)
				constant["filter"] = "everything"
			},
			want: "Go enum FeedFilter drifted",
		},
		{
			name: "synthetic discriminator",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaProperties(t, bundle, "EntityDeleteEvent")["event"] = map[string]any{"type": "string"}
			},
			want: "finite string domain",
		},
		{
			name: "type override source",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaProperties(t, bundle, "ObjectReference")["entity_id"] = map[string]any{
					"anyOf": []any{
						map[string]any{"$ref": "#/$defs/NonEmptyString"},
						map[string]any{"type": "integer"},
					},
				}
			},
			want: "override requires schema type string",
		},
		{
			name: "unconstrained enum field",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaProperties(t, bundle, "EntityCreateEvent")["resource_type"] = map[string]any{"type": "string"}
			},
			want: "not a finite string domain for Go enum ResourceType",
		},
		{
			name: "partially unconstrained enum field",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaProperties(t, bundle, "EntityCreateEvent")["resource_type"] = map[string]any{
					"anyOf": []any{
						map[string]any{"const": "entity"},
						map[string]any{"type": "string"},
					},
				}
			},
			want: "not a finite string domain for Go enum ResourceType",
		},
		{
			name: "overlapping oneOf enum field",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaProperties(t, bundle, "SubscribeTypeMessage")["filter"] = map[string]any{
					"oneOf": []any{
						map[string]any{"const": "type"},
						map[string]any{"const": "type"},
					},
				}
			},
			want: "oneOf finite string domains are not supported",
		},
		{
			name: "open object",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaDefinition(t, bundle, "ObjectReference")["additionalProperties"] = true
			},
			want: "allows additional properties",
		},
		{
			name: "pattern properties",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaDefinition(t, bundle, "ObjectReference")["patternProperties"] = map[string]any{
					"^x-": map[string]any{"type": "string"},
				}
			},
			want: "pattern properties cannot be represented",
		},
		{
			name: "object sibling constraint",
			mutate: func(t *testing.T, bundle schemaBundle) {
				schemaDefinition(t, bundle, "EntityResource")["not"] = map[string]any{
					"required": []any{"extra"},
				}
			},
			want: "Go struct object shape uses unsupported schema keywords [not]",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bundle := schemaBundle(cloneJSONValue(map[string]any(canonical)).(map[string]any))
			test.mutate(t, bundle)
			err := validateGoContracts(root, bundle)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("validateGoContracts error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestValidateGoContractsRejectsAuthoredSourceDrift(t *testing.T) {
	root, bundle := canonicalGoContractFixture(t)
	source, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(authoredGoTypesPath)))
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name        string
		old         string
		replacement string
		want        string
	}{
		{
			name:        "field type",
			old:         "CreatedAt string `json:\"created_at\"`",
			replacement: "CreatedAt int64 `json:\"created_at\"`",
			want:        "field created_at type drifted",
		},
		{
			name:        "json tag",
			old:         "CreatedAt string `json:\"created_at\"`",
			replacement: "CreatedAt string `json:\"created\"`",
			want:        "MetadataBlock fields drifted",
		},
		{
			name:        "json tag option",
			old:         "Message   string               `json:\"message\"`",
			replacement: "Message   string               `json:\"message,string\"`",
			want:        "unsupported json option",
		},
		{
			name:        "enum constant name",
			old:         "ErrorCodeInvalidJSON",
			replacement: "ErrorCodeBadJSON",
			want:        "Go enum ErrorCode drifted",
		},
		{
			name:        "type alias identity",
			old:         "type ResourceType string",
			replacement: "type ResourceType = string",
			want:        "only JSONValue may be an alias",
		},
		{
			name: "embedded field",
			old: `type ObjectReference struct {
	EntityID *string ` + "`json:\"entity_id,omitempty\"`" + `
	TaskID   *string ` + "`json:\"task_id,omitempty\"`" + `
}`,
			replacement: `type ObjectReference struct {
	MetadataBlock
	EntityID *string ` + "`json:\"entity_id,omitempty\"`" + `
	TaskID   *string ` + "`json:\"task_id,omitempty\"`" + `
}`,
			want: "embedded fields are not supported",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changed := strings.Replace(string(source), test.old, test.replacement, 1)
			if changed == string(source) {
				t.Fatalf("fixture source did not contain %q", test.old)
			}
			temporaryRoot := t.TempDir()
			path := filepath.Join(temporaryRoot, filepath.FromSlash(authoredGoTypesPath))
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(changed), 0o644); err != nil {
				t.Fatal(err)
			}
			err := validateGoContracts(temporaryRoot, bundle)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("validateGoContracts error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestValidateGoContractsRejectsAdditionalPublicTypeFile(t *testing.T) {
	root, bundle := canonicalGoContractFixture(t)
	source, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(authoredGoTypesPath)))
	if err != nil {
		t.Fatal(err)
	}
	temporaryRoot := t.TempDir()
	directory := filepath.Join(temporaryRoot, filepath.Dir(filepath.FromSlash(authoredGoTypesPath)))
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "types.go"), source, 0o644); err != nil {
		t.Fatal(err)
	}
	unchecked := []byte("package atlasprotocol\n\ntype UncheckedResource struct {\n\tID string `json:\"id\"`\n}\n")
	if err := os.WriteFile(filepath.Join(directory, "unchecked.go"), unchecked, 0o644); err != nil {
		t.Fatal(err)
	}
	err = validateGoContracts(temporaryRoot, bundle)
	if err == nil || !strings.Contains(err.Error(), "authored Go type surface drifted") {
		t.Fatalf("additional public type error = %v", err)
	}
}

func TestBuildArtifactsLeavesGoTypesAuthored(t *testing.T) {
	root, _ := canonicalGoContractFixture(t)
	artifacts, err := BuildArtifacts(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, artifact := range artifacts {
		if artifact.Path == authoredGoTypesPath {
			t.Fatalf("BuildArtifacts still generates %s", authoredGoTypesPath)
		}
	}
}

func TestGoValidatorFunctionsReferenceSchemaDefinitions(t *testing.T) {
	_, bundle := canonicalGoContractFixture(t)
	defs, err := schemaDefs(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateGoValidatorFunctions(defs); err != nil {
		t.Fatalf("canonical Go validators: %v", err)
	}
	missing := cloneJSONValue(defs).(map[string]any)
	delete(missing, "EntityBlob")
	err = validateGoValidatorFunctions(missing)
	if err == nil || !strings.Contains(err.Error(), "ValidateEntityBlob") {
		t.Fatalf("missing schema definition error = %v", err)
	}
}

func canonicalGoContractFixture(t *testing.T) (string, schemaBundle) {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := LoadSchemaBundle(root)
	if err != nil {
		t.Fatal(err)
	}
	return root, bundle
}

func schemaDefinition(t *testing.T, bundle schemaBundle, name string) map[string]any {
	t.Helper()
	defs, err := schemaDefs(bundle)
	if err != nil {
		t.Fatal(err)
	}
	definition, ok := defs[name].(map[string]any)
	if !ok {
		t.Fatalf("schema definition %s not found", name)
	}
	return definition
}

func schemaProperties(t *testing.T, bundle schemaBundle, name string) map[string]any {
	t.Helper()
	properties, ok := schemaDefinition(t, bundle, name)["properties"].(map[string]any)
	if !ok {
		t.Fatalf("schema definition %s has no properties", name)
	}
	return properties
}
