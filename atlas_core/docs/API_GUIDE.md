# Atlas Core API Guide

_Revision: 2026-07-10_

This is the quick-reference guide for calling the Atlas Core HTTP API. The default local base URL is:

```text
http://localhost:8000
```

The canonical resource and wire schemas live in Atlas Protocol. Use this guide for route behavior, then use `../../atlas_protocol/examples/` and `../../atlas_protocol/schema/jsonschema/atlas.schema.json` for exact payload examples and schema details.

Atlas Core preserves resource tables, `admin_records`, schema migration history, and the configured MinIO bucket in production. Startup applies verified transactional migrations and fails on ledger/catalog drift. Development Compose separately enables an explicit scratch reset that clears resource rows and MinIO while preserving the verified schema, migration history, and local `admin_records`.

## Common Rules

### Authentication

Protected Core routes accept the Core-owned browser session cookie. Local browser development uses the seeded admin session. The default `atlas.py --dev` launcher enables API-key auth and stores its generated machine key in the owner-only `atlas_core/docker/.env.local`; local server-side clients can use that bootstrap key. Manually configured machine clients should set `ENABLE_API_AUTH=true` and send either the bootstrap `API_AUTH_KEY` or an active managed API key with one of:

```text
X-API-Key: <api-key>
Authorization: Bearer <api-key>
```

`GET /health`, `GET /readiness`, `OPTIONS`, and `POST /admin/auth/login` are the public HTTP exceptions. `GET /resources` is an operator diagnostic and requires the same protected-route API-key or admin-session authentication as resource data routes.

The `/feed` websocket accepts either an API key on the upgrade request or the browser session cookie from a trusted origin. Machine clients that cannot set websocket headers can authenticate with a first JSON message when API-key auth is enabled:

```json
{ "action": "auth", "api_key": "example-api-key" }
```

### JSON And Errors

Most non-streaming endpoints return JSON. Handler-generated errors use this shape:

```json
{
  "success": false,
  "message": "What went wrong",
  "error_code": "VALIDATION_ERROR",
  "error_id": "err_1a2b3c4d5e6f",
  "timestamp": "2026-06-21T12:00:00Z",
  "path": "/entities"
}
```

Auth middleware errors are smaller and only include `success`, `message`, and `error_code`.

Clients may send `X-Request-ID` to preserve an existing trace identifier; otherwise Core generates one. Structured request and request-scoped error logs include that value as `request_id`. The response `error_id` is a separate identifier for one handler-generated error instance.

Common statuses:

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, invalid query parameter, or validation failure. |
| `401` | API key is missing/wrong, or the browser session is missing/invalid. |
| `404` | Entity, alias, task, object, bucket, or route was not found. |
| `409` | Duplicate resource or unique constraint conflict. |
| `412` | `If-Match` expected an older resource version than the server has. |
| `413` | Request body or file upload is too large. |
| `503` | Storage, feed, or another dependency is unavailable. |

### Resource Versions And `If-Match`

Single-resource reads and writes return a strong `ETag` header like:

```text
ETag: "v12"
```

For concurrency-sensitive writes, send the latest version back with:

```text
If-Match: "v12"
```

`PATCH /entities/{entity_id}`, `PATCH /objects/{object_id}`, and
`POST /entities/{entity_id}/checkin` accept this header. If the header is
omitted, the server applies the write without a version precondition.

### Pagination

Standard list endpoints accept:

| Query | Notes |
| --- | --- |
| `limit` | Default `100`, maximum `500`. Values above the max are clamped. |
| `cursor` | Opaque continuation token from `X-Next-Cursor`. |

`offset` is rejected. Paginated responses return:

```text
X-Limit: 100
X-Returned-Count: 100
X-Has-More: true
X-Next-Cursor: <opaque cursor>
```

The standard paginated endpoints are:

- `GET /entities`
- `GET /tasks`
- `GET /objects`
- `GET /entities/{entity_id}/tasks`
- `GET /entities/{entity_id}/objects`
- `GET /tasks/{task_id}/objects`

## Response Shapes

Entity responses:

```json
{
  "entity_id": "asset-1",
  "entity_type": "asset",
  "subtype": "drone",
  "alias": "alpha",
  "components": {},
  "metadata": {
    "created_at": "2026-06-21T12:00:00.000000Z",
    "updated_at": "2026-06-21T12:00:00.000000Z",
    "version": 1
  },
  "extra": {}
}
```

