package actions

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseIfMatchExpectedVersion parses the API's strong resource-version ETag
// format into the version actions should compare against.
func ParseIfMatchExpectedVersion(ifMatch string) (*int64, error) {
	ifMatch = strings.TrimSpace(ifMatch)
	if ifMatch == "" || ifMatch == "*" {
		return nil, nil
	}

	var expected *int64
	for _, raw := range strings.Split(ifMatch, ",") {
		token := strings.TrimSpace(raw)
		if token == "" {
			continue
		}
		if token == "*" {
			return nil, nil
		}
		if isWeakIfMatchToken(token) {
			return nil, fmt.Errorf("weak If-Match token %q is not supported", token)
		}
		versionToken := normalizeIfMatchToken(token)
		if !strings.HasPrefix(versionToken, "v") {
			return nil, fmt.Errorf("If-Match token %q is not a resource version", token)
		}
		version, err := strconv.ParseInt(strings.TrimPrefix(versionToken, "v"), 10, 64)
		if err != nil || version < 1 {
			return nil, fmt.Errorf("If-Match token %q is not a valid resource version", token)
		}
		if expected != nil && *expected != version {
			return nil, fmt.Errorf("If-Match must contain one expected resource version")
		}
		expected = &version
	}
	if expected == nil {
		return nil, fmt.Errorf("If-Match must contain a strong resource-version token")
	}
	return expected, nil
}

// ExpectedVersionMatches returns true when a resource version satisfies the
// optional If-Match version parsed by the handler layer.
func ExpectedVersionMatches(expected *int64, actual int64) bool {
	return expected == nil || *expected == actual
}

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
