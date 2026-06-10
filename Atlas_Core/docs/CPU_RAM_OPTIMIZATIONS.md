# CPU and RAM Optimizations (Go Service)

_Revision: 2026-06-10_

This document reflects the current Go implementation. Earlier Python-specific notes are no longer
applicable to this repository layout.

## Implemented Safeguards

### 1. Bounded request sizes

HTTP handlers enforce body limits with `http.MaxBytesReader`:

- 1 MB: entity create/update and object metadata create/update
- 256 KB: telemetry updates and check-ins
- 512 KB: task create/update/status/complete/fail
- Upload body: bounded by configurable `MAX_UPLOAD_SIZE_MB` (default 100 MB, capped at 10 GB)
- Inline view: bounded by configurable `MAX_VIEW_SIZE_MB` (default 10 MB, capped at 100 MB)

Implementation:

- `internal/api/handlers/handler_entity.go`
- `internal/api/handlers/handler_task.go`
- `internal/api/handlers/handler_object.go`
- `internal/api/handlers/handler_object_transfer.go`
- `internal/config/config.go`

### 2. Bounded pagination and query fan-out

List actions clamp pagination:

- default limit: `100`
- hard max limit: `500`
- HTTP list handlers reject negative limits and any offset parameter with 400 Bad Request (`parseListPagination` / `parseNonNegativeIntQuery`)
- returned limit is clamped via `actions.ClampListLimit` before list queries run

Full dataset query also has an upper bound:

- `MaxFullQueryLimit = 1000` rows per resource type

Implementation:

- `internal/actions/pagination.go`
- `internal/actions/entityactions/entityactions.go`
- `internal/actions/taskactions/list.go`
- `internal/actions/objectactions/references.go`
- `internal/actions/syncactions/syncactions.go`

### 3. Database connection pool controls

The pgx pool is explicitly configured for long-running service behavior:

- connection counts derived from `DATABASE_POOL_SIZE + DATABASE_MAX_OVERFLOW` (capped)
- max connection lifetime via `DATABASE_POOL_RECYCLE`
- max idle time via `DATABASE_POOL_IDLE_TIMEOUT`
- periodic health checks when `DATABASE_POOL_PRE_PING=true`

Implementation:

- `internal/database/db.go`
- `internal/config/config.go`

### 4. Streaming object download path

Download responses stream from storage reader to HTTP response writer using `io.Copy`, avoiding
full buffering for download endpoints. Inline view endpoints intentionally read fully into memory,
but only after max-size checks.

Implementation:

- `internal/api/handlers/handler_object_transfer.go`

### 5. Multipart upload memory control

Multipart parsing uses a fixed 32 MB in-memory threshold (`ParseMultipartForm`), with overflow
spilled to temporary files by the standard library.

Implementation:

- `internal/api/handlers/handler_object_transfer.go`

## Tunable Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_POOL_SIZE` | `5` | Base DB connection pool size |
| `DATABASE_MAX_OVERFLOW` | `10` | Extra transient DB connections |
| `DATABASE_POOL_RECYCLE` | `3600` | Max connection lifetime (seconds) |
| `DATABASE_POOL_IDLE_TIMEOUT` | `600` | Max idle connection time (seconds) |
| `DATABASE_POOL_PRE_PING` | `true` | Enable periodic pool health checks |
| `MAX_UPLOAD_SIZE_MB` | `100` | Upload request size limit |
| `MAX_VIEW_SIZE_MB` | `10` | Inline object view size limit |

## Verification Checklist

- Monitor RSS over sustained traffic and idle windows.
- Verify DB pool counts remain within configured limits.
- Confirm 413/400 behavior for oversized request bodies.
- Validate full-dataset endpoint behavior on large datasets (cap at 1000 per type).
