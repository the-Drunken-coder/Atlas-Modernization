package schema

import "embed"

// Files contains the CUE protocol schemas used by the runtime validator.
//
//go:embed *.cue components/*.cue shared/*.cue
var Files embed.FS
