# Problem

1. **Time & Date:** 2026-05-29T00:00:00Z
2. **Name:** `EnsureTables` runs DDL every startup with no schema-version guard
3. **Issue:** Schema bootstrap is `CREATE TABLE/INDEX IF NOT EXISTS` executed on every process start. It creates missing tables but never evolves existing ones, and there is no schema-version sentinel — so a binary expecting a newer shape will silently run against a drifted older database. The migration-free posture is intentional (see Design Decision `2026-05-29-schema-evolution-without-migrations.md`); this note tracks the missing guard rail, not the policy.
4. **Severity:** S5 (Note) — accepted for now (greenfield, disposable DBs); becomes risky before any shared/long-lived environment.
5. **Location:** `Atlas_Core/internal/database/db.go` (`EnsureTables`), `Atlas_Core/docs/DATABASE_WORKFLOW.md`, `docs/decisions/2026-05-29-schema-evolution-without-migrations.md`
6. **Expected:** Either a startup schema-version assertion that fails fast on drift, or a documented/forced fresh-DB workflow that makes drift impossible to run against unnoticed.
7. **Actual:** Drift between Go models and an existing DB runs without detection until a query fails at request time.
8. **Reproduction:**
   1. Create a DB with the current schema.
   2. Add a column to the Go model + `EnsureTables` DDL, rebuild, restart against the existing DB.
   3. Observe the column is not added and no startup error is raised.
9. **Notes:** Lightweight options before production: a `schema_version` table checked at startup, a startup assertion of expected columns, or reviewed versioned SQL files. Deliberately deferred per the design decision.
