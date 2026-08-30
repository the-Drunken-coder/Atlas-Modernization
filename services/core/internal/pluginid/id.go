// Package pluginid owns the shared Plugin identifier and Tool Asset ID rules.
package pluginid

import (
	"crypto/sha256"
	"encoding/base64"
	"regexp"
)

const MaxLength = 64

var pattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`)

func Valid(value string) bool {
	return len(value) <= MaxLength && pattern.MatchString(value)
}

func DeriveToolAssetID(pluginID string) string {
	digest := sha256.Sum256([]byte(pluginID))
	return "plugin_" + base64.RawURLEncoding.EncodeToString(digest[:])
}
