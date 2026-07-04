package testenv

import (
	"os"
	"strings"
	"testing"
)

const requireLiveTestsEnv = "ATLAS_CORE_REQUIRE_LIVE_TESTS"

// RequireLiveTests reports whether live DB/API/storage tests must fail instead
// of skipping when their dependencies are unavailable.
func RequireLiveTests() bool {
	value := strings.TrimSpace(os.Getenv(requireLiveTestsEnv))
	return value == "1" || strings.EqualFold(value, "true")
}

// SkipOrFatal skips in normal local runs and fails in the live integration tier.
func SkipOrFatal(t testing.TB, format string, args ...any) {
	t.Helper()
	if RequireLiveTests() {
		t.Fatalf(format, args...)
	}
	t.Skipf(format, args...)
}
