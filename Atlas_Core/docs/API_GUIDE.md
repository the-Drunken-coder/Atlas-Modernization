# Atlas Core API Guide

_Revision: 2026-06-21_

This is the quick-reference guide for calling the Atlas Core HTTP API. The default local base URL is:

```text
http://localhost:8000
```

The canonical resource and wire schemas live in Atlas Protocol. Use this guide for route behavior, then use `../../atlas_protocol/examples/` and `../../atlas_protocol/schema/jsonschema/atlas.schema.json` for exact payload examples and schema details.

Atlas Core treats resource tables and the configured MinIO bucket as disposable runtime scratch storage. With the default startup path, the service drops and recreates resource tables and clears the configured bucket, so operators should not treat resource rows or blobs as durable systems of record. `admin_records` is preserved for operator credentials and managed API key metadata.

## Common Rules

### Authentication

Protected Core routes accept the Core-owned browser session cookie. Local browser development uses the seeded admin session; machine clients should set `ENABLE_API_AUTH=true` and send either the required bootstrap `API_AUTH_KEY` or an active managed API key with one of:

```text
X-API-Key: <api-key>
Authorization: Bearer <api-key>
```

The `/feed` websocket accepts the browser session cookie during upgrade. Machine clients authenticate with a first JSON message when API-key auth is enabled:

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

`PATCH`, task lifecycle routes, telemetry, and check-in all accept this header. If the header is omitted, the server applies the write without a version precondition.

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
  "task_id": "task-1",
  "status": "pending",
  "entity_id": "asset-1",
  "components": {},
  "metadata": {
    "created_at": "2026-06-21T12:00:00.000000Z",
    "updated_at": "2026-06-21T12:00:00.000000Z",
    "version": 1
  },
  "extra": {}
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
  "payload": {}
}
```

`GET /objects` and relationship object lists omit `payload` and `referenced_by`.

## System, Protocol, And Feed

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | `200` | Returns service metadata and top-level endpoints. |
| `GET` | `/health` | `200` | Liveness only. Skips auth. |
| `GET` | `/readiness` | `200` or `503` | Checks database and storage readiness. Skips auth. |
| `GET` | `/resources` | `200` | Returns CPU, memory, disk, and Go process usage. Skips protected-route auth. |
| `GET` | `/protocol/revision` | `200` | Returns `{ "protocol_revision": "..." }`. |
| `GET` | `/feed` | `101` websocket | Change-feed websocket. |

`GET /resources` reports host-level metrics, not cgroup-aware container limits. Disk `used_percent` is based on space unavailable to the service, so it may differ from `df`-style `Use%`.

Feed behavior:

- Server sends a `hello` frame with `protocol_revision` after authentication.
- Clients must subscribe before receiving events.
- Supported filters are `all`, `type`, `id`, and `tasks_for_entity`.
- Events include `event`, `resource_type`, `id`, `version`, and full `resource` except for deletes.
- On version gaps or reconnects, recover through `GET /queries/changed-since`.

Subscribe examples:

```json
{ "action": "subscribe", "filter": "all" }
```

```json
{ "action": "subscribe", "filter": "tasks_for_entity", "entity_id": "asset-1" }
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
| `PATCH` | `/entities/{entity_id}/telemetry` | `200` | Merge telemetry fields into `components.telemetry`. |
| `POST` | `/entities/{entity_id}/checkin` | `200` | Update heartbeat/status/telemetry and return tasks for that entity. |
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

Telemetry body:

```json
{
  "latitude": 38.8977,
  "longitude": -77.0365,
  "altitude_m": 120.5,
  "speed_m_s": 8.2,
  "heading_deg": 45
}
```

At least one telemetry field is required.

Check-in query parameters:

| Query | Default | Notes |
| --- | --- | --- |
| `status_filter` | `pending,acknowledged` | Comma-separated task statuses to return. |
| `limit` | `10` | Must be between `1` and `20`. |
| `task_cursor` | none | Opaque cursor from `next_task_cursor`. |
| `fields` | full task responses | `fields=minimal` returns compact task entries. |
| `since` | none | RFC3339 timestamp filter for tasks. |

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

