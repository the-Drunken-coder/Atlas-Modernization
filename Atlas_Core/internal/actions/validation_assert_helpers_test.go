package actions

import (
	"strings"
	"testing"
)

func assertValidationResult(t *testing.T, result *ValidationResult, wantErr bool, errMsg string) {
	t.Helper()
	if result == nil {
		t.Fatalf("assertValidationResult: result is nil")
	}
	if wantErr {
		if !result.HasErrors() {
			t.Errorf("expected errors but got none")
			return
		}
		if errMsg != "" && !strings.Contains(result.Error(), errMsg) {
			t.Errorf("expected error containing %q, got: %v", errMsg, result.Errors)
		}
		return
	}
	if result.HasErrors() {
		t.Errorf("expected no errors but got: %v", result.Errors)
	}
}

func assertValidationErrorDetailsContain(t *testing.T, details []string, want string) {
	t.Helper()
	for _, d := range details {
		if strings.Contains(d, want) {
			return
		}
	}
	t.Errorf("expected detail containing %q, got: %v", want, details)
}