Task responses:

```json
{
  "task_id": "task-7",
  "asset_id": "asset-1",
  "command": "example.inspect",
  "input": {},
  "status": "pending",
  "created_at": "2026-06-21T12:00:00.000000Z",
  "updated_at": "2026-06-21T12:00:00.000000Z"
}
```

Object detail responses:

```json
{
  "object_id": "object-1",
  "path": "objects/object-1/blob",
  "content_type": "application/json",
  "type": "heatmap",
  "size_bytes": 1234,
  "usage_hints": ["heatmap_data"],
  "referenced_by": [{ "entity_id": "asset-1" }],
  "bucket": "atlas-media",
  "metadata": {
    "created_at": "2026-06-21T12:00:00.000000Z",
    "updated_at": "2026-06-21T12:00:00.000000Z",
    "version": 1
  },
  "extra": {}
}
```

`GET /objects` and relationship object lists omit `extra` and `referenced_by`. Full object detail and query responses include extension data under `extra`.

## System, Protocol, And Feed

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | `200` | Returns service metadata and top-level endpoints. |
| `GET` | `/health` | `200` | Liveness only. Skips auth. |
| `GET` | `/readiness` | `200` or `503` | Checks database and storage readiness. Skips auth. |
| `GET` | `/resources` | `200` | Returns operator CPU, memory, disk, and Go process diagnostics. Requires protected-route auth. |
| `GET` | `/protocol/revision` | `200` | Returns `{ "protocol_revision": "..." }`. |
| `GET` | `/command-catalog` | `200` or `304` | Returns Core's authoritative embedded command definitions. |
| `GET` | `/feed` | `101` websocket | Change-feed websocket. |

Readiness is HTTP `503` with `status: "unhealthy"` when the database is unavailable or configured storage cannot be initialized, reached, or verified. A missing configured bucket is also unhealthy. With a healthy database, deliberately omitting storage credentials keeps DB-only/local Core available as HTTP `200` with `status: "degraded"` and the storage check marked `unconfigured`; use `/health` when only process liveness matters.

`GET /resources` reports host-level metrics, not cgroup-aware container limits. It performs a 100 ms CPU sample plus host and Go runtime memory/disk inspection, so reserve it for bounded operator diagnostics rather than high-frequency polling. Disk `used_percent` is based on space unavailable to the service, so it may differ from `df`-style `Use%`.

Feed behavior:

- Server sends a `hello` frame with `protocol_revision` after authentication.
- Clients must subscribe before receiving events.
- Supported filters are `all`, `type`, `id`, and `tasks_for_asset`.
- Events include `event`, `resource_type`, `id`, `version`, and full `resource` except for deletes.
- On version gaps or reconnects, recover through `GET /queries/changed-since`.

Subscribe examples:

```json
{ "action": "subscribe", "filter": "all" }
```

```json
{ "action": "subscribe", "filter": "tasks_for_asset", "asset_id": "asset-1" }
```

```json
{
  "action": "unsubscribe",
  "filter": "id",
  "resource_type": "task",
  "id": "task-7"
}
```

