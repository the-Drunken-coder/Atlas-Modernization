# Database Workflow - Atlas Core

## Storage modes

Atlas Core has two explicit startup modes:

| Mode | Setting | PostgreSQL | MinIO | Intended use |
| --- | --- | --- | --- | --- |
| Durable | `DATABASE_RECREATE_ON_STARTUP=false` | Applies ordered migrations and verifies schema drift; preserves all rows | Requires the bucket to exist and preserves every object | Production and any environment whose data matters |
| Scratch | `DATABASE_RECREATE_ON_STARTUP=true` | Migrates/verifies the schema, truncates resource rows, and resets change versions; preserves `admin_records` and migration history | Empties the configured bucket | Local development and disposable integration tests |

Durable mode is the application default and the only mode accepted by the production image. Development Compose explicitly selects scratch mode so the normal local workflow stays simple.

PostgreSQL and the configured MinIO bucket form one logical durable store in production. Resource rows, object metadata, blobs, the ordered change log, deletion retries, and admin state must be backed up and restored together. See [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md).

## Schema ownership

- PostgreSQL 15+ is accessed through pgx v5.
- Go models live in `internal/models/models.go`.
- The immutable v1 DDL lives in `internal/database/db.go`.
- Ordered migrations and their checksums live in `internal/database/migrations.go`.
- Versioned catalog fingerprint algorithms live in `internal/database/schema_fingerprint.go`.
- `EnsureTables()` in `internal/database/db.go` owns startup migration/reset behavior.

The managed schema contains:

- `entities`, `asset_runtimes`, `tasks`, and `objects`
- `atlas_change_clock` and `atlas_change_events`, the transactional ordered change stream
- `storage_deletion_outbox` durable blob-deletion retries
- `storage_upload_intents` leased upload ownership and crash recovery
- `admin_records` accounts, sessions, login throttles, and managed API-key metadata
- `asset_runtime_generations` immutable runtime history for Asset replacement and stop fences
- `resource_instance_tokens` one-time hashes for Entity/Object create recovery
- `atlas_schema_migrations`

## Durable startup

`EnsureTables()` performs the following work before Core serves traffic:

1. Opens one PostgreSQL transaction and takes an advisory migration lock.
2. Finds the active schema from the connection `search_path`.
3. Handles the v1 baseline:
   - Empty schema: installs v1.
   - Exact unversioned pre-migration schema: verifies it against an isolated v1 catalog and stamps v1 without rewriting rows or resetting the change sequence.
   - Partial or modified unversioned schema: fails closed.
4. Loads `atlas_schema_migrations` and requires a contiguous, known history whose names, immutable checksums, and fingerprint algorithm versions match this binary.
5. Recomputes the managed catalog fingerprint and compares it with the latest successfully recorded fingerprint.
6. Applies all pending migration statements and their version records in the same transaction.
7. Records the resulting catalog fingerprint and commits.

Unknown/future versions, missing versions, edited migration definitions, dropped indexes, changed columns/defaults/constraints, or other Atlas-owned catalog drift are startup-fatal. A failed migration rolls back its DDL and version record together.

After PostgreSQL succeeds, durable startup verifies that the configured MinIO bucket already exists. It never creates or empties that bucket. A missing or unreachable bucket is startup-fatal so a restored database cannot become ready without its paired blob store. The production Compose API service waits for the `minio-init` verifier to succeed, so a missing bucket prevents the Core process from starting. The manual production Compose files use fixed external PostgreSQL and MinIO volumes, and `atlas.py --production` verifies that the required set exists before cleanup or startup. Operators must explicitly create or restore those volumes as a pair with the same non-empty `io.atlas.core.storage-set` label, then provision the bucket for a clean manual deployment or restore it from the backup paired with PostgreSQL. For a new packaged deployment, `atlas-core init` may provision the bucket before PostgreSQL exists, but only after it proves that no prior Atlas volumes or unmatched configuration exist. Every later missing-bucket case still fails closed. The embedded command catalog is independent of object storage and is served directly at `GET /command-catalog`.

## Baseline migration v1

Migration v1 represents the exact schema that predated durable production storage. Its checksum is frozen. Do not edit v1 to make a new binary fit an old database; add the next migration instead.

The baseline adoption path exists only for the exact unversioned v1 catalog. It deliberately does not add missing columns or indexes and does not stamp a partial schema as current.

Migration v2 adds `storage_upload_intents`. Core records an intent before each
blob write, renews its lease while the upload is active, and removes it in the
same transaction that commits object metadata. The storage reconciler marks
expired intents orphaned, waits through a safety grace period, verifies that no
object references the path, and then transfers deletion to the durable outbox.
Successful deletion rows remain with `next_attempt_at = 'infinity'` as permanent
path tombstones so deleted generated paths cannot be reused by later metadata.
Migration v3 adds the path-leading index used to reject those tombstones without
scanning the append-only outbox. Retention is deliberate: each generated path
adds at most one compact row, and removing it would reopen the reuse race.

Migration v4 replaces the legacy sequence and resource-deletion table with `atlas_change_clock` and `atlas_change_events`. Every resource mutation allocates its version, writes the resource state, and appends the complete feed event in one transaction. PostgreSQL notifications only wake the feed dispatcher; the durable event row is the source of truth.

