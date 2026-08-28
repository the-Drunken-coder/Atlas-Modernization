# Task storage

Tasks are immutable assignments with an explicit lifecycle. Atlas Core stores their public Protocol fields in dedicated columns plus validated JSON for input, output, failure, and cancellation. The table also stores the private idempotency key and bound runtime ID used for creation deduplication and execution fencing.

Implementation references:

- `internal/models/models.go`
- `internal/actions/task_create.go`
- `internal/actions/task_transition.go`
- `internal/actions/task_runtime.go`
- `internal/database/migrations.go`

## Columns

- `task_id`: Core-generated primary key
- `asset_id`: immutable target Asset ID; retained even if the Entity is later removed
- `command`: immutable Protocol Command name
- `input`: immutable validated JSON input
- `status`: `pending`, `acknowledged`, `in_progress`, `completed`, `failed`, or `cancelled`
- `progress`: optional monotonic value from `0` to `1`
- `output`: optional validated terminal output
- `completion_attempt`: private rejected completion payload used to recognize an exact retry
- `failure`: optional structured terminal failure
- `cancellation`: optional structured terminal cancellation
- `created_at`, `acknowledged_at`, `started_at`, `finished_at`, `updated_at`: lifecycle timestamps
- `idempotency_key`: private key for one tasking attempt
- `runtime_id`: private current process fence bound to the Task
- `version`: global feed change value

`asset_id`, `command`, `input`, and the runtime binding never change after creation. The Task resource intentionally does not expose the private idempotency key, runtime binding, rejected completion attempt, or a generic metadata blob.

## Creation and lifecycle

`POST /tasks` accepts only `asset_id`, `command`, and `input` and requires `Idempotency-Key`. Core validates the generated Command Catalog, the current ready runtime's Command Manifest, and the Command input before inserting anything. Repeating the same key and request returns the original Task; reusing the key with different tasking data is a conflict.

Generic Task patching and deletion do not exist. Lifecycle changes use the named routes:

- `POST /tasks/{task_id}/acknowledge`
- `POST /tasks/{task_id}/start`
- `POST /tasks/{task_id}/progress`
- `POST /tasks/{task_id}/complete`
- `POST /tasks/{task_id}/fail`
- `POST /tasks/{task_id}/cancel`

The current Asset runtime supplies `Atlas-Runtime-ID` for acknowledge, start, progress, complete, and fail. Operator cancellation does not use runtime context. Every accepted transition and its feed event commit together. Identical repeats are idempotent; the first accepted terminal transition wins. If output validation fails, Core retains the rejected JSON privately so only that same completion attempt can replay the resulting terminal failure.

## Runtime state

`asset_runtimes` stores the current runtime ID, readiness, stopped state, and fixed Command Manifest for each Asset. `asset_runtime_generations` records every runtime ID used by an Asset and whether Core explicitly stopped it. This history survives Entity deletion so recreating an Asset ID cannot reuse an old fence. Beginning a new registration fences the previous runtime and fails its nonterminal Tasks with `asset_restarted`. Tasks from an explicitly stopped generation keep `asset_stopped` semantics even if a replacement races the bounded drain.

Only the current ready runtime can receive work or make new Asset-side lifecycle changes. An exact terminal retry remains valid for the runtime already bound to that Task, even after a replacement registers, but a replacement runtime cannot replay the old runtime's response. Asset responses expose the current ready manifest read-only as `command_manifest`.

## Migration safety

The direct-cutover migration rebuilds the legacy Task table only when it is empty. It refuses to proceed when old Task rows exist so retained data is never discarded or guessed into the new contract. Development scratch data may be reset through the documented database workflow.