## Entities

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/entities` | `200` | List entities with standard pagination. |
| `POST` | `/entities` | `201` | Create an entity. |
| `GET` | `/entities/{entity_id}` | `200` | Fetch one entity by ID. |
| `GET` | `/entities/alias/{alias}` | `200` | Fetch one entity by alias. |
| `PATCH` | `/entities/{entity_id}` | `200` | Update type, subtype, alias, components, or extra fields. |
| `DELETE` | `/entities/{entity_id}` | `204` | Delete an entity. |
| `POST` | `/entities/{entity_id}/checkin` | `200` | Update heartbeat, status, telemetry, and other observed state. |
| `POST` | `/entities/{entity_id}/runtime` | `204` | Begin a new Asset process registration and fence the previous runtime. |
| `POST` | `/entities/{entity_id}/runtime/ready` | `204` | Publish the current runtime's fixed Command Manifest after safe state. |
| `GET` | `/entities/{entity_id}/runtime/tasks` | `200` | Return work currently deliverable to the current ready runtime. |
| `GET` | `/entities/{entity_id}/tasks` | `200` | List tasks attached to the entity. |
| `GET` | `/entities/{entity_id}/objects` | `200` | List objects referenced by the entity. |

Create body:

```json
{
  "entity_id": "asset-1",
  "entity_type": "asset",
  "subtype": "drone",
  "alias": "alpha",
  "components": {
    "telemetry": {
      "latitude": 38.8977,
      "longitude": -77.0365
    }
  },
  "extra": {
    "operator_note": "local test asset"
  }
}
```

Patch body:

```json
{
  "alias": "alpha-2",
  "components": {
    "status": {
      "value": "ready"
    }
  },
  "extra": {
    "operator_note": "updated"
  }
}
```

`components` are deep-merged by key. `subtype` and `alias` can be cleared with `null` or an empty string.

Check-in accepts the optional `fields=minimal` query. Both generated response shapes contain the updated Entity only; Task delivery is separate.

Check-in body is optional. When present, it can include:

```json
{
  "status": "online",
  "latitude": 38.8977,
  "longitude": -77.0365,
  "components": {
    "communications": {
      "link_state": "connected"
    }
  }
}
```

The body is the Protocol `EntityCheckInRequest`: unknown fields are rejected; `status` must be non-empty; latitude is `-90` through `90`; longitude is `-180` through `180`; altitude must be finite; speed cannot be negative; heading is at least `0` and less than `360`; and `components` must satisfy the canonical `EntityComponents` contract. An empty body is equivalent to `{}`. Malformed or trailing JSON returns `INVALID_JSON`; a structurally invalid body returns `VALIDATION_ERROR`. Body rejection happens before Core writes the Entity.

Check-in response:

```json
{
  "entity": { "entity_id": "asset-1" }
}
```

Core validates the request body before committing the heartbeat, status, telemetry, or component update. A rejected body returns an error without changing the Entity or publishing a feed event.

Runtime registration begins with:

```json
{ "runtime_id": "runtime-process-1" }
```

After every execution module establishes safe state, the same process publishes its fixed manifest:

```json
{
  "runtime_id": "runtime-process-1",
  "manifest": []
}
```

Beginning a new runtime fences the previous runtime and fails its nonterminal Tasks with `asset_restarted`. The ready and delivery routes reject stale runtime IDs. `GET /entities/{entity_id}/runtime/tasks` carries the current ID in `Atlas-Runtime-ID` and returns `{ "tasks": [...] }`. The current ready manifest also appears read-only as `command_manifest` on Asset responses.

## Tasks

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/tasks` | `200` | List tasks with standard pagination. |
| `POST` | `/tasks` | `201` | Create an immutable Task. Requires `Idempotency-Key`. |
| `GET` | `/tasks/{task_id}` | `200` | Fetch one task. |
| `POST` | `/tasks/{task_id}/acknowledge` | `200` | Accept queued work. Requires current runtime context. |
| `POST` | `/tasks/{task_id}/start` | `200` | Begin execution. Requires current runtime context. |
| `POST` | `/tasks/{task_id}/progress` | `200` | Report monotonic progress. Requires current runtime context. |
| `POST` | `/tasks/{task_id}/complete` | `200` | Complete with optional validated output. Requires current runtime context. |
| `POST` | `/tasks/{task_id}/fail` | `200` | Record a structured failure. Requires current runtime context. |
| `POST` | `/tasks/{task_id}/cancel` | `200` | Cancel from a tasking client. |
| `GET` | `/tasks/{task_id}/objects` | `200` | List objects referenced by the task. |

Create one operator tasking attempt by sending the same opaque idempotency key on every retry:

```json
{
  "asset_id": "asset-1",
  "command": "example.inspect",
  "input": {}
}
```

Core generates `task_id`, resolves the Command from the generated Protocol catalog, validates the current ready runtime's manifest and the input schema, and returns the Task in `pending`. Reusing a key with identical tasking data returns the original Task. Reusing it with different data returns a conflict. The generated production catalog is currently empty, so production creation rejects every Command until one is added through the Protocol authoring process.

Asset-only operations send the current process fence in `Atlas-Runtime-ID`. Acknowledge and start use `{}`. Progress uses a value from `0` to `1`:

```json
{
  "progress": 0.5
}
```

Completion may include Command-defined output:

```json
{
  "output": { "observations": 3 }
}
```

Failure and cancellation use closed Protocol codes plus a human-readable message:

