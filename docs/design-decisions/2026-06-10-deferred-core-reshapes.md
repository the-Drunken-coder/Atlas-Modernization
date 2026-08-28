# Deferred Core Reshapes

1. **Time & Date:** 2026-06-10 America/New_York (updated 2026-08-19)
2. **Name:** Deferred Core reshapes
3. **Context:** Review findings once listed the snapshot-version query, nullable Task assignment, and direct health handlers as cleanup candidates. Migration v4 replaced the table scan with `atlas_change_clock`. The command-tasking cutover later replaced nullable `tasks.entity_id` with immutable `tasks.asset_id` and permanent Task retention.
4. **Decision:** Keep health and readiness handlers direct because they report process and dependency status rather than domain actions. Do not add another snapshot-version table. The change clock is the snapshot. Migration v7 supersedes the earlier nullable Task-assignment decision.
5. **Alternatives considered:** Routing health and readiness through actions adds code without clarifying domain behavior. A dedicated snapshot-version table duplicates the clock row. Mutable or nullable Task assignment conflicts with the Protocol Task contract.
6. **Consequences:** Health and readiness remain direct handlers. Snapshot reads use the change clock. A Task keeps its Asset ID even after the Asset Entity is deleted.
7. **Location:** `services/core/internal/actions/query_actions.go`, `services/core/internal/database/migrations.go`, `services/core/internal/api/handlers/handler_health.go`
8. **Notes:** Snapshot behavior follows `docs/design-decisions/2026-06-12-change-feed-websocket-fat-events.md`. Task behavior follows `docs/atlas-protocol/commands-and-tasking.md`.
