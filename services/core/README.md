# ATLAS Core

Go-based control-plane service for Atlas entities, tasks, objects, and query snapshots.

Production resource tables, `admin_records`, migration history, and the
configured MinIO bucket are durable. Startup applies ordered PostgreSQL
migrations, rejects migration/catalog drift, and preserves rows and blobs.
Development Compose explicitly enables scratch mode, which migrates/verifies
the schema, clears resource rows and the bucket, and preserves local
`admin_records` plus migration history. Core validates its embedded command
catalog and serves it directly at `GET /command-catalog` without storing it as an object.

## Stack

- Go 1.26 with the pinned `go1.26.5` toolchain
- Chi router
- PostgreSQL 15+ (the Docker dev stack uses plain Postgres; the app schema is plain tables)
- MinIO (S3-compatible) for object storage

## Quick Start

Set credentials before starting services (Compose requires `MINIO_ROOT_PASSWORD`; the API uses `DATABASE_URL` and MinIO keys from env or `atlas_core.settings.json`).

**Example (bash):**

```bash
export MINIO_ROOT_PASSWORD='your-minio-secret'
export POSTGRES_PASSWORD='atlas'   # recommended; atlas.py generates a random password if unset
export DATABASE_URL='postgres://atlas:atlas@localhost:5432/atlas_core'
export MINIO_ACCESS_KEY='atlas'
export MINIO_SECRET_KEY="$MINIO_ROOT_PASSWORD"
```

**PowerShell:**

```powershell
$env:MINIO_ROOT_PASSWORD = "your-minio-secret"
$env:POSTGRES_PASSWORD = "atlas"   # recommended; atlas.py generates a random password if unset
$env:DATABASE_URL = "postgres://atlas:atlas@localhost:5432/atlas_core"
$env:MINIO_ACCESS_KEY = "atlas"
$env:MINIO_SECRET_KEY = $env:MINIO_ROOT_PASSWORD
```

See `docker/.env.example` for a copy-paste template. For anonymous download on the dev bucket (not recommended on untrusted networks), set `ENABLE_PUBLIC_MINIO=true` when starting Compose.

### Docker

```bash
python3 services/core/scripts/atlas.py --dev
```

The development launcher enables API-key authentication, generates or reuses a
strong local machine key and admin password, and persists both with owner-only
permissions in `services/core/docker/.env.local`. Local server-side tools such as Atlas
Simulations use that file as the single source of local credentials. The
launcher never prints either secret. Browser sessions continue to use the
`admin` account; its password is the `ATLAS_ADMIN_PASSWORD` stored in that file.
Production and tunnel startup never load `.env.local`. The production launcher
requires its operator-owned credentials in the process environment before it
reads `docker/.env`; tunnel development and manual Compose runs may use
`docker/.env`.

For manual Compose configuration:

```bash
cd services/core/docker
docker compose up -d
```

The Compose stack builds the development image and bind-mounts
`atlas_core.settings.json.example`. Raw Compose uses the values in
`services/core/docker/.env`; copy `.env.example` and set `ENABLE_API_AUTH=true`
plus a strong `API_AUTH_KEY` when machine clients need access. The production
Docker target does not ship that settings file. The bundled production Compose
stack refuses to start unless `ENABLE_API_AUTH=true`,
`API_AUTH_KEY` is set to a strong, non-placeholder bootstrap secret,
`ATLAS_ADMIN_PASSWORD` replaces the development admin password, and
`DATABASE_RECREATE_ON_STARTUP` is not enabled. Browser admins
can create additional managed machine keys after sign-in.

Development Compose starts the private Source Gateway with an empty base connector configuration. Plugin containers
and both fragment directories are added by Plugin-owned Compose overlays such as `plugins/reference/compose.yml`.
With that development-only overlay applied, `GET /plugins` reports the query-only `reference` Plugin and
`inspect_fixture` accepts `{"key":"alpha"}` or `{"key":"bravo"}`. The production base topology also starts without
configured Plugins or connectors.

The bundled production Compose stack accepts only `ATLAS_ADMIN_PASSWORD`
because it does not mount an operator password file. Direct Core processes and
custom raw-container deployments may still use `ATLAS_ADMIN_PASSWORD_FILE`
when that path is explicitly mounted and readable inside the process.

For the production-image single-host stack:

The published `atlas-core` npm CLI is the simplest path for a new single-host
deployment. It generates owner-only credentials, proves that no prior Atlas
volumes exist, provisions the initial MinIO bucket, and keeps later starts in
durable mode:

```bash
npm install --global atlas-core
atlas-core init
atlas-core start
```

The CLI binds Core and its storage services to loopback in its first release.
Use the manual production flow below for existing storage, custom ingress, or a
deployment that does not fit the packaged topology.

```bash
umask 077
set -a
. /secure/path/atlas-production.env
set +a
export MINIO_BUCKET="${MINIO_BUCKET:-atlas-media}"
```

