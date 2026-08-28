# Task message

Task is FieldLink message ID 4 and defaults to high priority. It keeps Atlas
Task semantics separate from generic Resource CRUD.

## Variants

`state` pushes the complete current Atlas Task to its assigned asset:

```json
{
  "type": "task",
  "kind": "state",
  "task": {
    "task_id": "task-1",
    "asset_id": "asset-1",
    "command": "survey.search",
    "input": {},
    "status": "pending",
    "created_at": "2026-08-26T12:00:00Z",
    "updated_at": "2026-08-26T12:00:00Z"
  }
}
```

`sync` asks Core for every current Task belonging to one active runtime:

```json
{
  "type": "task",
  "kind": "request",
  "operation": "sync",
  "request_id": "sync-1",
  "asset_id": "asset-1",
  "runtime_id": "runtime-1"
}
```

Lifecycle requests use `acknowledge`, `start`, `progress`, `complete`, or
`fail`. Every request carries `request_id`, `asset_id`, `task_id`, and
`runtime_id` so the gateway can reject cross-Asset requests before calling the
SDK.
`progress` adds `body.progress` from 0 through 1. `complete` may add
`body.output`. `fail` requires `body.failure.code` and
`body.failure.message`. The Atlas SDK and Core validate the Protocol-specific
output and failure shapes.

Responses carry the same request ID, an application status, and the resulting Task or
Task list in `body`. FieldLink's canned Task responder keeps up to 64 replay
entries for the adapter-process lifetime, keyed by source and request ID.
Repeating identical JSON replays the first response; reusing an ID for different
JSON returns `409`. A future Atlas integration must own its application-level
replay policy.

Task has no create, delete, generic status setter, reorder, reject, or
asset-side cancel operation. Core cancellation arrives as a new authoritative
`state`. Delivery does not acknowledge a Task. The Asset application calls `acknowledge`
only after its handler accepts responsibility.

## Execution paths

No Atlas execution path exists yet. A future Gateway application may relay Core
Task state, while an Asset application may perform runtime-scoped
synchronization and lifecycle calls. Those applications must validate complete
Atlas Tasks through the SDK.

For a focused real-radio API call:

```bash
npm run fieldlink -- test \
  --a /dev/cu.usbmodem-A \
  --b /dev/cu.usbmodem-B \
  --message task \
  --task-request task.json \
  --allow-inbox-drain
```

Radio B returns a canned correlated response. This proves the Task request JSON
crossed FieldLink; it does not call Atlas or authenticate the sender.
