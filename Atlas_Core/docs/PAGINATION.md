# Pagination Contract

_Revision: 2026-06-03_

## Overview

Atlas Core uses keyset pagination for collection endpoints while keeping response bodies as JSON arrays. Standard list pages are ordered by `(created_at DESC, id DESC)` and use opaque cursor tokens for continuation. Check-in task pagination is the one endpoint-specific exception; it is described below.

## Query Parameters

All standard list endpoints accept:

- `limit`
- `cursor`

The handler default is `limit=100`; the maximum standard page size is `500`.

`offset` is no longer supported. Any request that includes an `offset` query parameter returns **400** with `VALIDATION_ERROR`.

### HTTP validation

Handlers reject invalid pagination query params with **400** and `VALIDATION_ERROR`:

- Non-numeric `limit`
- Negative `limit`
- Any `offset` parameter

### Action-layer normalization

After HTTP parsing, list actions normalize and validate values:

- `limit <= 0` becomes `100`
- `limit > 500` is clamped to `500`
- `cursor` is treated as an opaque continuation token
- Malformed `cursor` is rejected with **400** and `VALIDATION_ERROR`

Shared helper: `internal/actions/pagination.go` (`ClampListLimit`, etc.).

## Response Headers

Paginated responses include these headers:

- `X-Limit`
- `X-Returned-Count`
- `X-Has-More`
- `X-Next-Cursor` when another page exists

Follow-up requests pass `X-Next-Cursor` back as the `cursor` query parameter. Clients must not parse or construct cursor values.

## Covered Endpoints

- `GET /entities`
- `GET /tasks`
- `GET /objects`
- `GET /entities/{entity_id}/tasks`
- `GET /entities/{entity_id}/objects`
- `GET /tasks/{task_id}/objects`

### Check-in task pagination

`POST /entities/{entity_id}/checkin` returns tasks inline (not via pagination headers). Query params:

- `limit` — default **10**, range **1–20** (invalid values return 400)
- `task_cursor` — opaque continuation cursor from `next_task_cursor`
- `status_filter`, `fields`, `since` — see entity status docs

The response includes:

- `has_more_tasks`
- `next_task_cursor` when another task page exists

Check-in task pages are ordered by `(updated_at DESC, task_id DESC)`.

## Query endpoints (`/queries/full`, `/queries/changed-since`)

These endpoints use per-type **limits** and opaque cursors. When a stream is truncated, the response includes `has_more_*` booleans and opaque **`next_*_cursor`** strings. Pass them back on the **next request** as query parameters to continue **without skipping rows**:

| Response field | Query parameter (next request) |
| --- | --- |
| `next_entity_cursor` | `entity_cursor` |
| `next_task_cursor` | `task_cursor` |
| `next_object_cursor` | `object_cursor` |
| `next_deleted_entity_cursor` | `deleted_entity_cursor` |
| `next_deleted_task_cursor` | `deleted_task_cursor` |
| `next_deleted_object_cursor` | `deleted_object_cursor` |

For **`GET /queries/full`**, every response includes a **`version`** captured before the first page is read. The opaque continuation cursors carry that hydration baseline, so every page in the same traversal repeats the same `version` even when a later page contains a resource whose `metadata.version` is newer. Clients must not advance their global sync cursor from hydrated resource versions. Consume all full-dataset pages, use the response `version` as the baseline, then drain `GET /queries/changed-since?since_version=<version>` before treating the hydrated state as current.

For **`GET /queries/changed-since`**, use **`since_version`** as the incremental boundary. The response includes a monotonic **`version`** watermark; pass that value as `since_version` on the next poll after all pages for the current response are consumed. While following cursors for a truncated response, keep the same `since_version` and pass back the `next_*_cursor` value unchanged as the matching `*_cursor` query parameter. Treat every cursor as opaque: do not parse or construct it.

### Per-type caps

When limit query params are omitted or zero:

- `GET /queries/full` — up to **1000** rows per resource type (`entity_limit`, `task_limit`, `object_limit`)
- `GET /queries/changed-since` — up to **5000** rows per type when `limit_per_type` is zero

Invalid limit query params on these endpoints return **400** `VALIDATION_ERROR`.
