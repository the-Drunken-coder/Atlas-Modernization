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
- `version` (`BIGINT`, not null): monotonic change version used for sync ordering, `metadata.version`, and object ETags

## JSON Blob Fields

Common keys in `json`:

- `bucket` (string, server-generated from the configured storage bucket; read-only in API create/update bodies)
- `size_bytes` (non-negative integer)
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

`GET /objects` list responses omit `referenced_by` for compactness; `GET /objects/{object_id}` returns full metadata including `referenced_by`. `PATCH /objects/{object_id}` supports optimistic concurrency via `If-Match` / ETag from `GET`; object ETags are based on the monotonic object `version`.

`bucket` is returned as storage metadata, but clients must not send it in `POST /objects` or
`PATCH /objects/{object_id}`. Downloads always use Atlas Core's configured storage bucket and the
stored object path, so the server generates `bucket` metadata from that configured bucket.

When `DELETE /objects/{object_id}` removes metadata for an object with a stored
blob path, Atlas Core also records that blob path in `storage_deletion_outbox`
inside the same database transaction as the object tombstone. The service then
attempts immediate blob deletion. If storage deletion fails, the queued row
remains and the background reconciler retries until the path is deleted.

Uploads use `storage_upload_intents` to bridge the transaction boundary between
PostgreSQL and blob storage. An upload owns a renewable lease until its metadata
commit. If Core stops after writing the blob, the reconciler waits for the lease
and orphan grace period, then serializes its live-reference decision with object
metadata writes before queuing the unreferenced blob in
`storage_deletion_outbox`. Object path writers reject paths reserved by either
an upload intent or queued deletion, both before waiting for the database write
lock and again inside their transaction, so a deletion already in progress
cannot be outwaited and reused by live metadata.

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
- Upload size: configurable via `MAX_UPLOAD_SIZE_MB` (default `100`, must be `1..10240` MB; invalid config fails startup)
- View size: configurable via `MAX_VIEW_SIZE_MB` (default `10`, must be `1..100` MB; invalid config fails startup)
- Multipart in-memory parsing threshold: `32 MB` (overflow spills to disk)
- Pagination defaults: `limit=100`; `cursor` continues keyset pages; limit clamped to max `500`
