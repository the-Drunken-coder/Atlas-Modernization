# Concurrent login checks bypass the expensive-work throttle

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Concurrent login checks bypass the expensive-work throttle
3. **Issue:** Concurrent login requests independently read the failure count before password verification and record failures only afterward. More than eight requests can all pass the throttle gate and run Argon2 simultaneously.
4. **Severity:** **S1 (Blocker)** — an unauthenticated concurrency burst bypasses the intended security control and can exhaust process/container memory and CPU.
5. **Location:** `atlas_core/internal/admin/admin.go:26-50,156-194,318-425`, `atlas_core/internal/admin/admin_test.go:139-162`, `atlas_core/internal/api/handlers/handler_admin_auth.go:33-53`
6. **Expected:** Admission is race-free per username/IP and concurrent Argon2 work has a hard process-wide bound. Acquire the Argon2 semaphore before opening database connections or taking advisory locks so queued requests cannot hoard either; acquire per-identity locks in one deterministic order to avoid deadlocks. Keep real and dummy verification on the same path.
7. **Actual:** `Login` calls `loginThrottled` before `VerifyPassword`; each request performs Argon2 and only afterward calls `recordLoginFailure`. The final SQL upsert is atomic but cannot constrain work already started. The sequential boundary test only proves request nine is rejected after eight completed failures. This was confirmed by static concurrency proof against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`.
8. **Reproduction:**
   1. Inspect `admin.go:164-190`: the throttle read completes before the Argon2 call and failure write.
   2. With count 0, pause N requests for the same username/IP after `loginThrottled` returns false; release all N. Every request reaches `VerifyPassword` before any failure must be recorded.
   3. Each default/dummy verification requests `19 * 1024 KiB`; sixteen admitted requests request about 304 MiB before Go/runtime overhead.
   4. Add a bounded barrier test proving at most eight same-identity attempts enter verification, real and dummy paths share the global bound, and different identities do not deadlock.
