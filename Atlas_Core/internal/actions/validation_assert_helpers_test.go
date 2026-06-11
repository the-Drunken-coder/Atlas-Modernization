package actions

import (
	"strings"
	"testing"
)

// assertValidationErrorDetailsContainAll requires every fragment to appear in
// the same validation detail, not merely somewhere across the details slice.
func assertValidationErrorDetailsContainAll(t *testing.T, details []string, want ...string) {
	t.Helper()
	if len(want) == 0 {
		t.Fatal("assertValidationErrorDetailsContainAll requires at least one fragment")
	}
	for _, fragment := range want {
		if fragment == "" {
			t.Fatal("assertValidationErrorDetailsContainAll requires non-empty fragments")
		}
	}
	for _, detail := range details {
		matched := true
		for _, fragment := range want {
			if !strings.Contains(detail, fragment) {
				matched = false
				break
			}
		}
		if matched {
			return
		}
	}
	t.Errorf("expected detail containing all %v, got: %v", want, details)
}
