# Design Decision

1. **Time & Date:** 2026-05-29T05:55:00Z (revised 2026-08-04)
2. **Name:** Durable production storage with explicit development reset mode
3. **Context:** The original decision made every startup drop resource tables and empty MinIO. That avoided schema drift during greenfield development, but it also made the production Compose stack destroy resource rows and blobs on an ordinary restart. `admin_records` survived only as a special exception. Production now needs the smallest durable baseline: retained rows and blobs, explicit schema history, fail-closed drift detection, and an operational backup/rollback path. Development still benefits from a direct scratch reset.
4. **Decision:** Update the original decision in place rather than adding a second compatibility posture.

   - `DATABASE_RECREATE_ON_STARTUP=false` is the default and the production contract. Startup takes a PostgreSQL advisory lock, verifies `atlas_schema_migrations`, applies pending migrations in one transaction, verifies the Atlas-owned catalog fingerprint, and fails before readiness on unknown versions, gaps, changed migration checksums, or catalog drift.
   - `atlas_schema_migrations` records `version`, `name`, immutable migration `checksum`, `fingerprint_version`, resulting `schema_fingerprint`, and `applied_at`. Fingerprint algorithms are immutable and versioned separately so a future algorithm can verify the previous row before a migration records the newer algorithm.
   - Migration v1 is the exact schema that existed when this decision changed. A clean database installs v1. An unversioned database with that exact schema is fingerprinted and stamped v1 before later migrations run. Partial or modified unversioned schemas fail closed. Migration v4 replaces the legacy change sequence and deletion table with the transactional change clock and event log.
   - Production startup requires the configured MinIO bucket to already exist and never creates or empties it. A missing or unavailable production bucket is startup-fatal so Core cannot serve durable object metadata without its paired blob store.
   - `admin_records` is durable production data, not a special exception to a scratch system. Accounts, sessions, login throttles, managed API-key hashes/metadata, resource rows, the durable change log, the blob-deletion outbox, and migration metadata travel together in full-database backups.
   - `DATABASE_RECREATE_ON_STARTUP=true` remains an explicit local development/test mode. It migrates and verifies the current schema, truncates disposable resource rows and change events, resets the change clock, preserves `admin_records` and migration history, and clears the configured bucket. Development Compose selects this mode. The production image rejects it.
5. **Alternatives considered:** Keep destructive production startup; rejected because an ordinary restart must not be a data-loss event. Add a hidden compatibility or auto-repair mode; rejected because a partial schema must not be guessed into a valid version. Rely only on a version row; rejected because manual column/index/constraint drift would remain invisible. Add down migrations; rejected because restoring a paired pre-deploy database and bucket snapshot is safer and smaller for this single-host greenfield deployment.
6. **Consequences:**

   - Every production schema change requires a new ordered migration. Migration v1 is immutable; editing its DDL or checksum is a startup failure.
   - A failed migration rolls back its DDL and version record together. MinIO is untouched.
   - Catalog drift is detected on startup even when the migration version still looks current.
   - PostgreSQL and MinIO are one logical durable store for backup and restore. Operators must quiesce writes and capture/restore both under one backup-set identifier.
   - Rolling back after a migration committed means stopping Core, restoring both members of the paired backup, and starting a compatible durable image. The release containing migration v1 is the rollback floor: never boot an older destructive image/Compose stack against retained or restored state. The inaugural cutover must fix forward on the durable runtime. Do not reverse DDL in place.
   - Development keeps one-command scratch startup without weakening production defaults.
7. **Location:** `atlas_core/internal/database/migrations.go`, `atlas_core/internal/database/schema_fingerprint.go`, `atlas_core/internal/database/db.go`, `atlas_core/cmd/atlas_core/main.go`, `atlas_core/docker/docker-compose.yml`, `atlas_core/docker/docker-compose.production.yml`, `atlas_core/docker/production-entrypoint.sh`, and `atlas_core/docs/DEPLOYMENT_RUNBOOK.md`.
8. **Notes:** This revision supersedes the original “no migrations, permanent disposable storage” posture. It does not add protocol/API compatibility versioning; it only versions the durable PostgreSQL schema required by a specific Core binary.

(End of file)
