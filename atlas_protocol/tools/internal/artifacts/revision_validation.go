package artifacts

import (
	"fmt"
	"regexp"
	"strings"
)

var safeProtocolRevisionPattern = regexp.MustCompile(`^sha256:[A-Fa-f0-9]{64}$`)

func validateProtocolRevision(revision string) (string, error) {
	revision = strings.TrimSpace(revision)
	if revision == "" {
		return "", fmt.Errorf("invalid protocol revision: empty")
	}
	if !safeProtocolRevisionPattern.MatchString(revision) {
		return "", fmt.Errorf("invalid protocol revision %q", revision)
	}
	return revision, nil
}
