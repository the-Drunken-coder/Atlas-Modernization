# Pagination Contract

_Revision: 2026-05-29_

## Overview

Atlas Core uses offset-based pagination for collection endpoints while keeping response bodies as
JSON arrays for backward compatibility.

## Query Parameters

All list endpoints accept:

- `limit`
- `offset`

The handler defaults are `limit=100` and `offset=0`.

### HTTP validation

Before the action layer runs, handlers reject invalid pagination query params with **400** and
`VALIDATION_ERROR`:

- Non-numeric `limit` or `offset`
- Negative `limit` or `offset`

### Action-layer normalization

After HTTP parsing, list actions normalize values:

- `limit <= 0` becomes `100`
- `limit > 500` is clamped to `500`
- `offset < 0` becomes `0` (only reachable from internal callers; HTTP rejects negative offset)

Shared helper: `internal/actions/pagination.go` (`ClampListLimit`, etc.).

## Response Headers

Paginated responses include these headers:

- `X-Total-Count`
- `X-Limit`
- `X-Offset`
- `X-Returned-Count`

No additional pagination headers are currently emitted (for example, there is no `X-Has-More` or
`X-Next-Offset` header in the current implementation).

## Covered Endpoints

- `GET /entities`
- `GET /tasks`
- `GET /objects`
- `GET /entities/{entity_id}/tasks`
- `GET /entities/{entity_id}/objects`
- `GET /tasks/{task_id}/objects`

### Check-in task pagination (different limits)

`POST /entities/{entity_id}/checkin` returns tasks inline (not via pagination headers). Query params:

- `limit` — default **10**, range **1–20** (invalid values return 400)
- `offset` — default **0** (negative values return 400)
- `status_filter`, `fields`, `since` — see entity status docs

## Query endpoints (`/queries/full`, `/queries/changed-since`)

These endpoints use per-type **limits** (not offset pagination). When a stream is truncated, the response includes `has_more_*` booleans and opaque **`next_*_cursor`** strings. Pass them back on the **next request** as query parameters to continue **without skipping rows**:

| Response field | Query parameter (next request) |
| --- | --- |
| `next_entity_cursor` | `entity_cursor` |
| `next_task_cursor` | `task_cursor` |
| `next_object_cursor` | `object_cursor` |
| `next_deleted_entity_cursor` | `deleted_entity_cursor` |
| `next_deleted_task_cursor` | `deleted_task_cursor` |
| `next_deleted_object_cursor` | `deleted_object_cursor` |

For **`GET /queries/changed-since`**, keep the same **`since`** timestamp while following cursors. Treat each cursor as an **opaque** token: do not parse or construct it—pass back the `next_*_cursor` value from the previous response unchanged as the matching `*_cursor` query parameter on the next request.

### Per-type caps

When limit query params are omitted or zero:

- `GET /queries/full` — up to **1000** rows per resource type (`entity_limit`, `task_limit`, `object_limit`)
- `GET /queries/changed-since` — up to **5000** rows per type when `limit_per_type` is zero

Invalid limit query params on these endpoints return **400** `VALIDATION_ERROR`.
