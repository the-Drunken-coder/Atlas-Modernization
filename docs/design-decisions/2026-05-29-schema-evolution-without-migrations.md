# Design Decision

1. **Time & Date:** 2026-05-29T05:55:00Z (updated 2026-05-30)
2. **Name:** Disposable runtime storage — destroy-and-recreate database and bucket on startup (no migrations)
3. **Context:** Originally, `EnsureTables` used `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. That bootstrapped fresh databases but silently skipped existing tables when the Go models and DDL changed. A binary expecting new columns could run against an old database with no startup error until a query failed at request time.

   Options considered:
   - **(A)** Migration framework — rejected: Atlas Core does not treat the database as a long-lived store of record; schema is owned by the Go models and DDL in code, not by incremental migration history.
   - **(B)** Schema-version hash or drift detection — rejected: adds complexity without changing the product model. We do not plan to preserve row data across deploys or restarts.
   - **(C)** Drop all tables and recreate from DDL on every startup — **chosen and permanent**: zero drift by construction. No migrations, no version table, no “phase 2” persistence path.

4. **Decision:** On startup (when `DATABASE_RECREATE_ON_STARTUP=true`, the default), `EnsureTables` runs `DROP TABLE IF EXISTS ... CASCADE`, then `CREATE TABLE` / `CREATE INDEX` from `Atlas_Core/internal/database/db.go`. Atlas Core then initializes MinIO, ensures the configured bucket exists, and empties that bucket before serving traffic. Every restart yields a database that exactly matches the current models and DDL and a bucket without stale blobs. **All PostgreSQL row data and MinIO object data are intentionally disposable runtime state** — lost on every recreate-mode process restart. The database and configured bucket are scratch storage for the running service, not systems of record. This is the long-term operational model, not a greenfield placeholder.

5. **Alternatives considered:** See (A) and (B) above — both rejected as inconsistent with disposable runtime storage. `DATABASE_RECREATE_ON_STARTUP=false` only skips the drop/recreate and checks that core tables exist; it does **not** evolve schema, does **not** make PostgreSQL durable, and is not a supported production mode. Use it only for narrow local experiments where you accept manual schema management and drift risk.

6. **Consequences:**
   - Schema drift against the current binary is structurally impossible when recreate-on-startup is enabled.
   - Operators must not rely on PostgreSQL or Atlas Core's configured MinIO bucket for durable entity/task/object history; clients sync from the API or external systems if they need retention.
   - Bucket clearing is startup-fatal in recreate mode because an empty database with stale blobs would violate the storage lifecycle.
   - Per-object blob deletion failures are retried through `storage_deletion_outbox` during a running process; this is cleanup for the active runtime bucket, not durable data retention.
   - Seed or fixture data belongs in `docker/postgres/init.sql` (or equivalent bootstrap), not in expecting data to survive restart.
   - Atlas Protocol (when built) validates **shape** of JSON; it does not change this **storage lifecycle** — Core still owns when rows exist.

7. **Location:** `Atlas_Core/internal/database/db.go` (`EnsureTables`), `Atlas_Core/internal/storage/storage.go` (`EmptyBucket`), `Atlas_Core/internal/actions/object_actions.go` (`storage_deletion_outbox` retries), `Atlas_Core/cmd/atlas_core/main.go` (startup order and reconciler), `Atlas_Core/docs/DATABASE_WORKFLOW.md`, `Atlas_Core/internal/config/config.go` (`DATABASE_RECREATE_ON_STARTUP`)

8. **Notes:** Supersedes any prior notes that framed destroy-and-recreate as temporary, treated PostgreSQL as something Atlas Core should keep around, or pointed at a future schema-version hash when “data matters.” Disposable runtime storage is intentional for the life of this project.

(End of file)
