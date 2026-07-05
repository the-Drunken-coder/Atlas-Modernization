package artifacts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	protocolvalidator "github.com/the-drunken-coder/atlas/atlas_protocol/validator"
)

const (
	schemaBundlePath     = "schema/jsonschema/atlas.schema.json"
	schemaBundleLocation = "atlas.schema.json"
)

type schemaBundle map[string]any

var exampleSets = []struct {
	pattern    string
	definition string
}{
	{pattern: "entities/*.json", definition: "EntityBlob"},
	{pattern: "tasks/*.json", definition: "TaskBlob"},
	{pattern: "objects/*.json", definition: "ObjectBlob"},
	{pattern: "errors/*.json", definition: "ErrorResponse"},
	{pattern: "feed/events/*.json", definition: "FeedEvent"},
	{pattern: "feed/messages/*.json", definition: "FeedClientMessage"},
	{pattern: "feed/server/*.json", definition: "FeedHandshakeMessage"},
	{pattern: "requests/entity-create.json", definition: "EntityCreateRequest"},
	{pattern: "requests/entity-update.json", definition: "EntityUpdateRequest"},
	{pattern: "requests/task-create.json", definition: "TaskCreateRequest"},
	{pattern: "requests/task-update.json", definition: "TaskUpdateRequest"},
	{pattern: "requests/object-create.json", definition: "ObjectCreateRequest"},
	{pattern: "requests/object-update.json", definition: "ObjectUpdateRequest"},
}

var exampleValidators = map[string]func(any) []string{
	"EntityBlob":           protocolvalidator.ValidateEntityBlob,
	"TaskBlob":             protocolvalidator.ValidateTaskBlob,
	"ObjectBlob":           protocolvalidator.ValidateObjectBlob,
	"ErrorResponse":        protocolvalidator.ValidateErrorResponse,
	"FeedEvent":            protocolvalidator.ValidateFeedEvent,
	"FeedClientMessage":    protocolvalidator.ValidateFeedClientMessage,
	"FeedHandshakeMessage": protocolvalidator.ValidateFeedHandshakeMessage,
	"EntityCreateRequest":  protocolvalidator.ValidateEntityCreateRequest,
	"EntityUpdateRequest":  protocolvalidator.ValidateEntityUpdateRequest,
	"TaskCreateRequest":    protocolvalidator.ValidateTaskCreateRequest,
	"TaskUpdateRequest":    protocolvalidator.ValidateTaskUpdateRequest,
	"ObjectCreateRequest":  protocolvalidator.ValidateObjectCreateRequest,
	"ObjectUpdateRequest":  protocolvalidator.ValidateObjectUpdateRequest,
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
		if err := validateExampleSet(root, compiler, set.pattern, set.definition); err != nil {
			return err
		}
	}
	return nil
}

func validateExampleSet(root string, compiler *jsonschema.Compiler, pattern, definition string) error {
	schema, err := compiler.Compile(schemaDefinitionLocation(definition))
	if err != nil {
		return fmt.Errorf("compile %s: %w", definition, err)
	}
	if !strings.ContainsAny(pattern, "*?[") && filepath.Ext(pattern) == "" {
		pattern = filepath.Join(pattern, "*.json")
	}
	examples, err := filepath.Glob(filepath.Join(root, "examples", pattern))
	if err != nil {
		return err
	}
	if len(examples) == 0 {
		return fmt.Errorf("no %s examples found", pattern)
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
		if validate, ok := exampleValidators[definition]; ok {
			if errors := validate(value); len(errors) > 0 {
				return fmt.Errorf("%s: validate %s semantics: %s", displayPath(root, example), definition, strings.Join(errors, "; "))
			}
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