```json
{
  "failure": {
    "code": "execution_failed",
    "message": "Sensor did not become ready."
  }
}
```

```json
{
  "cancellation": {
    "code": "requested",
    "message": "Operator cancelled the Task."
  }
}
```

Task assignment, Command, and input never change. Tasks are permanent execution records and have no patch or delete route. The first accepted terminal operation wins; an identical repeat is idempotent and a conflicting repeat is rejected.

## Objects

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/objects` | `200` | List object metadata with standard pagination. |
| `POST` | `/objects` | `201` | Create an object metadata record. |
| `POST` | `/objects/upload` | `201` | Upload object content with multipart form data. |
| `GET` | `/objects/{object_id}` | `200` | Fetch full object metadata and extension data. |
| `PATCH` | `/objects/{object_id}` | `200` | Update object metadata. |
| `DELETE` | `/objects/{object_id}` | `204` | Delete object metadata and queue/delete stored content. |
| `GET` | `/objects/{object_id}/download` | `200` | Stream stored content as an attachment. |
| `GET` | `/objects/{object_id}/view` | `200`/`415` | Stream safe text-like content inline, force unsafe inline text types to attachment download, or reject unsupported content. |

Metadata create body:

```json
{
  "object_id": "object-1",
  "type": "heatmap",
  "usage_hints": ["heatmap_data"],
  "referenced_by": [{ "entity_id": "asset-1" }],
  "extra": {
    "source": "local import"
  }
}
```

`POST /objects` and `PATCH /objects/{object_id}` manage descriptive metadata only.
Do not send `path`, `content_type`, `size_bytes`, or `bucket`; Atlas Core sets
those blob facts when the object is uploaded.

Metadata patch body:

```json
{
  "type": "mission_report",
  "usage_hints": ["report"],
  "referenced_by": [{ "task_id": "task-1" }],
  "extra": {
    "reviewed": true
  }
}
```

Upload with `curl`:

```bash
curl -X POST http://localhost:8000/objects/upload \
  -F object_id=object-1 \
  -F type=mission_report \
  -F usage_hint=report \
  -F file=@./report.json
```

Upload accepts these multipart fields:

| Field | Required | Notes |
| --- | --- | --- |
| `object_id` | yes | ID to create/update content for. |
| `file` | yes | Uploaded file body. |
| `type` | no | Object type string. |
| `usage_hint` | no | Single usage hint to add. |

Upload does not accept `referenced_by`; create or update object references through `POST /objects` or `PATCH /objects/{object_id}`.

`GET /objects/{object_id}/view` is limited to safe text-based formats and the configured `MAX_VIEW_SIZE_MB`. `text/html` and JavaScript content types are not rendered inline; they are streamed as `application/octet-stream` attachments. Other non-viewable content types return `415 CONTENT_TYPE_NOT_VIEWABLE`. Uploads over `MAX_UPLOAD_SIZE_MB` return `413`; downloads stream as attachments without a separate download size cap. Upload, download, and view I/O uses a 30-second idle deadline: an active transfer may exceed 30 seconds in total, but a read or write with no progress for 30 seconds is terminated.

## Queries

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/queries/full` | `200` | Snapshot entities, tasks, and objects. |
| `GET` | `/queries/changed-since` | `200` | Incremental changes after a global version. |

`GET /queries/full` query parameters:

| Query | Notes |
| --- | --- |
| `entity_limit` | Optional per-type limit. Default/zero returns up to `1000`. |
| `task_limit` | Optional per-type limit. Default/zero returns up to `1000`. |
| `object_limit` | Optional per-type limit. Default/zero returns up to `1000`. |
| `entity_cursor` | Continue entities from `next_entity_cursor`. |
| `task_cursor` | Continue tasks from `next_task_cursor`. |
| `object_cursor` | Continue objects from `next_object_cursor`. |

Full-query resource streams return at most 1000 rows per type and retain at most 8 MiB of stored resource JSON per type per page. A byte-limited short page uses the same `has_more_*` and `next_*_cursor` fields as count-limited pagination. Stored resource JSON is capped at 1 MiB after create/update merging. Changed-since defaults to 100 globally ordered events, accepts an explicit limit up to 5000, and always applies an 8 MiB serialized-event byte budget.

