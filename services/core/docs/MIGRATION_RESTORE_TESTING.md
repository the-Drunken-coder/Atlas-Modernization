# Migration and paired restore acceptance

The migration/restore acceptance scenario runs the production Atlas Core image against a dedicated PostgreSQL database and MinIO bucket. Every invocation owns a UUID Compose project, bucket, image tag, network, containers, and project-scoped volumes. The runner only removes resources carrying its exact project or image identity.

Run the required scenario from the repository root with Node 24:

```bash
node tests/acceptance/migration-restore/run.mjs
```

On macOS with the Homebrew Node 24 formula:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
  node tests/acceptance/migration-restore/run.mjs
```

The expanded nightly mode adds a schema-catalog drift failure and another paired recovery:

```bash
node tests/acceptance/migration-restore/run.mjs --nightly
```

The required scenario is bounded at 25 minutes inside the runner and 35 minutes in GitHub Actions. Nightly is bounded at 45 minutes inside the runner and 60 minutes in Actions. Individual build, pull, startup, backup, restore, diagnostics, and cleanup commands have shorter bounds. Missing Node 24 or Docker support fails the run before behavior execution.

## Behavior covered

The runner uses the current public Entity and Object HTTP interfaces and the same production image target as a deployment:

1. Start empty PostgreSQL and MinIO volumes, provision the owned bucket, and let Core apply its ordered migrations.
2. Confirm that the migration ledger begins at version 1, is contiguous, and contains checksums and schema fingerprints. The test relates versions to one another instead of fixing the current latest version in test support.
3. Create one opaque Entity ID and upload one binary Object through Core. Both resource IDs are checked against the published 50-character limit before the first request. The file is below the configured 100 MiB upload limit.
4. Snapshot the complete observable Entity and Object data and metadata, plus the Object byte count and SHA-256 digest. Parsed JSON is compared with `node:util` semantic deep equality, so member order has no effect.
5. Restart only Core and confirm that the same container, project volumes, migration ledger, resource representations, and Object bytes remain.
6. Stop Core, create a custom PostgreSQL archive and complete MinIO mirror, validate both members, make post-backup Entity and Object changes, then restore the pair.
7. Confirm that the restored public resources, versions, timestamps, storage metadata, and bytes equal the pre-backup snapshot.
8. Remove the owned bucket and assert that durable Core startup exits with the documented incomplete-storage diagnostic. Restore the MinIO member and confirm recovery.
9. Corrupt the latest migration checksum in the owned database and assert that startup exits with `invalid schema migration history`. Restore the pair and confirm recovery. Nightly also introduces an unexpected column and requires `schema drift detected` before another recovery.

The checksum and schema mutations happen only in the disposable database. They do not edit migration source or retained data.

## Concurrent isolation proof

Before the primary restore, the runner starts `observer.mjs` through the shared acceptance stack. That second run has another UUID Compose project and separate PostgreSQL and MinIO volumes. It continuously updates and reads its own Entity while the primary runner drops, creates, and restores its database and replaces its bucket. The evidence includes both intervals and requires at least one successful public operation to overlap the real restore interval. The observer then reads its sentinel again before its shared runner cleans up.

## Evidence and cleanup

Each run writes `.atlas/acceptance/migration-restore/<timestamp>-<uuid>/`. Set `ATLAS_ACCEPTANCE_ARTIFACTS` to place that parent under another directory. The run directory includes:

- `run.json`, `result.json`, `preflight.json`, and `stack.json` with the exact revision, dirty-worktree status, mode, duration, project identity, and bounded local reproduction command;
- `commands.log`, `http.jsonl`, `readiness.jsonl`, and `evidence.jsonl` with executed commands and raw public observations;
- the validated `backup/` pair, migration-ledger snapshots, and failure-specific API logs;
- `observer-process.log`, observer control timestamps, and the independent shared-runner artifacts;
- pre-teardown Compose logs and resource listings, followed by `cleanup-verification.json` proving that no resource with the run label or owned image tag remains.

Diagnostics run before teardown on success and failure. A diagnostic or cleanup failure fails an otherwise green run, while an earlier test failure remains the primary result. Signal handlers stop active child commands and the observer before attempting the same owned-resource cleanup.

The existing focused migration tests in `internal/database/migrations_test.go` remain the faster coverage for legacy upgrade fixtures, transactional rollback, ledger gaps, drift variants, and scratch restart behavior. `scripts/test_production_persistence.sh` remains the existing fixed-name production-stack check. This acceptance scenario does not invoke that script because its global ports, container names, and external volume names cannot safely run beside another worktree.
