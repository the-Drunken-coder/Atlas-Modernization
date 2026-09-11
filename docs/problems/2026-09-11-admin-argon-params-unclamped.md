1. **Time & Date:** 2026-09-11T00:00:00Z
2. **Name:** Stored Argon2 parameters are used unclamped
3. **Issue:** Password verification feeds stored Argon2 time/memory/parallelism straight into the KDF, so a tampered `admin_records` row can force OOM or CPU exhaustion.
4. **Severity:** S3 (Moderate)
5. **Location:** `services/core/internal/admin/admin.go:418-474`
6. **Expected:** Clamp and validate stored Argon2 parameters (memory/time/parallelism ceilings, hash-length bound) before invoking the KDF, matching the creation-side caps (`19MiB, t=2`, 4-slot concurrency).
7. **Actual:** Line 463 calls `argon2.IDKey(..., stored.Time, stored.MemoryKiB, stored.Parallelism, ...)` with no max clamp. Exploitation requires a DB write, so severity stays moderate.
8. **Reproduction:**
   1. Inspect `admin.go` lines 418-474, focusing on line 463.
   2. Write an `admin_records` account row with extreme `memory_kib`/`time`, then attempt login and observe unbounded allocation/CPU.
9. **Notes:** Creation path, throttling (`8 fails/15m` per user+IP with advisory locks), and dummy-hash enumeration resistance are otherwise solid. Related hardening: admin cookie defaults to `SameSite=none` (`config/environment.go:81`, `config/validation.go:33-36`); prefer `lax` default for production.
