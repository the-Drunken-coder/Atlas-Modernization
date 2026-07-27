package actions

import (
	"strings"
	"testing"
	"time"
)

func TestWarnOnSlowChangeVersionLock(t *testing.T) {
	buf := captureActionsTestLogs(t)

	warnOnSlowChangeVersionLock(changeVersionLockWarnThreshold)
	if buf.Len() != 0 {
		t.Fatalf("wait at the threshold should not log, got %q", buf.String())
	}

	warnOnSlowChangeVersionLock(changeVersionLockWarnThreshold + time.Millisecond)
	out := buf.String()
	if !strings.Contains(out, `"level":"warn"`) {
		t.Fatalf("expected warn log for queued writer, got %q", out)
	}
	if !strings.Contains(out, "Change version advisory lock acquisition exceeded threshold") {
		t.Fatalf("expected lock wait message, got %q", out)
	}
	if !strings.Contains(out, `"wait":`) {
		t.Fatalf("expected wait duration field, got %q", out)
	}
}
