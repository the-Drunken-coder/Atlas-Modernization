# Task JSON Structure

_Revision: 2026-02-13_

Tasks represent work items dispatched to entities. The `tasks` table stores promoted fields as
columns and task-specific detail in the JSON blob.

Implementation references:

- `internal/models/models.go`
- `internal/actions/task_actions.go`
- `internal/actions/task_components.go`
- `internal/actions/component_validation.go`

## Table Columns

- `task_id` (`VARCHAR(50)`, primary key)
- `status` (`VARCHAR(50)`, not null, default `pending`, indexed)
- `entity_id` (`VARCHAR(50)`, nullable, indexed, FK to `entities.entity_id` with `ON DELETE SET NULL`)
- `json` (`JSONB`, not null, default `{}`)
- `created_at` (`TIMESTAMPTZ`, not null)
- `updated_at` (`TIMESTAMPTZ`, not null)

## JSON Blob Shape

Typical `json` payload:

```json
{
  "description": "Move to specified location",
  "components": {
    "command": {
      "type": "move_to_location"
    },
    "parameters": {
      "latitude": 40.123,
      "longitude": -74.456,
      "altitude_m": 120
    },
    "progress": {
      "percent": 65,
      "updated_at": "2026-05-29T10:00:00Z",
      "status_detail": "En route to destination"
    }
  },
  "created_by": "controller-001"
}
```

Promoted fields (`task_id`, `status`, `entity_id`) are not stored in this blob.

## Supported Task Components

Known task components:

- `command`
- `parameters`
- `target` (optional location/object parameters, same lat/long rules as `parameters`)
- `progress`
- `status_message` (string)
- `custom_*` keys (extension namespace)

Validation highlights:

- `command.type`: required non-empty string; `command` must be an object
- `command.target`: optional arbitrary JSON value on command object
- `command.parameters`: optional arbitrary JSON value on command object
- `parameters.latitude` / `target.latitude`: finite number in `[-90, 90]` if provided
- `parameters.longitude` / `target.longitude`: finite number in `[-180, 180]` if provided
- `progress.percent`: finite number in `[0, 100]` if provided
- `progress.updated_at`: RFC3339 timestamp if provided
- `status_message`: string when present

## Status Semantics

The service defaults new tasks to `pending` when status is omitted.

Common statuses used by API helpers are:

- `pending`
- `acknowledged`
- `completed`
- `failed`
- `cancelled`

`Create`, `Update`, and `/tasks/{task_id}/status` trim and lowercase status values,
then reject anything outside the list above.

## Task Endpoints

| Endpoint | Method | Effect |
| --- | --- | --- |
| `/tasks` | `GET` | List tasks (paginated) |
| `/tasks` | `POST` | Create task |
| `/tasks/{task_id}` | `GET` | Fetch task |
| `/tasks/{task_id}` | `PATCH` | Merge task update |
| `/tasks/{task_id}` | `DELETE` | Delete task |
| `/tasks/{task_id}/acknowledge` | `POST` | Set status to `acknowledged` |
| `/tasks/{task_id}/complete` | `POST` | Set status to `completed`; optional `result` in request `extra` |
| `/tasks/{task_id}/fail` | `POST` | Set status to `failed`; optional `error` in request `extra` |
| `/tasks/{task_id}/status` | `POST` | Update status; optional `progress` (percent, 0–100; clamped) → `components.progress.percent`; optional `message` → `components.status_message` |
| `/entities/{entity_id}/tasks` | `GET` | List tasks for entity (paginated) |

## Limits

- Task create/update/status/complete/fail handler bodies are capped at `512 KB`.
- Pagination defaults to `limit=100`; `cursor` continues keyset pages; limit is clamped to max `500`.