The response includes a global `version` captured before the first page is read. Every continuation page repeats that same hydration baseline through its opaque cursors. A later page may contain a resource with a newer `metadata.version`; clients must not infer the global sync cursor from returned resources. After consuming every full-dataset page, call `GET /queries/changed-since?since_version=<version>` and drain that response before treating the hydrated data as current.

Response:

```json
{
  "version": 42,
  "entities": [],
  "tasks": [],
  "objects": [],
  "has_more_entities": false,
  "has_more_tasks": false,
  "has_more_objects": false,
  "next_entity_cursor": "optional opaque cursor",
  "next_task_cursor": "optional opaque cursor",
  "next_object_cursor": "optional opaque cursor"
}
```

`GET /queries/changed-since` requires:

| Query | Notes |
| --- | --- |
| `since_version` | Required non-negative global version. |
| `limit` | Optional event limit. Default/zero returns up to `100`; explicit values are capped at `5000`. |
| `cursor` | Continue from the opaque `next_cursor`. |

Response includes complete feed events in global version order plus one `has_more`/`next_cursor` continuation and a stable `version` watermark. Pages stop at either the event count or 8 MiB of serialized event JSON, while always returning one event for cursor progress. Keep the same `since_version` while following cursors for one response window. After all pages are consumed, pass the returned `version` as the next poll's `since_version`. A cursor older than the seven-day recovery window receives HTTP `410` with `CURSOR_EXPIRED`; perform full hydration and resume from its version watermark.

```json
{
  "events": [
    {
      "event": "update",
      "resource_type": "task",
      "id": "task-7",
      "version": 41,
      "resource": { "task_id": "task-7", "asset_id": "asset-1", "command": "example.inspect", "input": {}, "status": "pending", "created_at": "2026-06-21T12:00:00Z", "updated_at": "2026-06-21T12:00:00Z" }
    }
  ],
  "has_more": false,
  "version": 42
}
```

## Command catalog

`GET /command-catalog` returns the Protocol-defined catalog embedded in the running Core binary. The response includes a strong `ETag` and supports `If-None-Match`. It does not read or create an Atlas object and does not depend on MinIO.

## Browser Admin Auth And Command Interface

Atlas Core owns browser authentication. Admin routes live under `/admin/*` and are separate from the Atlas resource plane (`entities`, `tasks`, `objects`, `queries`, sync, and feed). Admin records are stored in `admin_records`; they are not returned by full dataset or changed-since queries and do not produce resource feed events.

Core seeds a development admin account on startup. Raw startup without an
override uses:

- username: `admin`
- password: `password`

This credential is development-only scratch state. The default `atlas.py --dev` launcher instead generates `ATLAS_ADMIN_PASSWORD` in the owner-only `atlas_core/docker/.env.local`. Set `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` explicitly before exposing Core outside local development. When API-key auth is enabled, Core refuses to start with the default `admin` / `password` seed.

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `POST` | `/admin/auth/login` | `200` | Creates a Core-owned browser session from an admin username/password. |
| `POST` | `/admin/auth/logout` | `204` | Deletes the current browser session and clears the session cookie. |
| `GET` | `/admin/auth/me` | `200` | Reports the current browser session user. |
| `GET` | `/admin/api-keys` | `200` | Lists active managed API key metadata. |
| `POST` | `/admin/api-keys` | `201` | Creates a named managed API key and returns the full key once. Requires API-key auth to be enabled. |
| `DELETE` | `/admin/api-keys/{key_id}` | `204` | Revokes a managed API key. |

The session token is random and stored only as `session:<sha256(token)>` in Core. The browser receives it in the `atlas_session` cookie with `HttpOnly; Secure`. Cross-site UI/Core deployments use the default `SameSite=None`; same-site deployments can set `ATLAS_ADMIN_COOKIE_SAMESITE=lax`.

Managed API keys are full-access machine credentials for the current auth model. Core stores only `sha256(secret)` plus key metadata in `admin_records`, and list responses never include the full secret. API-key-authenticated requests cannot create, list, or revoke API keys; key management requires a browser admin session. Creating managed keys requires `ENABLE_API_AUTH=true`; existing keys remain visible/revocable but inactive while API-key auth is disabled.

The Cloudflare Pages command interface is a static Vite app. It does not own `/api/config`, `/auth/*`, `/me/settings`, `/atlas/*`, feed bridging, Core API-key injection, or command validation. The browser Atlas SDK calls Core directly with `credentials: "include"` and receives only non-secret build-time browser config from Vite/public assets.

