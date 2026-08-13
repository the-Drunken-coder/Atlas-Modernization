# Atlas Core Deployment Runbook

Atlas Core uses a single-host deployment: Docker Compose runs the Core API, PostgreSQL, and MinIO, and an optional Cloudflare Tunnel provides the public HTTPS edge.

Production storage is durable. The production Compose files use the isolated `atlas_core_production` project; development uses `atlas_core_development`. Ordinary starts, restarts, and `docker compose down` preserve PostgreSQL rows, `admin_records`, migration history, and MinIO objects. PostgreSQL and MinIO are one logical store and must be backed up and restored as a matched pair.

## Local development

From the repository root:

```bash
python3 atlas_core/scripts/atlas.py --dev
```

Development Compose explicitly sets `DATABASE_RECREATE_ON_STARTUP=true`: each API startup migrates/verifies the schema, clears disposable resource rows and the durable change log, empties the configured bucket, resets the change clock, and preserves local `admin_records` plus migration history. Core serves its embedded catalog directly at `GET /command-catalog`; no catalog object is seeded.

## Production configuration

Load runtime credentials from an operator-owned file with mode `0600`:

```bash
umask 077
set -a
. /secure/path/atlas-production.env
set +a
export MINIO_BUCKET="${MINIO_BUCKET:-atlas-media}"
```

The file must define `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`,
`MINIO_ROOT_PASSWORD`, `API_AUTH_KEY`, and `ATLAS_ADMIN_PASSWORD`.
`ATLAS_ADMIN_PASSWORD` must contain at least 12 characters.

External secrets are not stored in `admin_records` and are not recovered by a database restore. Back up the operator secret source separately.

For the first deployment onto a new MinIO volume, start MinIO and explicitly
provision the durable bucket with a host-installed MinIO client:

```bash
(
  set -e
  docker compose -f atlas_core/docker/docker-compose.production.yml up -d minio
  minio_mc_config="$(mktemp -d)"
  trap 'rm -rf -- "${minio_mc_config}"' EXIT
  mc --config-dir "${minio_mc_config}" alias set atlas_production http://127.0.0.1:9000 \
    "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
  mc --config-dir "${minio_mc_config}" mb "atlas_production/${MINIO_BUCKET}"
  mc --config-dir "${minio_mc_config}" stat "atlas_production/${MINIO_BUCKET}"
) || exit "$?"
```

The separate quoted credential arguments remain valid when values contain
URL-reserved characters such as `/`, `?`, `#`, or `%`. The subshell's isolated
temporary client configuration is removed on success, failure, or interruption.

