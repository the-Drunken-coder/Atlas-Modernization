# Global Write Version Lock

1. **Time & Date:** 2026-06-10 America/New_York
2. **Name:** Global advisory lock for write versions
3. **Context:** Atlas Core exposes `GET /queries/changed-since` as a sync cursor over entity, task, object, and tombstone `version` values. Those versions come from one PostgreSQL sequence, but sequence values alone do not serialize concurrent transactions or guarantee that commit visibility follows version order.
4. **Decision:** Keep the transaction-scoped advisory lock in `actions/write_version.go` for resource write transactions. The lock serializes writes before row versions are allocated and committed, making `version` a safe global changed-since cursor.
5. **Alternatives considered:** Per-table cursors were rejected because clients would need to track multiple independent positions. `updated_at` cursors were rejected because clock precision and equal timestamps make stable pagination harder. Removing the lock without a replacement ordering mechanism was rejected because clients could miss writes that commit out of version order.
6. **Consequences:** Writes are intentionally serialized through one advisory lock, which trades write throughput for a simple and reliable sync contract. If Atlas later needs higher write throughput, the changed-since cursor design should change with it rather than quietly removing this lock.
7. **Location:** `atlas_core/internal/actions/write_version.go`, `atlas_core/internal/actions/query_actions.go`, `atlas_core/internal/database/db.go`
8. **Notes:** Related to `docs/design-decisions/2026-06-10-resource-write-concurrency.md`.
