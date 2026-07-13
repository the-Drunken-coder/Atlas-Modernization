# Rejected Writes Stall Subsequent Change-Feed Delivery

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Burned change versions impose a two-second realtime delay
3. **Issue:** Failed writes consume global change versions, causing later successful feed events to wait for the missing-version timeout before delivery.
4. **Severity:** S3 (Moderate)
5. **Location:** `Atlas_Core/internal/feed/`, `Atlas_Core/internal/actions/`, `docs/design-decisions/2026-06-12-change-feed-websocket-fat-events.md`
6. **Expected:** Routine rejected requests should not add a multi-second latency penalty to unrelated successful operator-visible changes.
7. **Actual:** A duplicate entity create returned `409` after burning version 15, and a task targeting a missing entity returned `404` after burning version 16. Five successful events at versions 17-21 then waited for the feed's two-second gap timeout. Core logged `Skipping timed-out Atlas feed version gap` with `from_version:15`, `to_version:16`, `pending_events:5`, and `timeout:2000`.
8. **Reproduction:**
   1. Subscribe an authenticated client to the Core change feed
   2. Submit a create that reaches version allocation but is rejected as a duplicate
   3. Submit another rejected create, such as a task targeting a missing entity
   4. Immediately perform several valid resource writes
   5. Measure when the valid events arrive and inspect Core logs
   6. Observe that the valid events wait for the missing-version timeout
9. **Notes:** Clients recover correctly through `changed-since`; this is a deterministic realtime latency problem, not consistency loss. The current behavior is documented as an intentional liveness mechanism, so any fix must preserve ordering and burned-version recovery semantics.
