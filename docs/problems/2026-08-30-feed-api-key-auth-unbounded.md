1. **Time & Date:** 2026-08-30T14:54:14Z
2. **Name:** Managed feed API-key validation has no authentication deadline
3. **Issue:** First-message authentication for managed feed API keys applies `AuthTimeout` only while waiting for the websocket auth frame. Once a frame arrives, managed-key validation runs on the request context without a deadline, so a stalled database query can retain the upgraded connection and handler indefinitely.
4. **Severity:** S3 (Moderate)
5. **Location:** `services/core/internal/feed/server.go`, `services/core/internal/api/handlers/handler_feed.go`, `services/core/internal/admin/api_keys.go`
6. **Expected:** Every first-frame authentication attempt, including managed API-key lookup, either completes or is canceled within the configured feed authentication timeout, then closes the unauthenticated websocket.
7. **Actual:** `readAuthFrame` starts a timer only around `conn.Read` and stops selecting on it as soon as the frame arrives. It passes the parent request-derived context to `validAPIKey`; the handler installs `AuthenticateAPIKeyResult` as the managed-key validator, and that validator calls `pgxpool.QueryRow` with the same context. There is no nested deadline for the database lookup, so the request remains blocked while the database or pool remains stalled.
8. **Reproduction:**
   1. Enable API-key auth and connect to `/feed` without a pre-upgrade key, so first-message authentication is required.
   2. Send a valid-shaped managed-key auth frame such as `{"action":"auth","api_key":"atlas_ak_<valid-id>.<secret>"}`.
   3. Stall the database query or exhaust the database pool while `AuthenticateAPIKeyResult` executes.
   4. Observe that the configured `AuthTimeout` no longer governs the request after the frame has been read; the websocket handler remains blocked until the client disconnects, the database returns, or the request context is canceled.
9. **Notes:** The source trace is deterministic; no live database stall was introduced. Existing focused auth tests passed with `go test ./internal/feed -run 'TestWebsocketFeedFirstMessageAuth' -count=1` (loopback access required). The timer and validator call are at `server.go:203-253`; handler wiring is at `handler_feed.go:25-28`; the managed lookup is at `api_keys.go:178-208`. The database pool timeout in `internal/database/db.go:220-236` bounds only pool creation/startup ping, not later `QueryRow` calls. Smallest fix: derive a `context.WithTimeout` using `AuthTimeout` around the validator call and add a blocking-validator test that asserts cancellation and policy close.
