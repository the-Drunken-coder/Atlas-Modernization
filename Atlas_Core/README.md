# ATLAS Core

Go-based control-plane service for Atlas entities, tasks, objects, and query snapshots.

PostgreSQL and MinIO are **disposable runtime storage** for Atlas Core. They are
not systems of record, and operators should not expect rows or blobs to survive
service restarts. The default startup path recreates the database schema and
clears the configured object bucket so local runtime state always matches the
current code.

## Stack

- Go 1.26.1+
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
cd Atlas_Core/scripts
python3 atlas.py
```

or:

```bash
cd Atlas_Core/docker
docker compose up -d
```

The Compose stack builds the development image and bind-mounts
`atlas_core.settings.json.example`, which intentionally keeps API auth disabled
for loopback-only local development. The production Docker target does not ship
that settings file and refuses to start unless `ENABLE_API_AUTH=true` and
`API_AUTH_KEY` is set to a real, non-placeholder secret.

### Local Go Run

With Postgres and MinIO already reachable (e.g. after `docker compose up -d` without the `api` service, or with API stopped to avoid port 8000 conflict), from `Atlas_Core/`: ensure `DATABASE_URL` points at your DB and `MINIO_SECRET_KEY` / `MINIO_ACCESS_KEY` match your MinIO credentials (defaults in `internal/config/config.go` assume `localhost:9000` and access key `atlas`).

```bash
cd Atlas_Core
go run ./cmd/atlas_core
```

### Build

```bash
cd Atlas_Core
go build -o atlas_core ./cmd/atlas_core
```

### Verify

```bash
curl http://localhost:8000/health
curl http://localhost:8000/readiness
```

## Tests and Quality

```bash
cd Atlas_Core
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
- `DEBUG` (default `false`)
- `DATABASE_URL` (default `postgres://atlas@localhost:5432/atlas_core`)
- `DATABASE_RECREATE_ON_STARTUP` (default `true`; keep true for the intended disposable runtime-store workflow)
- `DATABASE_ECHO` (default `false`)
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
- `MINIO_HTTP_POOL_SIZE` (default `10`)
- `MINIO_HTTP_POOL_TIMEOUT` (default `30`)
- `CORS_ORIGINS` or `ALLOWED_ORIGINS` (legacy alias; empty string denies all origins)
- `ENABLE_API_AUTH` (default `false` for local/dev runs; required as `true` in the production Docker image)
- `API_AUTH_KEY` (required when auth enabled; required and non-placeholder in the production Docker image)
- `MAX_UPLOAD_SIZE_MB` (default `100`)
- `MAX_VIEW_SIZE_MB` (default `10`)

## API Surface

### Health

- `GET /`
- `GET /health`
- `GET /readiness`

### Entities

- `GET /entities`
- `POST /entities`
- `GET /entities/{entity_id}`
- `PATCH /entities/{entity_id}`
- `DELETE /entities/{entity_id}`
- `GET /entities/alias/{alias}`
- `PATCH /entities/{entity_id}/telemetry`
- `POST /entities/{entity_id}/checkin`
- `GET /entities/{entity_id}/tasks`
- `GET /entities/{entity_id}/objects`

### Tasks

- `GET /tasks`
- `POST /tasks`
- `GET /tasks/{task_id}`
- `PATCH /tasks/{task_id}`
- `DELETE /tasks/{task_id}`
- `POST /tasks/{task_id}/acknowledge`
- `POST /tasks/{task_id}/complete`
- `POST /tasks/{task_id}/fail`
- `POST /tasks/{task_id}/status`
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

### Queries

- `GET /queries/full`
- `GET /queries/changed-since?since_version=<version>`

Query params (optional): `entity_limit`, `task_limit`, `object_limit`, `limit_per_type` (changed-since), and cursor params `entity_cursor`, `task_cursor`, `object_cursor`, `deleted_*_cursor` for pagination. `changed-since` returns a monotonic `version`; pass it back as `since_version` on the next poll. See `docs/PAGINATION.md`.

### Check-in query params

`POST /entities/{entity_id}/checkin` supports: `status_filter` (default `pending,acknowledged`), `limit` (1–20, default 10), `task_cursor`, `fields=minimal`, `since` (RFC3339).

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

Structured `zerolog` logs include request method/path/status/duration and error identifiers
(`error_id`).

## More Docs

- `docs/README.md`
- `docs/PAGINATION.md`
- `docs/ERROR_HANDLING.md`
- `docs/SECURITY.md`
