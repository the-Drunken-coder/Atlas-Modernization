# Deferred Core Reshapes

1. **Time & Date:** 2026-06-10 America/New_York (updated 2026-08-14)
2. **Name:** Deferred Core reshapes
3. **Context:** Review findings once listed three Core shapes as cleanup candidates: `readSnapshotVersion` scanning resource tables, `tasks.entity_id` using `ON DELETE SET NULL`, and health/readiness handlers bypassing the action layer. Migration v4 replaced the table scan. `readSnapshotVersion` now reads `SELECT version FROM atlas_change_clock WHERE singleton`.
4. **Decision:** Keep task entity deletion as `ON DELETE SET NULL` so task history remains visible after an entity is deleted. Keep health and readiness handlers direct because they report process and dependency status rather than domain actions. Do not reopen a snapshot-version metadata table. The change clock is the snapshot.
5. **Alternatives considered:** Cascading task deletes was rejected because it hides task state from changed-since consumers. Routing health and readiness through actions was rejected because it adds ceremony without clarifying domain behavior. A dedicated snapshot-version table is obsolete now that the clock row exists.
6. **Consequences:** Future maintainers should treat the remaining two choices as intentional, not accidental inconsistencies. Revisit them when the task lifecycle or operational health semantics get a larger design pass.
7. **Location:** `atlas_core/internal/actions/query_actions.go`, `atlas_core/internal/database/db.go`, `atlas_core/internal/api/handlers/handler_health.go`
8. **Notes:** Snapshot versioning now follows `docs/design-decisions/2026-06-12-change-feed-websocket-fat-events.md`.
