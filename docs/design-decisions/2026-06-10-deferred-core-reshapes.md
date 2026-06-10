# Deferred Core Reshapes

1. **Time & Date:** 2026-06-10 America/New_York
2. **Name:** Deferred Core reshapes
3. **Context:** A few Core implementation shapes look like candidates for cleanup: `readSnapshotVersion` scans resource tables, `tasks.entity_id` uses `ON DELETE SET NULL`, and health/readiness handlers bypass the action layer. They are visible review findings, but none blocks the current greenfield contract.
4. **Decision:** Defer these reshapes. Keep `readSnapshotVersion` as a table scan until changed-since pressure justifies a dedicated metadata table. Keep task entity deletion behavior as `ON DELETE SET NULL` so task history can remain visible after an entity is deleted. Keep health and readiness handlers direct because they report process/dependency status rather than domain actions.
5. **Alternatives considered:** A durable snapshot-version table was rejected for now because the current table scan is simpler and bounded by current data scale. Cascading task deletes was rejected because it hides task state from changed-since consumers. Routing health/readiness through actions was rejected because it adds ceremony without clarifying domain behavior.
6. **Consequences:** Future maintainers should treat these as intentional debt, not accidental inconsistencies. Revisit them when the sync endpoint, task lifecycle, or operational health semantics get a larger design pass.
7. **Location:** `Atlas_Core/internal/actions/query_actions.go`, `Atlas_Core/internal/database/db.go`, `Atlas_Core/internal/api/handlers/handler_health.go`
8. **Notes:** These choices should stay documented until replaced by a broader Core architecture decision.