Command validation happens in Core `POST /tasks`. Core generates the Task ID and validates the Protocol catalog, the current ready runtime's read-only `command_manifest`, and the Command input. The generated production catalog is currently `[]`, so the command interface shows an intentional no-Commands state and Core rejects every production Task creation attempt. Adding a real Command includes its Protocol definition, purpose-built operator input, Asset handler, and any special Core policy.

Smoke browser auth and the empty production catalog against Core:

```bash
CORE_URL=http://localhost:8000
COOKIE_JAR=$(umask 077 && mktemp "${TMPDIR:-/tmp}/atlas-core-admin.cookies.XXXXXX") || exit 1
trap 'rm -f "$COOKIE_JAR"' EXIT
LOGIN_JSON="$(
  python3 - <<'PY'
import json
from atlas_core.scripts.compose_env import parse_compose_env_file

password = parse_compose_env_file("atlas_core/docker/.env.local").get("ATLAS_ADMIN_PASSWORD")
if not password:
    raise SystemExit("atlas_core/docker/.env.local must contain ATLAS_ADMIN_PASSWORD")
print(json.dumps({"username": "admin", "password": password}))
PY
)" || exit 1

curl -sS -c "$COOKIE_JAR" -X POST "$CORE_URL/admin/auth/login" \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  --data-binary @- <<<"$LOGIN_JSON"

curl -sS -b "$COOKIE_JAR" "$CORE_URL/admin/auth/me"

curl -sS -b "$COOKIE_JAR" "$CORE_URL/command-catalog"
```

Response:

```json
[]
```

Log out; the `EXIT` trap removes the cookie jar even if logout fails:

```bash
curl -fsS -b "$COOKIE_JAR" -X POST "$CORE_URL/admin/auth/logout" \
  -H 'Origin: http://localhost:5173'
```

## Minimal Curl Flow

Create an entity:

```bash
CORE_URL=http://localhost:8000
UI_ORIGIN=http://localhost:5173
COOKIE_JAR=$(umask 077 && mktemp "${TMPDIR:-/tmp}/atlas-core-admin.cookies.XXXXXX") || exit 1
trap 'rm -f "$COOKIE_JAR"' EXIT
LOGIN_JSON="$(
  python3 - <<'PY'
import json
from atlas_core.scripts.compose_env import parse_compose_env_file

password = parse_compose_env_file("atlas_core/docker/.env.local").get("ATLAS_ADMIN_PASSWORD")
if not password:
    raise SystemExit("atlas_core/docker/.env.local must contain ATLAS_ADMIN_PASSWORD")
print(json.dumps({"username": "admin", "password": password}))
PY
)" || exit 1

curl -sS -c "$COOKIE_JAR" -X POST "$CORE_URL/admin/auth/login" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<<"$LOGIN_JSON"

curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/entities" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"entity_id":"asset-1","entity_type":"asset","subtype":"drone","alias":"alpha","components":{}}'
```

Register the telemetry-only runtime with the empty production manifest:

```bash
RUNTIME_ID=runtime-local-1

curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/entities/asset-1/runtime" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d "{\"runtime_id\":\"$RUNTIME_ID\"}"

curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/entities/asset-1/runtime/ready" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d "{\"runtime_id\":\"$RUNTIME_ID\",\"manifest\":[]}"
```

Report telemetry:

```bash
curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/entities/asset-1/checkin" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"online","latitude":38.8977,"longitude":-77.0365}'
```

Confirm that no production Command is currently defined or deliverable:

```bash
curl -sS -b "$COOKIE_JAR" "$CORE_URL/command-catalog"
curl -sS -b "$COOKIE_JAR" "$CORE_URL/entities/asset-1/runtime/tasks" \
  -H "Atlas-Runtime-ID: $RUNTIME_ID"
```

Poll changes since version zero:

```bash
curl -sS -b "$COOKIE_JAR" "$CORE_URL/queries/changed-since?since_version=0"
```

Log out; the `EXIT` trap removes the cookie jar even if logout fails:

```bash
curl -fsS -b "$COOKIE_JAR" -X POST "$CORE_URL/admin/auth/logout" \
  -H "Origin: $UI_ORIGIN"
```