The owner-readable environment file must define `POSTGRES_PASSWORD`,
`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `API_AUTH_KEY`, and
`ATLAS_ADMIN_PASSWORD`; the admin password must contain at least 12 characters.
The manual production Compose files use the fixed external volumes
`atlas_core_production_postgres_data` and `atlas_core_production_minio_data`.
Before the first manual production start, choose one non-empty storage-set ID
for this deployment and explicitly create both volumes with that same label:

```bash
ATLAS_STORAGE_SET_ID='production-primary-2026-09'
docker volume create --label "io.atlas.core.storage-set=${ATLAS_STORAGE_SET_ID}" \
  atlas_core_production_postgres_data
docker volume create --label "io.atlas.core.storage-set=${ATLAS_STORAGE_SET_ID}" \
  atlas_core_production_minio_data
```

The launcher verifies that the required volume set exists and that both volumes
carry the same non-empty storage-set label before stopping or starting
containers. On a new MinIO volume, provision the configured durable bucket and
verify it exists; Core startup deliberately will not create it.
`MINIO_BUCKET` defaults to `atlas-media` when the operator file omits it.
The explicit `--production --db-only` mode deliberately checks the PostgreSQL
external volume and its storage-set identity, then starts only PostgreSQL; it
does not initialize or validate MinIO.

```bash
(
  set -e
  docker compose -f services/core/docker/docker-compose.production.yml up -d minio
  minio_mc_config="$(mktemp -d)"
  trap 'rm -rf -- "${minio_mc_config}"' EXIT
  mc --config-dir "${minio_mc_config}" alias set atlas_production http://127.0.0.1:9000 \
    "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
  mc --config-dir "${minio_mc_config}" mb "atlas_production/${MINIO_BUCKET}"
  mc --config-dir "${minio_mc_config}" stat "atlas_production/${MINIO_BUCKET}"
) || exit "$?"
python3 services/core/scripts/atlas.py --production
```

Passing credentials as separate quoted arguments keeps values containing URL-reserved
characters such as `/`, `?`, `#`, or `%` intact. The isolated temporary client
configuration is removed on success, failure, or interruption.

Add `--tunnel` to start the optional Cloudflare Tunnel public edge. See
[`docs/DEPLOYMENT_RUNBOOK.md`](docs/DEPLOYMENT_RUNBOOK.md) for the full operator
runbook.

### Local Go Run

With Postgres and MinIO already reachable (e.g. after `docker compose up -d` without the `api` service, or with API stopped to avoid port 8000 conflict), from `services/core/`: ensure `DATABASE_URL` points at your DB and `MINIO_SECRET_KEY` / `MINIO_ACCESS_KEY` match your MinIO credentials (defaults in `internal/config/config.go` assume `localhost:9000` and access key `atlas`).

```bash
cd services/core
go run ./cmd/atlas_core
```

Run the Source Gateway separately with a deployment-owned base settings file and optional connector-fragment directory:

```bash
ATLAS_SOURCE_GATEWAY_CONFIG=docker/source_gateway.development.json \
  ATLAS_SOURCE_CONNECTOR_CONFIG_DIR=/path/to/connector-fragments \
  go run ./cmd/atlas_source_gateway
```

See [`docs/SOURCE_GATEWAY.md`](docs/SOURCE_GATEWAY.md) for its strict
configuration contract and defaults.

### Build

```bash
cd services/core
go build -o atlas_core ./cmd/atlas_core
```

### Verify

```bash
curl http://localhost:8000/health
curl http://localhost:8000/readiness
```

## Tests and Quality

```bash
cd services/core
go test ./...
go fmt ./...
go vet ./...
```

## Configuration

Configuration is loaded from environment variables plus optional `atlas_core.settings.json`.
Environment values take precedence.

Key environment variables:

- `SERVER_PORT` (default `8000`)
- `LOG_LEVEL` (default `INFO`)
- `DATABASE_URL` (default `postgres://atlas@localhost:5432/atlas_core`)
- `DATABASE_RECREATE_ON_STARTUP` (default `false`; development Compose explicitly sets `true` for scratch resets, and the production image rejects `true`)
- `DATABASE_POOL_SIZE` (default `5`)
- `DATABASE_MAX_OVERFLOW` (default `10`)
- `DATABASE_POOL_RECYCLE` (default `3600`)
- `DATABASE_POOL_TIMEOUT` (default `30`)
- `DATABASE_POOL_IDLE_TIMEOUT` (default `600`)
- `DATABASE_POOL_PRE_PING` (default `true`)
- `MINIO_ENDPOINT` (default `localhost:9000`)
- `MINIO_ACCESS_KEY` (default `atlas`)
- `MINIO_SECRET_KEY` or `MINIO_SECRET_KEY_FILE`
- `MINIO_BUCKET` (default `atlas-media`)
- `MINIO_SECURE` (default `false`)
- `MINIO_REGION` (optional)
- `CORS_ORIGINS` (empty string denies all origins; production UI default is `https://atlasinterface.com`)
- `CORS_ORIGIN_PATTERNS` (constrained preview origins such as Cloudflare Pages branch/PR deployments, for example `https://*.atlas-je0.pages.dev`)
- `TRUSTED_PROXY_CIDRS` (comma-separated exact reverse-proxy `/32` or `/128` peers; default empty, so forwarded client-IP headers are ignored)
- `ENABLE_API_AUTH` (Core default `false`; `atlas.py --dev` sets `true`; required as `true` in the production Docker image)
- `API_AUTH_KEY` (required bootstrap key when auth enabled; required, strong, and non-placeholder in the production Docker image)
- `MAX_UPLOAD_SIZE_MB` (default `100`, must be `1..10240`)
- `MAX_VIEW_SIZE_MB` (default `10`, must be `1..100`)
- `ATLAS_PLUGIN_CONFIG_DIR` (optional directory of strict `*.json` Plugin endpoint fragments; each file contains one `id` and private `base_url`)
- `ATLAS_SOURCE_CONNECTOR_CONFIG_DIR` (Source Gateway directory of strict `*.json` connector fragments, loaded with the base settings file)

