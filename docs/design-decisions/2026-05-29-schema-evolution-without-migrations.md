# Design Decision

1. **Time & Date:** 2026-05-29T05:55:00Z (updated 2026-05-29T12:00:00Z)
2. **Name:** Keep schema evolution migration-free — destroy-and-recreate on every startup
3. **Context:** Originally, `EnsureTables` created missing tables and indexes with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, but it did not evolve existing tables when columns or types changed. That created silent schema drift: a binary expecting newer columns would run against an old database without detection until a query failed at request time.

   The drift forced a choice between three options:
   - **(A)** Add a migration framework — rejected: overkill for a greenfield, single-developer project with no real data.
   - **(B)** Add a schema-version hash/sentinel to detect drift and fail fast — deferred: adds complexity without benefit when data doesn't matter.
   - **(C)** Drop all tables and recreate them from the DDL on every startup — chosen: the simplest possible thing. Zero drift by construction. No migrations, no version tracking, no detection logic.

4. **Decision:** `EnsureTables` now uses `DROP TABLE IF EXISTS ... CASCADE` to clear all tables, then recreates them with plain `CREATE TABLE` / `CREATE INDEX` (no `IF NOT EXISTS`). Every startup produces a database that exactly matches the current Go models and DDL. All existing data is lost on restart — this is intentional and acceptable for the current use case.

5. **Alternatives considered:** (A) Add an in-repo migration tool — rejected because it changes the project workflow and deployment model for no practical gain with zero real data. (B) Have `EnsureTables` automatically alter existing schemas — rejected because implicit schema mutation at startup hides operational risk and makes rollback harder. (C) Add a schema-version sentinel or startup schema assertion — deferred; the destroy-and-recreate approach makes it unnecessary for now, and the hash-check approach is a natural upgrade path when data persistence matters (recreate only when the schema hash differs).

6. **Consequences:** Schema drift is structurally impossible — the database always matches the Go models. All data is ephemeral and lost on every restart. Seed data must go in `docker/postgres/init.sql`. If data persistence becomes necessary in the future, the natural upgrade path is a schema-version hash table: compute a hash of the DDL, store it in a `schema_version` row at startup, and only drop-and-recreate when the stored hash differs from the current one.

7. **Location:** `Atlas_Core/internal/database/db.go` (`EnsureTables`), `Atlas_Core/docs/DATABASE_WORKFLOW.md`

8. **Notes:** This supersedes the transient problem note about `EnsureTables` not evolving existing schemas. The destroy-and-recreate posture makes schema drift impossible by construction rather than by detection.

(End of file - total 17 lines)
