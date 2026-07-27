package schema

import "embed"

// Files contains the JSON Schema protocol source used by the runtime validator.
//
//go:embed jsonschema/*.json
var Files embed.FS

// BundleLocation is the JSON Schema resource location ($id) of the protocol
// schema bundle.
const BundleLocation = "atlas.schema.json"

// DefinitionLocation returns the JSON Schema resource location of a definition
// within the protocol schema bundle.
func DefinitionLocation(definition string) string {
	return BundleLocation + "#/$defs/" + definition
}
