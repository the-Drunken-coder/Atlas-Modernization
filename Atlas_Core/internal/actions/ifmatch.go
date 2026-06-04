package actions

import (
	"strings"
	"time"
)

const objectIfMatchTimeLayout = "2006-01-02T15:04:05.000000Z07:00"

func objectIfMatchETag(updatedAt time.Time) string {
	return `"` + updatedAt.UTC().Format(objectIfMatchTimeLayout) + `"`
}

// normalizeIfMatchToken trims space, strips an optional weak-validator "W/" prefix,
// and trims a single layer of surrounding double-quotes so comparisons line up
// with object response ETags (quoted RFC3339-style service metadata timestamps).
func normalizeIfMatchToken(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(strings.ToUpper(s), "W/") {
		s = strings.TrimSpace(s[2:])
	}
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		s = s[1 : len(s)-1]
	}
	return s
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
