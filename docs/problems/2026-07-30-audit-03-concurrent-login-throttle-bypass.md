# Concurrent login checks bypass the expensive-work throttle

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Concurrent login checks bypass the expensive-work throttle
3. **Original Audit Finding:** 3
4. **Validation Status:** Confirmed by static concurrency proof against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`. A live concurrency stress probe was intentionally not run without an isolated test database and memory boundary.
5. **Issue:** Concurrent login requests independently read the failure count before password verification and record their failures only afterward. More than eight requests can therefore all pass the throttle gate and run Argon2 simultaneously.
6. **Affected Surface & Severity:** Public `POST /admin/auth/login`, Atlas Core process memory/CPU, and service availability; **S1 (Blocker)** because an unauthenticated concurrency burst bypasses the intended security control and can exhaust process/container resources.
7. **Location:** `atlas_core/internal/admin/admin.go:26-50`, `atlas_core/internal/admin/admin.go:156-194`, `atlas_core/internal/admin/admin.go:318-385`, `atlas_core/internal/admin/admin.go:388-425`, `atlas_core/internal/admin/admin_test.go:139-162`, and `atlas_core/internal/api/handlers/handler_admin_auth.go:33-53`.
8. **Expected:** At most the permitted number of attempts for a username/IP enter password verification during the 15-minute window, and total concurrent Argon2 work is bounded independently of request concurrency.
9. **Actual:** `Login` calls `loginThrottled` before `VerifyPassword`; each request then performs Argon2 and only afterward calls `recordLoginFailure`. The SQL upsert atomically increments the eventual count, but it does not reserve admission before expensive work. The sequential boundary test verifies only that request nine is rejected after eight completed failures.
10. **Concrete Evidence / Reproduction:**
    1. Inspect `admin.go:164-190`: the throttle read completes before the Argon2 call and failure write.
    2. Falsifiable schedule: with count 0, pause N same-username/same-IP requests after `loginThrottled` returns false; release all N. Every request reaches `VerifyPassword` before any failure must be recorded.
    3. Each default/dummy verification requests `19 * 1024 KiB` at `admin.go:43-49,393-396`. Sixteen admitted requests therefore request about 304 MiB of Argon2 working memory, excluding Go/runtime overhead.
    4. Run `(cd atlas_core && GOCACHE=/tmp/atlas-audit-go-cache-admin go test ./internal/admin -run TestLoginThrottleBoundary -count=1 -v)`. It skipped because no test database was configured; there is no concurrent throttle regression test in the package.
11. **Root Cause:** Throttle admission is a non-atomic read/check followed by expensive work and a later atomic counter update. Atomicity of the final upsert cannot constrain work that has already started, and there is no global Argon2 concurrency bound.
12. **Simplest Correct Proposed Solution:** Serialize the throttle check, password verification, and success/failure update per username/IP identity using consistently ordered PostgreSQL advisory locks, and put a small process-wide semaphore immediately around every real and dummy Argon2 call. This makes the eight-attempt decision race-free and gives memory use a hard upper bound without introducing a new external rate-limit subsystem.
13. **Acceptance Criteria / Regression-Test Plan:**
    1. A barrier-based DB test launches more than eight simultaneous wrong-password attempts for one username/IP and proves no more than eight enter the injected password-verification function.
    2. Equivalent missing-account and disabled-account attempts use the same admission and global bound.
    3. Different identities can proceed up to the global Argon2 limit without deadlock; username/IP locks are acquired in deterministic order.
    4. Sequential behavior remains eight invalid-credential responses followed by `ErrTooManyAttempts`, and a successful login preserves the intended failure-reset behavior.
    5. A bounded test verifier (not real high-memory Argon2 stress) proves peak concurrent verification never exceeds the configured constant.
14. **Scope / Non-Goals:** Do not add CAPTCHA, distributed edge rate limiting, user-configurable tuning, or a generalized job queue. Do not run an unbounded Argon2 stress test as a regression.
15. **Overlaps:** Finding 5's error sanitization may affect login failure reporting, but it does not fix admission or memory bounds. Finding 15 concerns how the production admin password reaches Core, not login verification behavior.
