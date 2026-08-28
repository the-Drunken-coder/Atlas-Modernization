package schema

import "embed"

// Files contains the JSON Schema protocol source used by the runtime validator.
//
//go:embed jsonschema/*.json
var Files embed.FS
