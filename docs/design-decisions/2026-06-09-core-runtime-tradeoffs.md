# Design Decision

1. **Time & Date:** 2026-06-09T00:00:00Z
2. **Name:** Defer low-risk sync, task lifetime, and readiness reshapes
3. **Context:** Architecture review noted a few places that are intentionally simple today: `readSnapshotVersion` scans the small set of versioned tables, task rows keep historical work context after an entity is deleted, and health/readiness handlers perform direct dependency checks instead of routing through actions.
4. **Decision:** Keep these shapes for now. `readSnapshotVersion` may scan the current versioned tables because the table set is fixed and small. `tasks.entity_id` remains `ON DELETE SET NULL` because tasks can outlive entities and deletion tombstones cover client sync. Health and readiness handlers may bypass action objects because they check service dependencies, not resource behavior.
5. **Alternatives considered:** Build a single snapshot-version table; rejected until the current table scan shows up in real profiles. Cascade-delete tasks with entities; rejected because it erases useful task history and sync context. Force health checks through actions; rejected because it would couple readiness to resource APIs without adding coverage.
6. **Consequences:**
   - Changed-since sync remains simple and correct at current scale.
   - Clients must tolerate tasks whose `entity_id` is null after the related entity is deleted.
   - Readiness remains a direct dependency probe and should not grow business behavior.
7. **Location:** `Atlas_Core/internal/actions/syncactions/changed_since.go` (`readSnapshotVersion`), `Atlas_Core/internal/database/db.go` (`tasks.entity_id`), `Atlas_Core/internal/api/handlers/handler_health.go`

(End of file)
