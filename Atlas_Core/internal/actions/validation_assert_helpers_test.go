package actions

import (
	"strings"
	"testing"
)

func assertValidationErrorDetailsContain(t *testing.T, details []string, want string) {
	t.Helper()
	for _, d := range details {
		if strings.Contains(d, want) {
			return
		}
	}
	t.Errorf("expected detail containing %q, got: %v", want, details)
}
