# Async feed overflow silently advances past a committed event

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Async feed overflow silently advances past a committed event
3. **Original Audit Finding:** 7
4. **Validation Status:** Confirmed against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`.
5. **Issue:** When the process-wide asynchronous change queue is full, the committed change is dropped and its version is marked skipped. The Hub advances past that version without invalidating connected clients, so a terminal dropped event can leave every client stale indefinitely.
6. **Affected Surface & Severity:** Atlas Core WebSocket feed, SDK caches/watchers, command-interface state, and simulations; **S2 (Major)** because committed state can diverge from connected clients with no event or disconnect telling them to recover.
7. **Location:** `atlas_core/internal/feed/hub.go:18-22`, `atlas_core/internal/feed/hub.go:52-106`, `atlas_core/internal/feed/hub.go:271-343`, `atlas_core/internal/feed/hub.go:409-419`, `atlas_core/internal/feed/hub.go:510-524`, `atlas_core/internal/feed/simulation_test.go:283-344`, and `atlas_core/internal/api/handlers/handlers.go:34-54`.
8. **Expected:** If Core cannot preserve a committed feed event, affected clients are invalidated/closed so reconnect recovery reads authoritative changed-since/snapshot state. A connected client must never silently remain current-looking after an omitted committed version.
9. **Actual:** The default nonblocking send drops a full-queue change and calls `Hub.SkipVersion(version, "async_sink_queue_full")`. `advanceLocked` deletes the skip marker and increments `nextVersion`; it does not notify or close clients. Client closure exists only for each client's separate send-buffer overflow.
10. **Concrete Evidence / Reproduction:**
    1. Run `(cd atlas_core && GOCACHE=/tmp/atlas-audit-go-cache-feed go test ./internal/feed -run 'TestAsyncChangeSinkDoesNotBlockPublisher|TestAsyncChangeSinkSkipsDroppedVersion' -count=1 -v)`.
    2. Both tests pass and log that version 3 is dropped with a one-entry async buffer; the second test confirms `SkipVersion(3, "async_sink_queue_full")`.
    3. Production wiring wraps the single Hub in this sink with the default 1,024-entry buffer (`handlers.go:42`).
    4. Exact terminal sequence: block the sink worker on version 1, fill its queue with version 2, publish committed terminal version 3. Version 3 is stored only in `h.skipped`; after versions 1 and 2 drain, `advanceLocked` advances through 3. With no version 4, clients receive no evidence that 3 was omitted and remain connected.
    5. By contrast, Hub client-buffer overflow returns false from `Client.deliver` and `deliverLocked` closes that client (`hub.go:409-419,510-524`), showing the existing safe recovery signal.
11. **Root Cause:** `SkipVersion` is used for two semantically different cases: permanently unbuildable sequence gaps and loss of a valid committed event caused by local backpressure. Advancing sequence bookkeeping is treated as sufficient even though clients need invalidation after the latter.
12. **Simplest Correct Proposed Solution:** On async queue overflow, close/invalidate all currently connected Hub clients and let normal reconnect recovery reload authoritative state; keep `SkipVersion` only to unblock internal ordering. Add one small Hub method for client invalidation rather than making publishers block or adding another queue tier.
13. **Acceptance Criteria / Regression-Test Plan:**
    1. A deterministic buffer-one test reproduces versions 1/2/3 and asserts every client event channel closes when version 3 overflows.
    2. New clients can connect afterward; invalidation must not permanently close the Hub.
    3. The reconnect path starting from the client's last applied version retrieves the dropped committed resource through recovery.
    4. Ordinary invalid/unbuildable event gaps retain their existing behavior unless they also imply client divergence.
    5. No action/handler write blocks on a slow feed consumer.
14. **Scope / Non-Goals:** Do not add durable event streaming, Kafka, queue-size configuration, delivery acknowledgements, or at-least-once feed semantics. The existing database remains the recovery source of truth.
15. **Overlaps:** Finding 4 concerns stale delete handling after an event reaches the SDK. Finding 31 concerns SDK recovery control flow. This finding occurs earlier, when Core loses the event before any client can process it.
