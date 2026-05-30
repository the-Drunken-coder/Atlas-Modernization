# Problem

1. **Time & Date:** 2026-05-29T00:00:00Z
2. **Name:** `EnsureTables` runs DDL every startup with no schema-version guard
3. **Issue:** Schema bootstrap is `CREATE TABLE/INDEX IF NOT EXISTS` executed on every process start. It creates missing tables but never evolves existing ones, and there is no schema-version sentinel — so a binary expecting a newer shape will silently run against a drifted older database. The migration-free posture is intentional (see Design Decision `2026-05-29-schema-evolution-without-migrations.md`); this note tracks the missing guard rail, not the policy.
4. **Severity:** S5 (Note) — accepted for now (greenfield, disposable DBs); becomes risky before any shared/long-lived environment.
5. **Location:** `Atlas_Core/internal/database/db.go` (`EnsureTables`), `Atlas_Core/docs/DATABASE_WORKFLOW.md`, `docs/design-decisions/2026-05-29-schema-evolution-without-migrations.md`
6. **Expected:** Either a startup schema-version assertion that fails fast on drift, or a documented/forced fresh-DB workflow that makes drift impossible to run against unnoticed.
7. **Actual:** Drift between Go models and an existing DB runs without detection until a query fails at request time.
8. **Reproduction:**
   1. Create a DB with the current schema.
   2. Add a column to the Go model + `EnsureTables` DDL, rebuild, restart against the existing DB.
   3. Observe the column is not added and no startup error is raised.
9. **Resolution (2026-05-29):**

   Three options were on the table for the schema-drift problem:
   - **(A) Migration framework** — overkill for greenfield, no real data, single developer.
   - **(B) Schema-version hash/sentinel** to detect drift and fail fast — adds detection logic but doesn't prevent drift, and the extra complexity buys nothing when data doesn't matter.
   - **(C) Destroy-and-recreate** — drop all tables and rebuild them from the DDL on every startup. Simplest possible thing. Zero drift by construction. No migrations, no version tracking, no detection code.

   **Chose (C).** `EnsureTables` now runs `DROP TABLE IF EXISTS … CASCADE` to clear all tables, then recreates them with plain `CREATE TABLE` / `CREATE INDEX` (no `IF NOT EXISTS`). Every startup produces a database that exactly matches the current Go models and DDL. All existing data is lost on restart — intentional and acceptable for this project's use case. When data persistence eventually matters, the natural upgrade path is a schema-version hash: compute a hash of the DDL, store it in a `schema_version` row, and only drop-and-recreate when the stored hash differs from the current one.

   Updated: `Atlas_Core/internal/database/db.go`, `Atlas_Core/docs/DATABASE_WORKFLOW.md`, `docs/design-decisions/2026-05-29-schema-evolution-without-migrations.md`.
