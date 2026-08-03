# Async feed overflow silently advances past a committed event

1. **Time & Date:** 2026-08-03T06:07:56Z (revalidated; originally recorded 2026-07-30)
2. **Name:** Async feed overflow silently advances past a committed event
3. **Issue:** When the process-wide asynchronous change queue is full, a committed change is dropped and its version marked skipped. The Hub advances without invalidating connected clients, so a terminal dropped event can leave every client stale indefinitely.
4. **Severity:** **S2 (Major)** — committed state can diverge from connected SDK, command-interface, and simulation clients with no recovery signal.
5. **Location:** `atlas_core/internal/feed/hub.go`, `atlas_core/internal/feed/simulation_test.go`, `atlas_core/internal/api/handlers/handlers.go`
6. **Expected:** If Core cannot preserve a committed feed event, affected clients are closed so reconnect recovery reads authoritative changed-since/snapshot state.
7. **Actual:** Queue overflow still calls `Hub.SkipVersion(version, "async_sink_queue_full")`; `advanceLocked` deletes the skip marker and increments `nextVersion` without notifying clients. This was revalidated against `main` at `f4b0187fdb68088ea0b59d28218d02204f4cfc9c`.
8. **Reproduction:**
   1. Run `(cd atlas_core && GOCACHE=/tmp/atlas-audit-go-cache-feed go test ./internal/feed -run 'TestAsyncChangeSinkDoesNotBlockPublisher|TestAsyncChangeSinkSkipsDroppedVersion' -count=1 -v)`.
   2. Block the worker on version 1, fill its queue with version 2, then publish committed terminal version 3. Version 3 is skipped; after 1 and 2 drain, clients remain connected with no evidence of 3.
   3. On overflow, invalidate current Hub clients while retaining `SkipVersion` only for internal ordering; test client closure, subsequent reconnect, and recovery of the dropped committed resource.