Migration v5 bounds that recovery log without coupling retention to object-storage correctness. `atlas_change_clock.min_retained_version` records the oldest accepted cursor, and `object_deletion_fences` keeps one permanent version fence per deleted object ID. Core retains seven days of change events and prunes hourly. Clients behind the retained window receive `CURSOR_EXPIRED` and must hydrate from the live resource tables before resuming changed-since recovery.

Migration v6 corrects upgraded databases whose pre-change-stream resource versions have no corresponding recovery events. It advances `min_retained_version` to the earliest complete recovery cursor, so those clients receive `CURSOR_EXPIRED` instead of an empty response that falsely advances them across missing history. It also adds the `(created_at, version)` retention index. Pruning deletes bounded batches and commits each batch separately so resource mutations can acquire the change-clock lock between batches.

Migration v7 replaces the empty legacy Task table with immutable Tasks and adds runtime registration for assets. It records catalog fingerprint v2, which treats the dense order of live columns as schema identity so PostgreSQL dump and restore can compact dropped-column storage gaps without causing false schema-drift failures.

Migration v8 (`retired_asset_runtime_generations`) adds `asset_runtime_generations` with `asset_id VARCHAR(50)`, `runtime_id VARCHAR(255)`, an identity `generation BIGINT`, and a `stopped BOOLEAN NOT NULL DEFAULT FALSE` flag. The table has a composite primary key on `(asset_id, runtime_id)`, unique constraints on `runtime_id` and `(asset_id, generation)`, and is populated from the existing `asset_runtimes` rows. It also adds `asset_runtimes.stopped`, `tasks.completion_attempt`, and a foreign key from the current runtime to its generation history.

Migration v9 (`immutable_resource_instance_tokens`) adds `resource_instance_tokens`, whose `token_hash VARCHAR(64)` is the primary key and whose `created_at` defaults to `clock_timestamp()`, with a length check on the hash. It adds nullable `instance_token_hash VARCHAR(64)` columns to `entities` and `objects`, each constrained to either NULL or a 64-character hash. These hashes provide one-time capabilities for recovering a create response without storing the raw token.

Inspect the current production version with:

```bash
cd services/core/docker
docker compose -f docker-compose.production.yml exec -T \
  -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
  psql -U atlas -d atlas_core \
  -c 'SELECT version, name, checksum, fingerprint_version, schema_fingerprint, applied_at FROM atlas_schema_migrations ORDER BY version;'
```

## Making a schema change

1. Update the corresponding Go model/query behavior.
2. Append one focused `schemaMigration` to `coreSchemaMigrations()` in `internal/database/migrations.go`. Never rewrite an applied migration.
3. Put only the DDL/data transformation required for that version in its ordered statement list.
4. If the migration adds a new disposable resource table, add it to `scratchDataResetDDL()` so development scratch mode clears its rows without erasing schema history.
5. Run the migration-definition test once; it reports the calculated checksum for a new migration. Freeze that value in code.
6. Add a live PostgreSQL test for the upgrade and its failure/rollback boundary.
7. Update schema/API/operator documentation in the same change.

Example shape:

```go
{
    version: 5,
    name: "add_entity_priority",
    checksum: "<frozen sha256>",
    fingerprintVersion: fingerprintVersionV2,
    statements: []string{
        `ALTER TABLE entities ADD COLUMN priority INTEGER`,
        `CREATE INDEX idx_entities_priority ON entities(priority)`,
    },
},
```

Do not edit an existing fingerprint algorithm. If drift coverage itself changes, add a new algorithm version and have a new migration record that version after verifying the prior row with its original algorithm.

Validate from `services/core/`:

```bash
go test -count=1 ./internal/database
go test ./...
```

The database integration tests use isolated PostgreSQL schemas. With `ATLAS_CORE_REQUIRE_LIVE_TESTS=1`, missing database dependencies fail instead of skipping.

## Development scratch workflow

The development Compose project is `atlas_core_development`; its containers and named volumes are isolated from the `atlas_core_production` project. The development Compose file sets `DATABASE_RECREATE_ON_STARTUP=true`. An ordinary API restart first migrates/verifies the schema, then clears disposable resource rows and the durable change log, resets `atlas_change_clock`, and empties the configured MinIO bucket (`MINIO_BUCKET`, default `atlas-media`) while retaining local `admin_records` and the migration ledger. The embedded catalog remains available through `GET /command-catalog` without seeding storage.

```bash
python3 services/core/scripts/atlas.py --dev
```

To remove every development volume, including `admin_records`, use the explicitly destructive reset:

```bash
cd services/core/docker
docker compose down -v --remove-orphans
```

Never use scratch mode or `down -v` for production recovery.

## Failure handling

- `invalid schema migration history`: the ledger is gapped, unknown, ahead of this binary, or an applied migration definition changed. Stop; do not edit the ledger by hand.
- `schema drift detected`: the Atlas-owned catalog differs from the latest recorded fingerprint. Stop; compare against the deployed migration and restore a known-good paired backup if needed.
- `failed to apply schema migration`: the transaction rolled back. Confirm the previous version and catalog are intact before restarting a compatible durable image. Migration v1 is the rollback floor; the inaugural cutover must fix forward rather than boot the older destructive runtime.
- durable MinIO initialization failure: restore storage availability before starting Core; do not bypass it while object metadata exists.

The full backup, restore, and rollback sequence is in [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md).
