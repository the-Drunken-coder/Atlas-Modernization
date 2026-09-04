package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/the-drunken-coder/atlas/services/core/internal/actions"
)

func (h *Handler) parseIfMatchExpectedVersion(w http.ResponseWriter, r *http.Request, resourceType string) (*int64, bool) {
	expectedVersion, err := parseIfMatchExpectedVersionValues(r.Header.Values("If-Match"))
	if err != nil {
		h.handleActionError(w, r, actions.NewPreconditionFailedError(resourceType))
		return nil, false
	}
	return expectedVersion, true
}

func (h *Handler) parseResourceInstanceToken(w http.ResponseWriter, r *http.Request) (*string, bool) {
	values := r.Header.Values(actions.ResourceInstanceTokenHeader)
	if len(values) == 0 {
		return nil, true
	}
	if len(values) != 1 {
		h.handleActionError(w, r, actions.NewValidationError("resource instance token header must appear once"))
		return nil, false
	}
	if err := actions.ValidateResourceInstanceToken(values[0]); err != nil {
		h.handleActionError(w, r, actions.NewValidationError(err.Error()))
		return nil, false
	}
	token := values[0]
	return &token, true
}

func parseIfMatchExpectedVersionValues(values []string) (*int64, error) {
	return ParseIfMatchExpectedVersion(strings.Join(values, ","))
}

// ParseIfMatchExpectedVersion parses Atlas strong ETags of the form "vN".
func ParseIfMatchExpectedVersion(header string) (*int64, error) {
	header = strings.TrimSpace(header)
	if header == "" || header == "*" {
		return nil, nil
	}

	parts := strings.Split(header, ",")
	var expected *int64
	for _, part := range parts {
		token := strings.TrimSpace(part)
		if token == "" {
			return nil, fmt.Errorf("empty If-Match token")
		}
		if token == "*" {
			if len(parts) == 1 {
				return nil, nil
			}
			return nil, fmt.Errorf("If-Match wildcard cannot be combined with entity tags")
		}
		if strings.HasPrefix(strings.ToUpper(token), "W/") {
			return nil, fmt.Errorf("weak If-Match token %q is not allowed", token)
		}
		version, err := parseStrongETagVersion(token)
		if err != nil {
			return nil, err
		}
		if expected != nil && *expected != version {
			return nil, fmt.Errorf("If-Match contains multiple resource versions")
		}
		v := version
		expected = &v
	}
	if expected == nil {
		return nil, fmt.Errorf("If-Match header has no strong entity tag")
	}
	return expected, nil
}

func parseStrongETagVersion(token string) (int64, error) {
	if len(token) < len(`"v1"`) || token[0] != '"' || token[len(token)-1] != '"' {
		return 0, fmt.Errorf("malformed If-Match token %q", token)
	}
	inner := token[1 : len(token)-1]
	if len(inner) < 2 || inner[0] != 'v' {
		return 0, fmt.Errorf("malformed If-Match token %q", token)
	}
	versionDigits := inner[1:]
	for _, ch := range versionDigits {
		if ch < '0' || ch > '9' {
			return 0, fmt.Errorf("malformed If-Match token %q", token)
		}
	}
	if len(versionDigits) > 1 && versionDigits[0] == '0' {
		return 0, fmt.Errorf("malformed If-Match token %q", token)
	}
	version, err := strconv.ParseInt(versionDigits, 10, 64)
	if err != nil || version < 1 {
		return 0, fmt.Errorf("malformed If-Match token %q", token)
	}
	return version, nil
}

// parseNonNegativeIntQuery parses a query parameter as a non-negative integer; empty uses defaultVal.
