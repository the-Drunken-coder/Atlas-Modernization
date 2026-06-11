package schema

import "embed"

// Files contains the CUE protocol schemas used by the runtime validator.
//
//go:embed *.cue components shared
var Files embed.FS
