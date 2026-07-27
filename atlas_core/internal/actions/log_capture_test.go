package actions

import (
	"bytes"
	"sync"
	"testing"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

var actionsTestLogMu sync.Mutex

// captureActionsTestLogs redirects the global zerolog logger into a buffer
// until test cleanup, mirroring the feed package's captureFeedTestLogs.
func captureActionsTestLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	actionsTestLogMu.Lock()
	var buf bytes.Buffer
	previous := log.Logger
	log.Logger = zerolog.New(&buf)
	t.Cleanup(func() {
		log.Logger = previous
		actionsTestLogMu.Unlock()
	})
	return &buf
}