Check-in response:

```json
{
  "entity": { "entity_id": "asset-1" },
  "tasks": [],
  "task_count": 0,
  "task_limit": 10,
  "has_more_tasks": false,
  "next_task_cursor": "optional opaque cursor"
}
```

## Tasks

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/tasks` | `200` | List tasks with standard pagination. |
| `POST` | `/tasks` | `201` | Create a task. |
| `GET` | `/tasks/{task_id}` | `200` | Fetch one task. |
| `PATCH` | `/tasks/{task_id}` | `200` | Update status, entity assignment, components, or extra fields. |
| `DELETE` | `/tasks/{task_id}` | `204` | Delete a task. |
| `POST` | `/tasks/{task_id}/acknowledge` | `200` | Set task status to acknowledged. |
| `POST` | `/tasks/{task_id}/complete` | `200` | Complete a task and optionally attach a result. |
| `POST` | `/tasks/{task_id}/fail` | `200` | Fail a task and optionally attach error details. |
| `POST` | `/tasks/{task_id}/status` | `200` | Transition status with optional progress/message. |
| `GET` | `/tasks/{task_id}/objects` | `200` | List objects referenced by the task. |

Create body:

```json
{
  "task_id": "task-1",
  "status": "pending",
  "entity_id": "asset-1",
  "components": {
    "target": {
      "latitude": 38.8977,
      "longitude": -77.0365,
      "altitude_m": 120.5
    },
    "custom_note": {
      "text": "inspect target area"
    }
  },
  "extra": {
    "requested_by": "local-operator"
  }
}
```

If `status` is omitted during create, the server uses `pending`.

Patch body:

```json
{
  "status": "acknowledged",
  "components": {
    "progress": {
      "percent": 25
    }
  },
  "extra": {
    "operator_note": "asset has started"
  },
  "remove_extra_keys": ["old_note"]
}
```

Complete body is optional:

```json
{
  "result": {
    "summary": "arrived at target"
  }
}
```

Fail body is optional:

```json
{
  "error": {
    "code": "NAVIGATION_FAILED",
    "message": "could not reach target"
  }
}
```

Status transition body:

```json
{
  "status": "acknowledged",
  "progress": 40,
  "message": "en route"
}
```

## Objects

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/objects` | `200` | List object metadata with standard pagination. |
| `POST` | `/objects` | `201` | Create an object metadata record. |
| `POST` | `/objects/upload` | `201` | Upload object content with multipart form data. |
| `GET` | `/objects/{object_id}` | `200` | Fetch object metadata and payload. |
| `PATCH` | `/objects/{object_id}` | `200` | Update object metadata. |
| `DELETE` | `/objects/{object_id}` | `204` | Delete object metadata and queue/delete stored content. |
| `GET` | `/objects/{object_id}/download` | `200` | Stream stored content as an attachment. |
| `GET` | `/objects/{object_id}/view` | `200` | Stream safe text-like content inline. |

Metadata create body:

```json
{
  "object_id": "object-1",
  "path": "objects/object-1/blob",
  "size_bytes": 1234,
  "content_type": "application/json",
  "type": "heatmap",
  "usage_hints": ["heatmap_data"],
  "referenced_by": [{ "entity_id": "asset-1" }],
  "extra": {
    "source": "local import"
  }
}
```

Do not send `bucket` in create or patch requests; the server owns that field and rejects client-supplied values.

Metadata patch body:

