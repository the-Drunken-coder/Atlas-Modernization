# Design Decision

1. **Time & Date:** 2026-05-29T05:55:00Z (updated 2026-05-30)
2. **Name:** Ephemeral database — destroy-and-recreate on every startup (no migrations)
3. **Context:** Originally, `EnsureTables` used `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. That bootstrapped fresh databases but silently skipped existing tables when the Go models and DDL changed. A binary expecting new columns could run against an old database with no startup error until a query failed at request time.

   Options considered:
   - **(A)** Migration framework — rejected: Atlas Core does not treat the database as a long-lived store of record; schema is owned by the Go models and DDL in code, not by incremental migration history.
   - **(B)** Schema-version hash or drift detection — rejected: adds complexity without changing the product model. We do not plan to preserve row data across deploys or restarts.
   - **(C)** Drop all tables and recreate from DDL on every startup — **chosen and permanent**: zero drift by construction. No migrations, no version table, no “phase 2” persistence path.

4. **Decision:** On startup (when `DATABASE_RECREATE_ON_STARTUP=true`, the default), `EnsureTables` runs `DROP TABLE IF EXISTS ... CASCADE`, then `CREATE TABLE` / `CREATE INDEX` from `Atlas_Core/internal/database/db.go`. Every restart yields a database that exactly matches the current models and DDL. **All row data is intentionally ephemeral** — lost on every process restart. This is the long-term operational model, not a greenfield placeholder.

5. **Alternatives considered:** See (A) and (B) above — both rejected as inconsistent with ephemeral storage. `DATABASE_RECREATE_ON_STARTUP=false` only skips the drop/recreate and checks that core tables exist; it does **not** evolve schema and is not a supported production mode. Use it only for narrow local experiments where you accept manual schema management and drift risk.

6. **Consequences:**
   - Schema drift against the current binary is structurally impossible when recreate-on-startup is enabled.
   - Operators must not rely on PostgreSQL for durable entity/task/object history; clients sync from the API or external systems if they need retention.
   - Seed or fixture data belongs in `docker/postgres/init.sql` (or equivalent bootstrap), not in expecting data to survive restart.
   - Atlas Protocol (when built) validates **shape** of JSON; it does not change this **storage lifecycle** — Core still owns when rows exist.

7. **Location:** `Atlas_Core/internal/database/db.go` (`EnsureTables`), `Atlas_Core/docs/DATABASE_WORKFLOW.md`, `Atlas_Core/internal/config/config.go` (`DATABASE_RECREATE_ON_STARTUP`)

8. **Notes:** Supersedes any prior notes that framed destroy-and-recreate as temporary or pointed at a future schema-version hash when “data matters.” Ephemeral storage is intentional for the life of this project.

(End of file)