For a restore onto a replacement volume, follow [Restore a backup
set](#restore-a-backup-set): create the bucket only as the mirror target, restore
the MinIO backup paired with PostgreSQL, and verify it before starting Core.
Never start Core with a merely provisioned empty bucket against a restored
database. Production startup only verifies the bucket so a missing blob store
cannot be silently replaced with an empty one.

Then start the production stack:

```bash
python3 atlas_core/scripts/atlas.py --production
```

Production Compose sets `DATABASE_RECREATE_ON_STARTUP=false`. The bundled
launcher requires `ATLAS_ADMIN_PASSWORD` and refuses to invoke Docker when only
`ATLAS_ADMIN_PASSWORD_FILE` is configured because the Compose stack mounts no
password file. The production image also refuses to start if destructive mode
is enabled, API auth is disabled, or the bootstrap API key is
missing/placeholder. Direct Core processes and custom raw-container deployments
may retain `ATLAS_ADMIN_PASSWORD_FILE` when they explicitly mount that path.

This uses `atlas_core/docker/docker-compose.production.yml`, builds the
Dockerfile `production` target, omits development bind mounts and settings
files, binds the API to `127.0.0.1:8000`, and requires API-key auth for API
routes. `API_AUTH_KEY` is the required strong bootstrap machine key; browser
admins can create additional managed machine keys after sign-in. Health,
readiness, and the `/feed` middleware bypass remain outside protected-route
middleware; the feed handler performs its own API-key or browser-session
authentication. The host/process `/resources` diagnostic requires a protected
API key or admin session.

For a public edge, add the tunnel values and start the same production stack with its tunnel profile:

```bash
export CLOUDFLARE_TUNNEL_TOKEN='replace-with-cloudflare-token'
export ATLAS_TUNNEL_HOSTNAME='atlascommandapi.org'
python3 atlas_core/scripts/atlas.py --production --tunnel
```

`ATLAS_TUNNEL_HOSTNAME` defaults to `atlascommandapi.org`. The tunnel container
forwards traffic to `http://api:8000` over a dedicated `172.30.0.0/29` ingress
bridge shared only with Core. Compose pins Core to `172.30.0.2`, pins
`cloudflared` to `172.30.0.3`, and configures Core to trust only the tunnel
peer's `172.30.0.3/32` client-IP headers. Direct clients remain keyed by their
socket address and cannot spoof `CF-Connecting-IP` or `X-Forwarded-For`.
For the browser interface, `api.atlasinterface.com` is the default Core URL and
points at the same tunnel service as `atlascommandapi.org`.

`atlas.py` recreates the Compose containers and networks during a managed
restart. When upgrading a host with direct Compose commands, run the documented
`down --remove-orphans` command with both Compose files before starting the
tunnel so Docker can create the dedicated ingress bridge. If `172.30.0.0/29`
conflicts with a host
route, change the subnet, the two static service addresses, and
`TRUSTED_PROXY_CIDRS` together; the trusted value must remain the exact
`cloudflared` `/32`.

For a non-Compose reverse proxy, leave `TRUSTED_PROXY_CIDRS` empty unless Core's
socket peer is that proxy. Then configure only the exact peer `/32` or `/128`.
The proxy must overwrite `CF-Connecting-IP`, or remove it and append its
observed client to `X-Forwarded-For`; passing client-supplied values through is
unsafe.
Never use Cloudflare's public edge ranges for Tunnel: Core connects to the local
`cloudflared` process, not directly to the edge.

The production Core environment should allow the Pages origins that can call
cookie-authenticated admin/resource routes:

```bash
CORS_ORIGINS=https://atlasinterface.com
CORS_ORIGIN_PATTERNS=https://*.atlas-je0.pages.dev
```

## Readiness Policy

Use `/health` for process liveness and `/readiness` for traffic admission:

- HTTP `200` with `healthy` means the database and configured MinIO bucket are reachable.
- HTTP `200` with `degraded` is reserved for an intentionally storage-unconfigured local or DB-only process.
- HTTP `503` with `unhealthy` means the database is unavailable or configured storage could not be initialized, reached, or verified. A missing configured bucket is also unhealthy because object operations cannot succeed.

Do not route production traffic while readiness is `503`. Inspect the API and MinIO logs, confirm `MINIO_ENDPOINT`, credentials, network reachability, and `MINIO_BUCKET`, then restore MinIO or its bucket. Readiness returns to `200` after the configured bucket check succeeds. In recreate mode, a storage failure during bucket clearing remains startup-fatal so an empty database is never served alongside stale blobs.

## Pre-deploy backup

Back up before every binary/image change that may carry a migration. Run the examples from the repository root. They assume a host-installed MinIO client (`mc`) and an operator-owned backup root outside Docker volumes.

1. Create one backup-set identifier and record the application/schema versions:

```bash
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)" || exit 1
export BACKUP_DIR="/srv/atlas-backups/${BACKUP_ID}"
export BACKUP_ID
umask 077
mkdir -p "${BACKUP_DIR}/minio" || exit 1
chmod 0700 "${BACKUP_DIR}" || exit 1
git rev-parse HEAD >"${BACKUP_DIR}/app-revision.txt" || exit 1

migration_table_present="$(
  docker compose -f atlas_core/docker/docker-compose.production.yml exec -T \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    psql -At -U atlas -d atlas_core \
    -c "SELECT to_regclass('atlas_schema_migrations') IS NOT NULL"
)" || { printf '%s\n' 'Failed to inspect schema migration state' >&2; exit 1; }
case "${migration_table_present}" in
  t)
    docker compose -f atlas_core/docker/docker-compose.production.yml exec -T \
      -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
      psql -At -U atlas -d atlas_core \
      -c "SELECT concat_ws(' ', version, name, checksum, fingerprint_version) FROM atlas_schema_migrations ORDER BY version" \
      >"${BACKUP_DIR}/schema-migrations.txt" || {
        printf '%s\n' 'Failed to record schema migration state' >&2
        exit 1
      }
    ;;
  f)
    printf '%s\n' 'unversioned-v1-candidate' >"${BACKUP_DIR}/schema-migrations.txt" || exit 1
    ;;
  *)
    printf 'Unexpected migration-table probe result: %s\n' "${migration_table_present}" >&2
    exit 1
    ;;
esac
```

2. Quiesce all writes by stopping Core. Leave PostgreSQL and MinIO running:

```bash
(
  set -e
  docker compose -f atlas_core/docker/docker-compose.production.yml stop api
) || exit "$?"
```

3. Create a full custom-format database dump:

```bash
(
  set -e
  docker compose -f atlas_core/docker/docker-compose.production.yml exec -T \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    pg_dump -U atlas -d atlas_core --format=custom --no-owner --no-privileges \
    >"${BACKUP_DIR}/postgres.dump"
  docker compose -f atlas_core/docker/docker-compose.production.yml exec -T postgres \
    pg_restore --list <"${BACKUP_DIR}/postgres.dump" \
    >"${BACKUP_DIR}/postgres.contents.txt"
) || exit "$?"
```

Every current full dump must contain resource tables, `atlas_change_clock`, `atlas_change_events`, `object_deletion_fences`, `storage_deletion_outbox`, `storage_upload_intents`, and every `admin_records` row (accounts, sessions, login throttles, and managed API-key hashes/metadata), plus `atlas_schema_migrations`. The inaugural pre-cutover backup is expected to use the legacy v1 schema and is marked `unversioned-v1-candidate` instead.

4. Mirror the entire configured bucket into the same backup set:

```bash
(
  set -e
  rm -f -- "${BACKUP_DIR}/minio.complete"
  minio_mc_config="$(mktemp -d)"
  trap 'rm -rf -- "${minio_mc_config}"' EXIT
  mc --config-dir "${minio_mc_config}" alias set atlas_production http://127.0.0.1:9000 \
    "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
  mc --config-dir "${minio_mc_config}" mirror --overwrite "atlas_production/${MINIO_BUCKET}" \
    "${BACKUP_DIR}/minio/${MINIO_BUCKET}"
  mc --config-dir "${minio_mc_config}" ls --recursive "atlas_production/${MINIO_BUCKET}" \
    >"${BACKUP_DIR}/minio.contents.txt"
  printf '%s\n' "${MINIO_BUCKET}" >"${BACKUP_DIR}/minio.complete"
) || exit "$?"
```

5. Validate the pair before deploying:

```bash
(
  set -e
  test -s "${BACKUP_DIR}/postgres.dump"
  docker compose -f atlas_core/docker/docker-compose.production.yml exec -T postgres \
    pg_restore --list <"${BACKUP_DIR}/postgres.dump" >/dev/null
  test -d "${BACKUP_DIR}/minio/${MINIO_BUCKET}"
  test -f "${BACKUP_DIR}/minio.complete"
  test "$(cat "${BACKUP_DIR}/minio.complete")" = "${MINIO_BUCKET}"
) || exit "$?"
```

Keep the dump, bucket mirror, manifests, and revision files under the same `BACKUP_ID`. Never mix a database snapshot with a bucket snapshot from another time; object rows may otherwise reference missing or wrong bytes.

## Deploy and verify

Build/pull the intended revision, then start production from the repository root. Schema migration and catalog verification complete before readiness. Add `--tunnel` when the backed-up deployment used the tunnel profile:

```bash
python3 atlas_core/scripts/atlas.py --production
```

Verify:

```bash
curl -fsS http://127.0.0.1:8000/readiness

docker compose -f atlas_core/docker/docker-compose.production.yml exec -T \
  -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
  psql -U atlas -d atlas_core \
  -c 'SELECT version, name, checksum, fingerprint_version, schema_fingerprint, applied_at FROM atlas_schema_migrations ORDER BY version;'
```

Then confirm expected resource/admin counts, one browser-admin login or managed-key request, and one known object row/download pair. For the API smoke suite:

```bash
API_AUTH_KEY="${API_AUTH_KEY}" \
ATLAS_CORE_API_URL=http://127.0.0.1:8000 \
./atlas_core/scripts/run_integration_tests.sh
```

## Restore a backup set

Restoring is destructive to state created after the selected backup.

1. Identify the matching application revision, database dump, and bucket directory from one `BACKUP_ID`.
2. Before stopping or deleting anything, validate both backup artifacts. The database check also confirms that `postgres.dump` is a readable PostgreSQL custom archive:

```bash
(
  set -e
  test -s "${BACKUP_DIR}/postgres.dump"
  test -d "${BACKUP_DIR}/minio/${MINIO_BUCKET}"
  test -f "${BACKUP_DIR}/minio.complete"
  test "$(cat "${BACKUP_DIR}/minio.complete")" = "${MINIO_BUCKET}"
  docker compose -f atlas_core/docker/docker-compose.production.yml exec -T postgres \
    pg_restore --list <"${BACKUP_DIR}/postgres.dump" >/dev/null
) || exit "$?"
```

3. Restore the entire database:

```bash
(
  set -e
  docker compose -f atlas_core/docker/docker-compose.production.yml stop api

  docker compose -f atlas_core/docker/docker-compose.production.yml exec -T \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    dropdb -U atlas --if-exists atlas_core
  docker compose -f atlas_core/docker/docker-compose.production.yml exec -T \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    createdb -U atlas atlas_core
  docker compose -f atlas_core/docker/docker-compose.production.yml exec -T \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
    pg_restore -U atlas -d atlas_core --exit-on-error --no-owner --no-privileges \
    <"${BACKUP_DIR}/postgres.dump"
) || exit "$?"
```

4. Replace the configured bucket with the matching mirror:

```bash
(
  set -e
  docker compose -f atlas_core/docker/docker-compose.production.yml up -d minio
  minio_mc_config="$(mktemp -d)"
  trap 'rm -rf -- "${minio_mc_config}"' EXIT
  mc --config-dir "${minio_mc_config}" alias set atlas_production http://127.0.0.1:9000 \
    "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
  mc --config-dir "${minio_mc_config}" mb --ignore-existing "atlas_production/${MINIO_BUCKET}"
  mc --config-dir "${minio_mc_config}" rm --recursive --force "atlas_production/${MINIO_BUCKET}"
  mc --config-dir "${minio_mc_config}" mirror --overwrite --remove \
    "${BACKUP_DIR}/minio/${MINIO_BUCKET}" "atlas_production/${MINIO_BUCKET}"
  if ! minio_diff="$(mc --config-dir "${minio_mc_config}" diff \
    "${BACKUP_DIR}/minio/${MINIO_BUCKET}" "atlas_production/${MINIO_BUCKET}")"; then
    echo "MinIO restore verification failed" >&2
    exit 1
  fi
  test -z "${minio_diff}"
) || exit "$?"
```

5. Deploy a schema-compatible durable binary, start Core (including `--tunnel` when applicable), and verify migration version/checksums, readiness, resource/admin counts, admin login or managed-key behavior, and a known row/blob download. For backups created after the durable-storage cutover, this is normally the recorded application revision. For an inaugural `unversioned-v1-candidate` backup, use the durable v1 release so it can verify and adopt the baseline; never use the older destructive runtime.

## Rollback

- The release that introduces migration v1 is the durable rollback floor. During that inaugural cutover, never boot an older image or its old production Compose file against retained/restored state; it enables destructive startup. Restore the paired backup if needed, then fix forward with the durable v1 release or a hotfix based on it.
- For later upgrades, if a migration fails before commit, Atlas rolls back its DDL and version record in the same transaction and never modifies MinIO. Verify the previous migration version and representative data, then restart the previous **durable** image.
- If a later migration committed, the new binary served traffic, or state is uncertain, stop Core and restore both PostgreSQL and MinIO from the paired pre-deploy backup before starting the previous compatible durable image.
- Do not delete migration rows, edit checksums/fingerprints, or attempt ad hoc down-migration DDL.

## Logs and shutdown

Core accepts an existing `X-Request-ID` and includes it as `request_id` on structured request and request-scoped error logs; otherwise it generates one. Handler error-envelope 4xx diagnostics use warning severity, while 5xx error envelopes and panic recovery use error severity. Readiness dependency warnings remain warning-level probe diagnostics even when readiness is `503`. Use `request_id` to follow one request across access and failure records; `error_id` identifies one handler error response.

Production logs:

```bash
docker compose -f atlas_core/docker/docker-compose.production.yml logs -f api postgres minio
```

Production tunnel logs:

```bash
docker compose -f atlas_core/docker/docker-compose.production.yml \
  -f atlas_core/docker/docker-compose.tunnel.yml logs -f api cloudflared
```

Stop containers without deleting volumes:

```bash
docker compose -f atlas_core/docker/docker-compose.production.yml down --remove-orphans
```

Stop a production tunnel deployment and remove its dedicated ingress network:

```bash
docker compose -f atlas_core/docker/docker-compose.production.yml \
  -f atlas_core/docker/docker-compose.tunnel.yml down --remove-orphans
```

`down` preserves named volumes. The following command destroys the production database, all `admin_records`, migration history, and the MinIO bucket volume; it is not a rollback mechanism:

```bash
docker compose -f atlas_core/docker/docker-compose.production.yml down -v --remove-orphans
```
