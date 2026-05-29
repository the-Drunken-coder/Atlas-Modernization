# Objects JSON Guide

_Revision: 2026-02-13_

Atlas Core stores object metadata in `objects`, with selected fields promoted to columns.
Binary content is served through the storage client when configured.

Implementation references:

- `internal/models/models.go`
- `internal/actions/object_actions.go`
- `internal/api/handlers/handler_object.go`
- `internal/api/handlers/handler_object_transfer.go`
- `internal/database/db.go`

## Table Columns

- `object_id` (`VARCHAR(50)`, primary key)
- `path` (`VARCHAR(500)`, unique, indexed)
- `content_type` (`VARCHAR(100)`, indexed)
- `type` (`VARCHAR(50)`, indexed)
- `json` (`JSONB`, not null, default `{}`)
- `created_at` (`TIMESTAMPTZ`, not null)
- `updated_at` (`TIMESTAMPTZ`, not null)

## JSON Blob Fields

Common keys in `json`:

- `bucket` (string)
- `size_bytes` (number)
- `usage_hints` (array of strings)
- `referenced_by` (array of objects, each with `entity_id` and/or `task_id`)
- additional metadata in extra keys

Promoted fields (`path`, `content_type`, `type`) are stored as columns, not in the blob.

## API Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/objects` | `GET` | List object metadata (paginated) |
| `/objects` | `POST` | Create object metadata |
| `/objects/{object_id}` | `GET` | Fetch object metadata |
| `/objects/{object_id}` | `PATCH` | Update object metadata |
| `/objects/{object_id}` | `DELETE` | Delete object metadata |
| `/objects/upload` | `POST` | Multipart upload: form fields `object_id`, `file` (required); optional `usage_hint` (singular), `type`. Does not accept `referenced_by` — use `PATCH` after upload. |
| `/objects/{object_id}/download` | `GET` | Download file attachment |
| `/objects/{object_id}/view` | `GET` | Inline view for supported text content types |
| `/entities/{entity_id}/objects` | `GET` | List objects referencing entity |
| `/tasks/{task_id}/objects` | `GET` | List objects referencing task |

Note: there is no dedicated `/objects/{object_id}/references` endpoint in the current service. Reference
links are updated by writing `referenced_by` on `POST /objects`, `PATCH /objects/{object_id}`, or
after `POST /objects/upload` via a follow-up `PATCH`.

`GET /objects` list responses omit `referenced_by` for compactness; `GET /objects/{object_id}` returns full metadata including `referenced_by`. `PATCH /objects/{object_id}` supports optimistic concurrency via `If-Match` / ETag from `GET`.

## Heatmap Convention

Heatmap data is modeled as a standard media object convention:

- object `type`: `heatmap`
- `usage_hints` includes `heatmap_data`
- `referenced_by` includes owning geofeature `entity_id`
- geofeature entity includes `components.media_refs` with role `heatmap_data`

Current implementation note: heatmap object metadata fields are convention-based. The server does not
currently enforce heatmap-specific metadata validation.

## Size Limits and Pagination

- Object metadata create/update body: `1 MB`
- Upload size: configurable via `MAX_UPLOAD_SIZE_MB` (default `100`, bounded `1..10240` MB)
- View size: configurable via `MAX_VIEW_SIZE_MB` (default `10`, bounded `1..100` MB)
- Multipart in-memory parsing threshold: `32 MB` (overflow spills to disk)
- Pagination defaults: `limit=100`, `offset=0`; limit clamped to max `500`
