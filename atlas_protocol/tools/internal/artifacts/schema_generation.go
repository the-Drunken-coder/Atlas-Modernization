package artifacts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	schemaBundlePath     = "schema/jsonschema/atlas.schema.json"
	schemaBundleLocation = "atlas.schema.json"
)

type schemaBundle map[string]any

var exampleSets = []struct {
	dir        string
	definition string
}{
	{dir: "entities", definition: "EntityBlob"},
	{dir: "tasks", definition: "TaskBlob"},
	{dir: "objects", definition: "ObjectBlob"},
	{dir: "errors", definition: "ErrorResponse"},
	{dir: "feed/events", definition: "FeedEvent"},
	{dir: "feed/messages", definition: "FeedClientMessage"},
	{dir: "feed/server", definition: "FeedHandshakeMessage"},
}

func ValidateExamples(root string) error {
	bundle, err := LoadSchemaBundle(root)
	if err != nil {
		return err
	}
	compiler, err := schemaCompiler(bundle)
	if err != nil {
		return err
	}

	for _, set := range exampleSets {
		if err := validateExampleSet(root, compiler, set.dir, set.definition); err != nil {
			return err
		}
	}
	return nil
}

func validateExampleSet(root string, compiler *jsonschema.Compiler, dir, definition string) error {
	schema, err := compiler.Compile(schemaDefinitionLocation(definition))
	if err != nil {
		return fmt.Errorf("compile %s: %w", definition, err)
	}
	examples, err := filepath.Glob(filepath.Join(root, "examples", dir, "*.json"))
	if err != nil {
		return err
	}
	if len(examples) == 0 {
		return fmt.Errorf("no %s examples found", dir)
	}
	sort.Strings(examples)

	for _, example := range examples {
		data, err := os.ReadFile(example)
		if err != nil {
			return err
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			return fmt.Errorf("%s: decode JSON: %w", displayPath(root, example), err)
		}
		if err := schema.Validate(value); err != nil {
			return fmt.Errorf("%s: validate %s: %w", displayPath(root, example), definition, err)
		}
	}
	return nil
}

func LoadSchemaBundle(root string) (schemaBundle, error) {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(schemaBundlePath)))
	if err != nil {
		return nil, err
	}
	var bundle schemaBundle
	if err := json.Unmarshal(data, &bundle); err != nil {
		return nil, fmt.Errorf("parse %s: %w", schemaBundlePath, err)
	}
	if _, err := schemaDefs(bundle); err != nil {
		return nil, err
	}
	return bundle, nil
}

func schemaCompiler(bundle schemaBundle) (*jsonschema.Compiler, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	if err := compiler.AddResource(schemaBundleLocation, map[string]any(bundle)); err != nil {
		return nil, fmt.Errorf("add schema bundle: %w", err)
	}
	if _, err := compiler.Compile(schemaBundleLocation); err != nil {
		return nil, fmt.Errorf("compile schema bundle: %w", err)
	}
	return compiler, nil
}

func schemaDocumentForDefinition(bundle schemaBundle, definition, revision string) ([]byte, error) {
	revision, err := validateProtocolRevision(revision)
	if err != nil {
		return nil, err
	}
	defs, err := schemaDefs(bundle)
	if err != nil {
		return nil, err
	}
	raw, exists := defs[definition]
	if !exists {
		return nil, fmt.Errorf("schema definition %s not found", definition)
	}
	root, ok := cloneJSONValue(raw).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("schema definition %s is not an object", definition)
	}
	root["$schema"] = "https://json-schema.org/draft/2020-12/schema"
	root["$defs"] = cloneJSONValue(defs)
	root["x-atlas-protocol-revision"] = revision

	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func schemaDefs(bundle schemaBundle) (map[string]any, error) {
	defs, ok := bundle["$defs"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s has no $defs object", schemaBundlePath)
	}
	return defs, nil
}

func schemaDefinitionLocation(definition string) string {
	return schemaBundleLocation + "#/$defs/" + definition
}

func displayPath(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(rel)
}

func cloneJSONValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			out[key] = cloneJSONValue(child)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, child := range typed {
			out[i] = cloneJSONValue(child)
		}
		return out
	default:
		return typed
	}
}
