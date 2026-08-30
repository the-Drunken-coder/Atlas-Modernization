1. **Time & Date:** 2026-08-30T14:55:14Z
2. **Name:** Admin logout hides failed server-side session revocation
3. **Issue:** The admin logout handler clears the browser cookie and returns success even when Core cannot delete the server-side session record. A copied session token therefore remains valid while the database is unavailable during logout.
4. **Severity:** S3 (Moderate)
5. **Location:** Atlas Core, `services/core/internal/api/handlers/handler_admin_auth.go` (`AdminLogout`), `services/core/internal/admin/admin.go` (`Logout` and `deleteSession`)
6. **Expected:** If server-side session deletion fails, the response must not claim that the current session was deleted. The browser cookie may still be cleared, but the client should receive an error and the failure should remain actionable for retry or operator diagnosis.
7. **Actual:** `AdminLogout` logs an error from `adminAuth.Logout`, then always calls `ClearSessionCookie` and writes `204 No Content`. `Logout` returns the `admin_records` deletion error from `deleteSession`, so the original session row and any copied token remain usable until expiry.
8. **Reproduction:**
   1. Log in to Core and retain a copy of the valid `atlas_session` cookie.
   2. Make the `admin_records` database unavailable or force the session `DELETE` in `deleteSession` to fail.
   3. Send `POST /admin/auth/logout` with the cookie and a trusted `Origin`.
   4. Observe that the handler returns `204` and a deletion `Set-Cookie` despite the failed database operation.
   5. Restore database access and send `GET /admin/auth/me` with the retained cookie before its expiry. `AuthenticateRequest` still finds the session row, validates its account and expiry, and accepts the token.
9. **Notes:** Source trace: `AdminLogout` catches and logs the error at `handler_admin_auth.go:68-70`; `Logout` delegates to `deleteSession` at `admin.go:289-295`; `deleteSession` executes the session-row deletion at `admin.go:335-337`. The API contract says logout deletes the current browser session and clears the cookie (`services/core/docs/API_GUIDE.md:524-528`). `go test ./internal/admin -run '^TestDevelopmentAdminSeedLoginAndLogout$' -count=1` passed for the normal revocation path; an outage reproduction was not run against a live database because it would alter external state.
