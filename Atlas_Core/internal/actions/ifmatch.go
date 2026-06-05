package actions

import (
	"strings"
	"time"
)

const objectIfMatchTimeLayout = "2006-01-02T15:04:05.000000Z07:00"

func objectIfMatchETag(updatedAt time.Time) string {
	return `"` + updatedAt.UTC().Format(objectIfMatchTimeLayout) + `"`
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

// ObjectIfMatchOK returns true when If-Match allows the request for the given updated_at.
func ObjectIfMatchOK(ifMatch string, updatedAt time.Time) bool {
	ifMatch = strings.TrimSpace(ifMatch)
	if ifMatch == "" || ifMatch == "*" {
		return true
	}
	want := objectIfMatchETag(updatedAt)
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
