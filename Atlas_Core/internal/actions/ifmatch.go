package actions

import (
	"fmt"
	"strings"
)

func objectIfMatchETag(version int64) string {
	return fmt.Sprintf(`"v%d"`, version)
}

// normalizeIfMatchToken trims space and a single layer of surrounding double-quotes
// so strong If-Match tokens line up with object response ETags.
func normalizeIfMatchToken(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		s = s[1 : len(s)-1]
	}
	return s
}

func isWeakIfMatchToken(s string) bool {
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(s)), "W/")
}

// ObjectIfMatchOK returns true when If-Match allows the request for the given object version.
func ObjectIfMatchOK(ifMatch string, version int64) bool {
	ifMatch = strings.TrimSpace(ifMatch)
	if ifMatch == "" || ifMatch == "*" {
		return true
	}
	want := objectIfMatchETag(version)
	wantNorm := normalizeIfMatchToken(want)
	for _, part := range strings.Split(ifMatch, ",") {
		p := strings.TrimSpace(part)
		if p == "*" {
			return true
		}
		if isWeakIfMatchToken(p) {
			continue
		}
		if normalizeIfMatchToken(p) == wantNorm {
			return true
		}
		// Also accept exact match with the serialized tag (quoted).
		if p == want {
			return true
		}
	}
	return false
}
