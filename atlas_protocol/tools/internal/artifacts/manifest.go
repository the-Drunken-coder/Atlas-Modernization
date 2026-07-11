package artifacts

import (
	"sort"
)

func BuildArtifacts(root string) ([]Artifact, error) {
	bundle, err := LoadSchemaBundle(root)
	if err != nil {
		return nil, err
	}
	if err := validateGoContracts(root, bundle); err != nil {
		return nil, err
	}
	revision, err := protocolRevision(root)
	if err != nil {
		return nil, err
	}

	defs, err := schemaDefs(bundle)
	if err != nil {
		return nil, err
	}
	if err := validateGoValidatorFunctions(defs); err != nil {
		return nil, err
	}
	definitions := make([]string, 0, len(defs))
	for definition := range defs {
		definitions = append(definitions, definition)
	}
	sort.Strings(definitions)

	typescriptSchemas := make(map[string][]byte, len(definitions))
	for _, definition := range definitions {
		schema, err := schemaDocumentForDefinition(bundle, definition, revision)
		if err != nil {
			return nil, err
		}
		typescriptSchemas[definition] = schema
	}
	typescriptSource, err := typeScriptSource(revision, typescriptSchemas)
	if err != nil {
		return nil, err
	}
	goRevision, err := goRevisionSource(revision)
	if err != nil {
		return nil, err
	}
	goValidators, err := goValidatorsSource()
	if err != nil {
		return nil, err
	}

	artifacts := []Artifact{
		{Path: "generated/revision.txt", Content: revisionTextSource(revision)},
		{Path: "generated/go/atlasprotocol/revision.go", Content: goRevision},
		{Path: "generated/go/atlasprotocol/validators.go", Content: goValidators},
		{Path: "generated/typescript/index.ts", Content: typescriptSource},
	}
	sort.Slice(artifacts, func(i, j int) bool {
		return artifacts[i].Path < artifacts[j].Path
	})
	return artifacts, nil
}
