# Error Handling

_Revision: 2026-05-29_

## Overview

Atlas Core returns a consistent JSON error envelope from **HTTP handler** code paths. Error mapping is
implemented in `internal/api/handlers/handler_http.go` (`handleActionError`, `writeError`,
`writeValidationError`).

**Exception:** `APIKeyAuth` (`internal/api/middleware/middleware.go`) returns **401 Unauthorized** with a small JSON body (`success`, `message`, `error_code`) and does **not** include `error_id`, `timestamp`, or `path`. Treat auth failures separately from handler-generated errors.

## Error Types Used by the Go Service

### Action-layer errors (`internal/actions`)

- `ValidationError` (includes `Details []string`)
- `NotFoundError`
- `ConflictError` (409 — duplicate id or unique constraint)
- `PreconditionFailedError` (412 — stale `If-Match` on object PATCH)
- `ActionError` (base typed error)

`NotFoundError` is produced by helpers such as:

- `NewEntityNotFoundError` (`ENTITY_NOT_FOUND`)
- `NewAliasNotFoundError` (`ENTITY_ALIAS_NOT_FOUND`) — unknown alias on `GET /entities/alias/{alias}`
- `NewTaskNotFoundError` (`TASK_NOT_FOUND`)
- `NewObjectNotFoundError` (`OBJECT_NOT_FOUND`)

`ConflictError` codes:

- `ENTITY_ALREADY_EXISTS` — duplicate entity id or unique constraint (e.g. alias)
- `TASK_ALREADY_EXISTS` — duplicate task id
- `OBJECT_ALREADY_EXISTS` — duplicate object id
- `OBJECT_PATH_CONFLICT` — duplicate storage path

`PreconditionFailedError` codes:

- `PRECONDITION_FAILED` — object PATCH rejected due to stale `If-Match` / ETag mismatch

### Storage-layer errors (`internal/storage`)

- `StorageError`
- `ObjectNotFoundError`
- `BucketNotFoundError`

## HTTP Status Mapping

| Error Type | HTTP Status | Error Code Source |
| --- | --- | --- |
| `*actions.ValidationError` | 400 | `validationErr.Code` (currently `VALIDATION_ERROR`) |
| `*actions.NotFoundError` | 404 | `notFoundErr.Code` |
| `*actions.ConflictError` | 409 | `conflictErr.Code` |
| `*actions.PreconditionFailedError` | 412 | `preconditionErr.Code` |
| `*actions.ActionError` | 500 | `actionErr.Code` |
| `*storage.StorageError` | 503 | `STORAGE_ERROR` |
| `*storage.ObjectNotFoundError` | 404 | `OBJECT_NOT_FOUND` |
| `*storage.BucketNotFoundError` | 404 | `BUCKET_NOT_FOUND` |
| Any unhandled error | 500 | `INTERNAL_SERVER_ERROR` |

## Handler-direct error codes

Some handlers call `writeError` directly (same envelope, not via `handleActionError`):

| Code | Typical HTTP | When |
| --- | --- | --- |
| `INVALID_JSON` | 400 | Malformed or empty JSON body |
| `BODY_TOO_LARGE` | 413 | Request body exceeds handler limit |
| `VALIDATION_ERROR` | 400 | Invalid query params or required field missing |
| `STORAGE_UNAVAILABLE` | 503 | MinIO not configured |
| `CONTENT_TYPE_NOT_VIEWABLE` | 400 | Object view on non-text content type |
| `FILE_TOO_LARGE` | 400 | View/download size exceeded |
| `READ_ERROR` | 500 | Failed to read object from storage |
| `INVALID_FORM` | 400 | Multipart upload parse failure |

**Note:** `OBJECT_NOT_FOUND` may come from either the action layer (catalog row missing) or the storage layer (blob missing in MinIO). Use HTTP status and context; do not assume a single source.

## Error Envelope

Handler-generated error responses use:

- `success` (`false`)
- `message`
- `error_code`
- `error_id`
- `timestamp`
- `path` (when available)
- `details` (optional; used for validation error detail arrays)

Example:

```json
{
  "success": false,
  "message": "Component validation failed (2 errors)",
  "error_code": "VALIDATION_ERROR",
  "error_id": "err_1a2b3c4d5e6f",
  "timestamp": "2026-02-13T17:42:15Z",
  "path": "/entities",
  "details": {
    "errors": [
      "Unknown component 'foo'",
      "telemetry.latitude: 120.000000 is out of range [-90, 90]"
    ]
  }
}
```

## Correlation and Logging

- `error_id` is generated in-process using 6 random bytes and an `err_` prefix.
- Error writes currently log at error level from handler code paths.
- Log fields include `error_id`, `error_code`, `path`, `method`, and HTTP status.

## Error Contract

- Do not rely on free-form `message` text for control flow.
- Use `error_code` and HTTP status as the stable machine-readable contract.
- Validation failures may include multiple field-level messages in `details.errors`.
