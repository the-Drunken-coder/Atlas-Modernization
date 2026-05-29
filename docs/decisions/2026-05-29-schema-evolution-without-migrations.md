# Design Decision

1. **Time & Date:** 2026-05-29T05:55:00Z
2. **Name:** Keep schema evolution migration-free during current development
3. **Context:** `EnsureTables` creates missing tables and indexes with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, but it does not evolve existing tables when columns or types change. The database workflow documentation already states that Atlas Core does not use an in-repo migration framework and that existing databases need reviewed manual SQL for schema changes.
4. **Decision:** Keep Atlas Core migration-free for now. Treat `internal/database/db.go` as the fresh-install schema source and use reviewed manual SQL or one-off operational procedures for existing database changes. Do not introduce a migration framework as a straight bug fix.
5. **Alternatives considered:** Add an in-repo migration tool now; rejected because it changes the project workflow and deployment model rather than fixing a local defect. Have `EnsureTables` automatically alter existing schemas; rejected because implicit schema mutation at startup can hide operational risk and makes rollback harder. Add a schema-version sentinel or startup schema assertion; deferred as a future design option rather than adopted immediately.
6. **Consequences:** Fresh databases remain simple to bootstrap. Existing databases can still drift from the current Go model until an operator applies the expected SQL change. Before production or long-lived shared environments, the project should decide whether to add explicit schema assertions, a schema version table, reviewed SQL change files, or a fuller migration workflow.
7. **Location:** `Atlas_Core/internal/database/db.go` (`EnsureTables`), `Atlas_Core/docs/DATABASE_WORKFLOW.md`
8. **Notes:** This supersedes the transient problem note about `EnsureTables` not evolving existing schemas. The current posture is intentional development simplicity, not a claim that schema drift is solved.