Both fragment directories are read in sorted filename order. Unknown fields, invalid files, duplicate IDs, or a partially
configured fragment fail startup. Plugin folders own their endpoint and connector fragments; shared Core settings do not
contain a Plugin registry.

## API Surface

### Health

- `GET /`
- `GET /health`
- `GET /readiness`
- `GET /resources`

### Entities

- `GET /entities`
- `POST /entities`
- `GET /entities/{entity_id}`
- `PATCH /entities/{entity_id}`
- `DELETE /entities/{entity_id}`
- `GET /entities/alias/{alias}`
- `POST /entities/{entity_id}/checkin`
- `POST /entities/{entity_id}/runtime`
- `POST /entities/{entity_id}/runtime/stop`
- `POST /entities/{entity_id}/runtime/ready`
- `GET /entities/{entity_id}/runtime/tasks`
- `GET /entities/{entity_id}/tasks`
- `GET /entities/{entity_id}/objects`

### Tasks

- `GET /tasks`
- `POST /tasks`
- `GET /tasks/{task_id}`
- `POST /tasks/{task_id}/acknowledge`
- `POST /tasks/{task_id}/start`
- `POST /tasks/{task_id}/progress`
- `POST /tasks/{task_id}/complete`
- `POST /tasks/{task_id}/fail`
- `POST /tasks/{task_id}/cancel`
- `GET /tasks/{task_id}/objects`

### Objects

- `GET /objects`
- `POST /objects`
- `POST /objects/upload`
- `GET /objects/{object_id}`
- `PATCH /objects/{object_id}`
- `DELETE /objects/{object_id}`
- `GET /objects/{object_id}/download`
- `GET /objects/{object_id}/view`

`POST /objects` and `PATCH /objects/{object_id}` manage descriptive metadata only. Blob facts (`path`, `content_type`, `size_bytes`, and `bucket`) are storage-owned and are set only by `POST /objects/upload`.

### Queries

- `GET /queries/full`
- `GET /queries/changed-since?since_version=<version>`
- `GET /command-catalog`

### Plugins

- `GET /plugins`
- `POST /plugins/{plugin_id}/operations/{operation_id}`

Core owns discovery, health monitoring, dispatch, request bounds, cancellation,
and public error mapping. Plugin failure does not affect Core liveness or
readiness. See [`../../docs/atlas-plugins/README.md`](../../docs/atlas-plugins/README.md).

`full` accepts per-resource limits and cursors and returns one stable pre-hydration `version` across all continuation pages. After consuming them, drain `changed-since` from that baseline instead of deriving a cursor from resource metadata. `changed-since` accepts `limit` plus one opaque `cursor` and returns globally ordered feed events with a monotonic `version`; pass it back as `since_version` on the next poll. See `docs/PAGINATION.md`.

### Check-in

`POST /entities/{entity_id}/checkin` reports telemetry and observed state and supports `fields=minimal`. Its optional body is the Protocol `EntityCheckInRequest`; an empty body is `{}`. Malformed JSON returns `INVALID_JSON`, while unknown fields, invalid ranges, and invalid components return `VALIDATION_ERROR` before the Entity write. Task delivery is handled through the runtime registration and delivery routes.

## Pagination and Limits

List endpoints use `limit` and opaque `cursor` query params with defaults and clamping in the action layer. `offset` is rejected with `400 VALIDATION_ERROR`.
Pagination metadata is returned in headers:

- `X-Limit`
- `X-Returned-Count`
- `X-Has-More`
- `X-Next-Cursor` (only when another page exists)

Object reference links are stored in object metadata (`referenced_by`) via `POST /objects` and
`PATCH /objects/{object_id}`. There is no `/objects/{object_id}/references` route in the current
Go service.

## Logging

Structured `zerolog` logs include `request_id` correlation plus request
method/path/status/duration and handler error identifiers (`error_id`). Handler
error-envelope 4xx diagnostics use warning severity; 5xx error envelopes and
panic recovery use error severity.

## More Docs

- `docs/README.md`
- `docs/API_GUIDE.md`
- `docs/PAGINATION.md`
- `docs/ERROR_HANDLING.md`
- `docs/SECURITY.md`
