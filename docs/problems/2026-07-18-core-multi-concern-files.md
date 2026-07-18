# Atlas Core packages contain a few multi-concern source files

1. **Time & Date:** 2026-07-18T08:27:38-04:00
2. **Name:** Atlas Core packages contain a few multi-concern source files
3. **Issue:** A small number of Go files contain several cohesive package concerns in one physical file, which makes navigation and ownership harder even though the functions themselves remain direct.
4. **Severity:** S5 (Note)
5. **Location:** `atlas_core/internal/admin/admin.go`, `atlas_core/internal/feed/hub.go`
6. **Expected:** Closely related behavior remains in the same package but is grouped into files whose names expose the major concern being changed.
7. **Actual:** `admin.go` combines account persistence, sessions, login throttling, password hashing, proxy client-IP parsing, and development credentials. `hub.go` combines the asynchronous change sink, ordered hub, subscriptions, clients, event routing, and protocol validation.
8. **Reproduction:**
   1. Run `rg -n '^func |^type ' atlas_core/internal/admin/admin.go atlas_core/internal/feed/hub.go`
   2. Observe the unrelated symbol groups and the 548-line and 633-line file sizes
9. **Notes:** File length alone is not the problem, and no new interfaces are needed. Same-package splits such as sessions, throttling, client IP, async sink, subscriptions, and protocol conversion would improve navigation without changing architecture.
