package actions

import (
	"testing"

	"github.com/the-drunken-coder/atlas/atlas_core/internal/actions/actionstest"
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
		if errMsg != "" && !actionstest.MessageContains(result.Error(), errMsg) {
			t.Errorf("expected error containing %q, got: %v", errMsg, result.Error())
		}
		return
	}
	if result.HasErrors() {
		t.Errorf("expected no errors but got: %v", result.Errors)
	}
}

func assertValidationErrorDetailsContain(t *testing.T, details []string, want string) {
	t.Helper()
	actionstest.AssertDetailsContain(t, details, want)
}
