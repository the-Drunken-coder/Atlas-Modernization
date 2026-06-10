# Design Decision

1. **Time & Date:** 2026-06-09T00:00:00Z
2. **Name:** Global advisory write lock protects sync-version ordering
3. **Context:** Atlas Core exposes full-dataset and changed-since sync APIs over entities, tasks, objects, and deletion tombstones. Those APIs depend on a globally comparable `version`, not just per-table timestamps. Without serialization, concurrent transactions could claim versions and commit in an order that makes a client cursor skip a later-committing row.
4. **Decision:** Every mutating action opens its change transaction through `beginChangeTx`, which acquires a PostgreSQL transaction-scoped advisory lock using the stable `atlas-core-change-version` key before allocating or committing versioned changes. This serializes writes across resource types so committed versions form a safe global order for sync cursors.
5. **Alternatives considered:** Use independent table sequences with commit timestamps; rejected because cross-table changed-since pagination would need more complex reconciliation and could still expose commit-order races. Use one table-specific lock per resource type; rejected because changed-since spans all resource types.
6. **Consequences:**
   - Write throughput is intentionally serialized while the project is greenfield and sync correctness is more important than write parallelism.
   - `GET /queries/changed-since` can treat `version` as a monotonic global cursor across live rows and tombstones.
   - If write volume later makes this lock too expensive, the sync protocol must be redesigned before removing it.
7. **Location:** `Atlas_Core/internal/actions/write_version.go`, `Atlas_Core/internal/actions/syncactions/changed_since.go`, `Atlas_Core/internal/database/db.go`

(End of file)