```json
{
  "content_type": "application/json",
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

`GET /objects/{object_id}/view` is limited to safe text-based formats and the configured `MAX_VIEW_SIZE_MB`.

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

Response:

```json
{
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
| `limit_per_type` | Optional per-type limit. Default/zero returns up to `5000`. |
| `entity_cursor` | Continue entities from `next_entity_cursor`. |
| `task_cursor` | Continue tasks from `next_task_cursor`. |
| `object_cursor` | Continue objects from `next_object_cursor`. |
| `deleted_entity_cursor` | Continue deleted entities. |
| `deleted_task_cursor` | Continue deleted tasks. |
| `deleted_object_cursor` | Continue deleted objects. |

Response includes changed resources, tombstones, per-stream `has_more_*` booleans, next cursors, and a monotonic `version` watermark. Keep the same `since_version` while following cursors for one response window. After all pages are consumed, pass the returned `version` as the next poll's `since_version`.

```json
{
  "entities": [],
  "tasks": [],
  "objects": [],
  "deleted_entities": [],
  "deleted_tasks": [],
  "deleted_objects": [],
  "has_more_entities": false,
  "has_more_tasks": false,
  "has_more_objects": false,
  "has_more_deleted_entities": false,
  "has_more_deleted_tasks": false,
  "has_more_deleted_objects": false,
  "version": 42,
  "timestamp": "2026-06-21T12:00:00Z"
}
```

## Browser Admin Auth And Command Interface

Atlas Core owns browser authentication. Admin routes live under `/admin/*` and are separate from the Atlas resource plane (`entities`, `tasks`, `objects`, `queries`, sync, and feed). Admin records are stored in `admin_records`; they are not returned by full dataset or changed-since queries and do not produce resource feed events.

Core seeds a development admin account on startup:

- username: `admin`
- password: `password`
- role: `admin`

This credential is development-only scratch state. Set `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` before exposing Core outside local development. When API-key auth is enabled, Core refuses to start with the default `admin` / `password` seed.

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

Command task validation happens in Core `POST /tasks`. Command submissions omit `task_id`; Core generates `command-<uuid>`, loads the command catalog, loads the target entity, checks `components.task_catalog.supported_tasks`, and validates/coerces command parameters. Non-command task creation keeps the existing client-supplied `task_id` contract.

```json
{
  "entity_id": "asset-1",
  "components": {
    "command": {
      "type": "move_to_location",
      "id": "move_to_location"
    },
    "parameters": {
      "latitude": 38.8977,
      "longitude": -77.0365,
      "altitude_m": 120.5
    }
  }
}
```

Smoke browser auth and command task creation against Core:

```bash
CORE_URL=http://localhost:8000
COOKIE_JAR=/tmp/atlas-core-admin.cookies

curl -sS -c "$COOKIE_JAR" -X POST "$CORE_URL/admin/auth/login" \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"password"}'

curl -sS -b "$COOKIE_JAR" "$CORE_URL/admin/auth/me"

curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/tasks" \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  -d '{"entity_id":"asset-1","components":{"command":{"type":"move_to_location","id":"move_to_location"},"parameters":{"latitude":38.8977,"longitude":-77.0365,"altitude_m":120.5}}}'
```

Response:

```json
{
  "task_id": "command-...",
  "status": "pending",
  "entity_id": "asset-1",
  "components": {
    "command": {
      "type": "move_to_location",
      "id": "move_to_location"
    },
    "parameters": {
      "latitude": 38.8977,
      "longitude": -77.0365,
      "altitude_m": 120.5
    }
  }
}
```

## Minimal Curl Flow

Create an entity:

```bash
CORE_URL=http://localhost:8000
COOKIE_JAR=/tmp/atlas-core-admin.cookies
UI_ORIGIN=http://localhost:5173

curl -sS -c "$COOKIE_JAR" -X POST "$CORE_URL/admin/auth/login" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"password"}'

curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/entities" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"entity_id":"asset-1","entity_type":"asset","subtype":"drone","alias":"alpha","components":{}}'
```

Create a task:

```bash
curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/tasks" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"task-1","entity_id":"asset-1","components":{"target":{"latitude":38.8977,"longitude":-77.0365,"altitude_m":120.5}}}'
```

Check in and fetch pending work:

```bash
curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/entities/asset-1/checkin?fields=minimal" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"online","latitude":38.8977,"longitude":-77.0365}'
```

Complete the task:

```bash
curl -sS -b "$COOKIE_JAR" -X POST "$CORE_URL/tasks/task-1/complete" \
  -H "Origin: $UI_ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"result":{"summary":"done"}}'
```

Poll changes since version zero:

```bash
curl -sS -b "$COOKIE_JAR" "$CORE_URL/queries/changed-since?since_version=0"
```
