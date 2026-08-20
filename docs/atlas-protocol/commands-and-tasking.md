# Commands and Tasking

This document defines the replacement domain model for asking Atlas assets to do work. It is the intended design for replacing the current task components and Core-owned command catalog.

The design is deliberately small: Atlas Protocol defines what work means, assets declare which work they can perform, and Tasks record individual executions.

## Language

**Command**:
A Protocol-defined type of work that expresses stable operator intent, such as `mobility.goto` or `sensing.scan_area`.
_Avoid_: Task type, capability type, action

**Task**:
One execution of one Command assigned to one Asset. Its assigned Asset never changes.
_Avoid_: Command instance, work item

**Tasking**:
The act of creating and submitting a Task to an Asset.
_Avoid_: Sending a Command, commanding

**Command Catalog**:
The complete Protocol-owned collection of Commands and their schemas. Assets cannot add Commands to it.
_Avoid_: Core catalog, asset catalog

**Command Manifest**:
The part of an Asset's published details that declares which Protocol Commands it supports and how that Asset performs them.
_Avoid_: Task catalog, asset-defined capability catalog

**Task Queue**:
The ordered work accepted by an Asset for later execution. Atlas presents one Task Queue per Asset even when the Asset uses more complex scheduling internally.
_Avoid_: Command queue

**Scheduling**:
A Command Manifest declaration of `queued` or `immediate` behavior. `queued` work joins the Task Queue; `immediate` work must enter execution less than one minute after tasking or fail permanently. Every execution remains a Task regardless of its scheduling.
_Avoid_: Immediate Task, Control Task, operational Task

## Core rules

1. Every Task executes exactly one Command.
2. Every Task is assigned to exactly one Asset when it is created.
3. A Task is never reassigned. Retasking means cancelling the old Task and creating another.
4. Only Commands in the Protocol catalog may be tasked.
5. An Asset may only be tasked with a Command in its current Command Manifest.
6. Commands describe operator intent and observable behavior, not the technology used to perform them.
7. Protocol owns Command names, definitions, input schemas, optional output schemas, lifecycle states, and manifest shape.
8. Core owns Task persistence, lifecycle enforcement, tasking order, safety interlocks, and delivery coordination.
9. The Asset runtime owns accepting work, local execution, and reporting execution outcomes.
10. Tasks intentionally do not record which operator or client created or cancelled them.
11. A new Asset runtime receives no work until its execution modules have established their own safe conditions and reported the runtime ready.

## Command Catalog

The Command Catalog moves into Atlas Protocol beside the schemas it references. There is one canonical catalog.

The initial generated catalog is intentionally empty. Atlas first ships the catalog machinery and the documented process for adding Commands, not a preset collection of Commands. Core therefore serves an empty array until a Command is deliberately added to Protocol.

When a Command is added, its definition has this shape:

```json
{
  "command": "sensing.scan_area",
  "name": "Scan Area",
  "description": "Observe a geographic area and publish resulting Track entities.",
  "input_schema": "atlas.sensing.ScanAreaRequest",
  "output_schema": "atlas.sensing.ScanAreaResult"
}
```

Each definition requires:

- `command`: the canonical namespaced identifier
- `name`: the operator-facing name
- `description`: the stable intent and observable effect
- `input_schema`: the Protocol schema used to validate Task input

`output_schema` is optional. A Command without a meaningful Task result omits it.

`scheduling` is optional in a Command definition. When present, it is a Protocol requirement rather than a default. Every manifest entry still declares its scheduling, and registration rejects an entry that contradicts the Command definition. When they are added, `mobility.stop`, `safety.emergency_stop`, and `safety.reset_emergency_stop` require `immediate` scheduling.

The catalog does not need wrapper metadata such as a catalog type, name, or description. Core may continue exposing a read-only catalog endpoint, but it serves the Protocol-owned catalog rather than maintaining another definition.

### Authored file layout

Command definitions are authored as one JSON file per operational namespace. The initial empty catalog has this layout:

```text
atlas_protocol/
├── commands/
│   └── README.md
├── schema/
│   └── jsonschema/
│       └── atlas.schema.json
└── generated/
    └── command_catalog.json

docs/atlas-protocol/commands/
└── README.md
```

Adding `sensing.scan_area`, for example, creates `commands/sensing.json` and `docs/atlas-protocol/commands/sensing/scan-area.md`. Other namespace files and documentation directories appear only when they contain a real Command.

Each namespace file contains a JSON array of Command definitions. Every `command` identifier in the file must use the filename as its namespace prefix. For example, every definition in `mobility.json` begins with `mobility.`.

Protocol generation loads every namespace file, rejects duplicate Command identifiers and namespace mismatches, sorts definitions by `command`, validates all referenced schemas, and writes the single canonical `generated/command_catalog.json`. With no namespace files it writes `[]`. The generated catalog is never edited directly, and there is no handwritten master index or second catalog in Core.

Input and output schemas remain named definitions in `schema/jsonschema/atlas.schema.json`. Behavioral documentation mirrors the namespace and Command name under `docs/atlas-protocol/commands/`. Namespace files are therefore the authored Command source, the generated catalog is the published aggregate, and the documentation explains behavior without duplicating machine-readable definitions.

### Namespaces

The first part of a Command name identifies its operational domain:

- `mobility`: direct movement, such as going to a position or stopping
- `navigation`: higher-level movement, such as following a route or target
- `sensing`: observing an environment or area
- `sensor`: directly operating a particular sensor
- `tracking`: locating or maintaining knowledge of a target
- `payload`: operating carried equipment
- `communications`: communication and relay work
- `lighting`: operating lights
- `airframe`: operating vehicle mechanisms
- `safety`: safety interlocks and recovery

Examples include:

```text
mobility.goto
mobility.stop
navigation.follow_route
sensing.scan_area
sensor.camera.capture
sensor.camera.stream
sensor.rf.scan
tracking.localize_emitter
payload.release
communications.relay
lighting.set_state
airframe.set_landing_gear
safety.emergency_stop
safety.reset_emergency_stop
```

These are examples of the namespace language, not Commands included in the initial catalog.

The catalog and developer documentation group Commands by this prefix. The operator interface may present related Commands together when that is clearer. In particular, all sensor-related Commands appear in one Sensors group even when their canonical namespaces differ. This is presentation only; there is no second category field carrying the same information.

### Intent over implementation

`sensing.scan_area` means that the Asset observes a geographic area and publishes Track entities for what it finds. It does not prescribe how the Asset observes the area.

Its input may include a positive `duration_seconds`. When present, the Asset scans for that duration unless the Task is cancelled or fails. When omitted, the Asset performs one bounded scan and completes according to the rule in its Asset-specific description and Command documentation. A scan without a duration must not run indefinitely.

An ADS-B-backed Asset and an AIS-backed Asset therefore advertise the same Command while describing different implementations:

- ADS-B Asset: “Uses the connected ADS-B source to publish aircraft Tracks.”
- AIS Asset: “Uses the connected AIS source to publish vessel Tracks.”

The operator sees both the stable Command description and the selected Asset's explanation. This makes the shared promise clear without hiding the meaningful difference between Assets.

### Command documentation

Every Command needs a reference page that explains:

- intent and observable guarantee
- input and output fields
- preconditions and reasons it may fail
- what completion means
- cancellation behavior
- durable Atlas resources it creates or changes
- examples for operators and Asset developers

Schema-derived field tables and examples can be generated. Behavioral explanations are written deliberately because a schema cannot explain what an Asset promises to do.

### Adding a Command

Adding a Command is one deliberate Protocol change. The same change must:

1. define the stable operator intent and observable guarantee
2. choose the operational namespace and add the definition to its namespace file
3. add or reuse the input schema and add an output schema only when the Task has a bounded result
4. write the Command reference page, including completion and cancellation behavior
5. add any purpose-built operator input needed by the command interface
6. add Asset implementation and manifest examples without leaking their technology into the Command name
7. add focused conformance and acceptance cases, including any special scheduling or safety policy
8. regenerate and validate the canonical catalog and language artifacts

A proposed Command does not enter the catalog until all applicable pieces exist. Test-only and demonstration actions do not receive permanent Command names merely to preserve the old catalog.

## Schemas

All named Command schemas live in Atlas Protocol. Core validates Task input before creating a Task, and the Asset validates that it can accept the particular request.

### Authored schema layout

Atlas Protocol keeps one canonical authored schema bundle:

```text
atlas_protocol/
├── schema/jsonschema/atlas.schema.json
├── examples/
└── generated/
```

`atlas.schema.json` is the source of truth. Reusable domain values, Command inputs, optional Command outputs, Task resources, lifecycle requests, manifest entries, and outcome reasons are named `$defs` within that bundle. Examples live under `examples/`, and generated language bindings and other derived artifacts live under `generated/`.

The Protocol does not split Command schemas into independently composed fragments or per-Command schema files. The schemas share enough domain types and lifecycle shapes that a single bundle keeps references, validation, and generation direct. This does not change the separately authored namespace files used for the Command Catalog.

Schemas may be shared when they represent the same domain value, not merely because two JSON objects happen to have the same fields.

For example, Commands can directly share `atlas.geometry.Position`:

```json
{
  "latitude": 38.8977,
  "longitude": -77.0365,
  "altitude_m": 120
}
```

Latitude and longitude use WGS84 decimal degrees. Altitude is optional and measured in meters above mean sea level. An execution module using another vertical reference is responsible for conversion. A Command that only needs a position can use this schema directly. A Command that needs a position plus additional settings uses its own request schema and composes the shared Position schema.

Commands with no input use one shared empty-object schema. Their Tasks carry `"input": {}`.

Schemas are validation and code-generation contracts. They are not a promise that every Command can be rendered as a generic form. Rich inputs such as locations, routes, media, and sensor settings should receive purpose-built operator interfaces.

## Command Manifest

An Asset publishes its Command Manifest as part of registration and includes an Asset-specific description for every entry. Initial manifests are empty because the initial Protocol catalog is empty. After `sensing.scan_area` is added, an entry could look like:

```json
{
  "command": "sensing.scan_area",
  "description": "Uses the connected ADS-B source to publish aircraft Tracks.",
  "scheduling": "queued",
  "supports_cancel": true,
  "supports_progress": false
}
```

Every entry explicitly declares:

- `command`: a Command from the Protocol catalog
- `description`: how this Asset fulfills that Command
- `scheduling`: `queued` or `immediate`
- `supports_cancel`: whether Atlas can interrupt the Task after execution begins
- `supports_progress`: whether the Asset reports meaningful numeric progress

The manifest does not repeat the Command's input or output schema references. Those always resolve through the Protocol catalog.
Each Command appears at most once in a manifest.

The manifest also has no `produces` field. Durable effects belong to the Command's behavioral documentation and normal Atlas resource systems, while bounded Task results belong to the optional output schema. A generic output list would duplicate those contracts and would misrepresent Commands such as `sensing.scan_area`, whose Track publications may be unbounded while it runs.

The manifest is fixed for the lifetime of the current Asset `runtime_id`, so the scheduling and lifecycle rules governing accepted Tasks cannot change underneath them. Publishing a different manifest requires a fresh runtime registration. A process restart creates that registration and republishes the manifest before Atlas sends it work.

An Entity with a registered Asset runtime cannot change `entity_type`. This keeps the runtime, manifest, and every bound Task under one Asset identity. Reclassify an unregistered Entity before starting its runtime, or delete and create a new Entity after its Tasks are terminal.

Core exposes the current ready runtime's manifest read-only in the Asset's details. It is absent while no runtime is ready, updates atomically when registration completes, and cannot be changed through generic Entity patching. This is the manifest the command interface uses for Command availability and Asset-specific descriptions.

### Scheduling

Scheduling is the sole canonical term for how a Task enters execution. Atlas does not define a separate execution-mode concept.

`queued` means the Task joins the Asset's ordered Task Queue. An Asset may acknowledge several queued Tasks, but only one queued Task is `in_progress` at a time.

`immediate` means the Task must enter `in_progress` less than 60 seconds after `created_at` or fail with code `immediate_start_timeout`. It does not wait for the queued Task to finish and never remains dormant until conditions become suitable. An immediate Task that misses this window is terminal and must never execute during later delivery or reconciliation.

Multiple immediate Tasks begin in tasking order without waiting for one another to finish. Core does not release a later immediate Task until the earlier one has entered `in_progress` or become terminal. Protocol-defined supersession rules may make an older Task terminal during creation of a newer one. Core alone records the resulting `cancelled` state; Assets do not invent supersession relationships.

The one-at-a-time rule applies to queued Tasks. Immediate Tasks may overlap a queued Task and one another when prompt interruption or an independent action is required. This hybrid is intentional; it does not create operator-visible execution groups.

Asset hardware does not change this operator-visible rule. A drone with a forward-facing camera may need to coordinate movement and sensing differently from a drone with a gimballed camera, but both still accept queued Tasks through the same single queue. Those physical resource constraints stay inside the Asset's Command implementation rather than becoming Atlas execution groups.

When emergency stop is added, it is the deliberate exception to ordinary immediate delivery. Its Core interlock persists even if the physical Task cannot start within the immediate window. A current or newly registered runtime establishes the required safe condition through its safety barrier rather than executing an expired Task.

This is the entire scheduling contract Atlas exposes. An Asset may internally coordinate motors, gimbals, radios, cameras, or other subsystems however it needs. Those private locks and queues do not become Atlas concepts.

## Task

A Task has a flat, known shape:

```json
{
  "task_id": "task-123",
  "asset_id": "asset-456",
  "command": "mobility.goto",
  "input": {
    "latitude": 38.8977,
    "longitude": -77.0365,
    "altitude_m": 120
  },
  "status": "pending",
  "created_at": "2026-08-17T14:30:00Z",
  "updated_at": "2026-08-17T14:30:00Z"
}
```

Core generates `task_id`. `asset_id`, `command`, and `input` are immutable. Fields that do not apply to the Task's current state are absent rather than `null`.

Tasks do not have generic `components`, `extra`, `parameters`, `target`, `related_resources`, or source identity fields. A Command's schema defines the contents of `input` and, when present, `output`.

Every Task creation request includes an opaque idempotency key outside the Task resource. The key is globally unique within one Atlas Core deployment rather than scoped to an Asset or client. Repeating creation with the same key returns the original Task rather than creating another physical action; reusing it with different tasking data, including a different Asset, is a conflict. The key identifies a tasking attempt, not an operator or client, and is not exposed as Task provenance.

### Lifecycle

Tasks use these states:

- `pending`: Core created the Task, but the Asset has not accepted it.
- `acknowledged`: the Asset received, validated, and accepted responsibility for the Task. For a queued Task, acceptance includes placing it in the Task Queue.
- `in_progress`: the Asset is actively executing the Task.
- `completed`: execution and any required Task output were confirmed.
- `failed`: the Task cannot complete.
- `cancelled`: Atlas withdrew the Task. This does not by itself prove that physical execution stopped.

A normal queued execution follows:

```text
pending -> acknowledged -> in_progress -> completed
```

An immediate Task does not expose a fleeting acknowledged state:

```text
pending -> in_progress -> completed
```

For an accepted immediate Task, `acknowledged_at` and `started_at` are recorded together. A rejected Task may move from `pending` to `failed`. A Task may fail or be cancelled from any nonterminal state when the operation is valid.

Every completed Task must first enter `in_progress`. `completed`, `failed`, and `cancelled` are terminal. The first valid terminal update wins, and the Task is entirely immutable afterward.

Core records authoritative lifecycle times:

- `created_at`
- `acknowledged_at`
- `started_at`
- `finished_at`
- `updated_at`

The applicable time is written atomically with each lifecycle change. Repeating the same lifecycle operation with the same data is an idempotent no-op. Repeating it with different data is a conflict.

### Lifecycle operations

The generic Task patch interface is replaced by explicit operation routes:

```text
POST /tasks/{task_id}/acknowledge
POST /tasks/{task_id}/start
POST /tasks/{task_id}/progress
POST /tasks/{task_id}/complete
POST /tasks/{task_id}/fail
POST /tasks/{task_id}/cancel
```

Their named Protocol request schemas and bodies are:

| Operation | Request schema | Body |
| --- | --- | --- |
| acknowledge | `TaskAcknowledgeRequest` | `{}` |
| start | `TaskStartRequest` | `{}` |
| progress | `TaskProgressRequest` | `{ "progress": 0.4 }` |
| complete | `TaskCompleteRequest` | `{ "output": { ... } }`, with output omitted when the Command defines none |
| fail | `TaskFailRequest` | `{ "failure": { "code": "execution_failed", "message": "..." } }` |
| cancel | `TaskCancelRequest` | `{ "cancellation": { "code": "requested", "message": "..." } }` |

Every successful operation returns the resulting `TaskResource`. Atlas does not define a separate response type for each transition.

Tasking clients create and cancel Tasks. The assigned Asset runtime acknowledges, starts, reports progress, completes, and fails them. Core applies restart transitions and may apply supersession or emergency transitions after Commands defining those policies are added.

Canonical lifecycle examples follow the operation names:

```text
atlas_protocol/examples/
├── requests/tasks/
│   ├── acknowledge.json
│   ├── start.json
│   ├── progress.json
│   ├── complete.json
│   ├── fail.json
│   └── cancel.json
└── responses/tasks/
    ├── acknowledged.json
    ├── started.json
    ├── progressed.json
    ├── completed.json
    ├── failed.json
    └── cancelled.json
```

### Progress

Progress is a number from `0` to `1`. It may only be reported while a Task is `in_progress` and only when the Asset manifest declares `supports_progress: true` for the Command.

Progress never decreases. Repeating the same value is a no-op; reporting a lower value is rejected. Assets that cannot provide stable, meaningful progress declare `supports_progress: false`.

### Failure and cancellation

A failed Task records a small structured reason:

```json
{
  "failure": {
    "code": "precondition_failed",
    "message": "The destination is outside the permitted operating area."
  }
}
```

A cancelled Task uses the same small shape under `cancellation`:

```json
{
  "cancellation": {
    "code": "superseded",
    "message": "A newer movement request replaced this Task."
  }
}
```

`code` and `message` are always present.

Task outcomes use closed Protocol enums rather than arbitrary strings:

- `TaskFailureCode`: `unsupported_command`, `precondition_failed`, `execution_failed`, `asset_restarted`, `immediate_start_timeout`, or `invalid_output`
- `TaskCancellationCode`: `requested` or `superseded`

`TaskFailure` and `TaskCancellation` each contain the applicable code and a human-readable message. Their codes use lowercase snake case. Transport and HTTP errors, such as `TASK_NOT_FOUND`, remain a separate concern and are never stored as Task outcomes. The meaning and valid use of each outcome code are documented in `docs/atlas-protocol/task-outcomes.md`.

Command-specific cancellation codes are added with the Commands that require them. Adding `mobility.stop` adds `mobility_stop`; adding `safety.emergency_stop` adds `emergency_stop`.

Pending and acknowledged Tasks can ordinarily be cancelled because execution has not begun. An `in_progress` Task can be ordinarily cancelled only when its manifest entry declares `supports_cancel: true`. When added, `mobility.stop` and emergency stop apply their Protocol-defined supersession rules regardless of that declaration.

`safety.emergency_stop` is the exception to client cancellation. After Core accepts it, tasking clients cannot cancel that Task in any nonterminal state. The `emergency_stop` cancellation code describes the earlier Tasks cancelled by the safety transition, not cancellation of the emergency-stop Task itself. Only the reset flow described below can withdraw the persistent safety interlock.

The Asset learns cancellation through runtime-scoped delivery. If it has already started the Task, its runtime aborts the matching local handler signal. Atlas does not define a second abort route or ask the Asset to cancel the Task again.

When completion and cancellation race, the first terminal change accepted by Core wins. Cancellation describes Atlas intent; the Asset publishes its current observed physical state separately.

### Output and durable results

If a Command defines an output schema, Core validates `output` and writes it atomically with completion. Output is absent before completion. A Command without an output schema omits output entirely.

Task output is a compact summary, not a second resource system. Durable products flow through the normal Entity and Object systems.

Bounded identifiers are useful when one Task naturally creates one or a few durable resources. A camera capture might complete with:

```json
{
  "output": {
    "object_id": "object-123"
  }
}
```

Potentially unbounded work uses summaries rather than growing identifier arrays. `sensing.scan_area` might complete with:

```json
{
  "output": {
    "tracks_created": 12,
    "tracks_updated": 37
  }
}
```

These are counts of unique Tracks affected during the Task, not counts of individual update operations. If exhaustive Task-to-resource history becomes a demonstrated need, it belongs in a separate paginated relationship model.

## Task Queue and delivery

All Tasks share one authoritative tasking order: ascending `created_at`, then `task_id` when creation times are equal. This order governs queued execution, the start order of immediate Tasks, and the ordering of Safety Commands. There is no priority field and no manual reordering.

Core's Task records are the source of truth. The Asset keeps the local queue it needs for execution, while operator interfaces derive the queue and current work from Tasks rather than from a second Entity component.

Task creation and lifecycle changes reach the Asset through bounded runtime-scoped polling:

1. Core persists the new Task or lifecycle change.
2. The current Asset runtime requests eligible work on its five-second delivery loop while running.
3. A separate reconciliation loop refreshes accepted Task states without delaying delivery.
4. Stable Task IDs make repeated delivery safe.
5. The Asset acknowledges only after validating, accepting, and placing queued work in its local Task Queue.

Cancellation reaches an accepted handler through status reconciliation. Commands later added with supersession or safety behavior use the same authoritative Task state. A disconnected Asset receives the current authoritative state when it reconnects rather than acting on an obsolete local copy. An immediate Task that did not start inside its 60-second window is already failed and is never delivered for execution after reconnection.

Core releases queued Tasks to a runtime in authoritative tasking order. It does not release a later queued Task until every earlier queued Task has been acknowledged or has become terminal. Immediate Tasks are released in tasking order without waiting for earlier immediate Tasks to finish. These rules prevent transport delay or reordering from changing execution order.

Transport delivery is not Task acknowledgement. WebSocket, change-feed, snapshot, cache, and other transport mechanisms remain adapters around the Task model rather than defining its semantics.

## Asset restarts

Each Asset process startup creates a fresh `runtime_id`. A temporary network reconnect keeps the same `runtime_id` and local Task Queue.

Registration is a physical-safety barrier, not merely a new network session. Before registration completes, every execution module that could have left physical behavior active must establish its own safe condition and report ready. The condition is deliberately module-specific: MAVLink mobility, ROS mobility, and sensor execution modules may require different actions. A module with no persistent physical behavior may immediately report ready.

Core does not define those module actions. It only requires the runtime-wide safe result. If any required execution module cannot establish or confirm its safe condition, the runtime is not ready and receives no Tasks.

### Execution-module safety interface

The Asset runtime owns a small registration interface for modules that can cause or preserve physical behavior:

```text
atlas_asset_runtime/src/
├── index.ts
├── execution-module.ts
├── safety-barrier.ts
└── runtime.ts

atlas_asset_runtime/test/
├── runtime.test.ts
└── safety-barrier.test.ts
```

Its conceptual contract is:

```ts
type SafeStateContext = {
  signal: AbortSignal;
};

interface ExecutionModule {
  readonly id: string;
  establishSafeState(context: SafeStateContext): Promise<void>;
}
```

MAVLink, ROS, sensor, and other execution modules implement this interface while keeping their physical procedures private. At startup, the runtime invokes every registered module and waits for every required safe state. It reports ready only after all succeed and receives no Tasks if any fail.

Core observes only whether the runtime-wide barrier is ready. Module identifiers, ordering, retries, and physical actions remain internal to the Asset runtime.

When an Asset process restarts:

1. It registers with a new `runtime_id`.
2. Its old local Task Queue is cleared.
3. Core atomically fails every nonterminal Task bound to the previous runtime with code `asset_restarted`.
4. Core rejects lifecycle updates from the old runtime.
5. The new runtime establishes safe conditions through its execution modules.
6. The new runtime republishes its Command Manifest and completes registration before it can receive work.

If Safety Commands are later added and the Core safety interlock is engaged, that change also extends the runtime barrier so the new runtime confirms emergency stop before it can receive any permitted work. Confirmation used for reset must come from the current runtime rather than stale Entity data.

This prevents an Asset from unexpectedly resuming stale physical work or accepting conflicting new work after a restart.

## Commands, observed state, and configuration

Atlas keeps three concerns separate:

- A Command requests a physical action now.
- Entity data reports the observed physical state now.
- Configuration defines defaults, policies, or automation for future behavior.

For example:

- `airframe.set_landing_gear` requests deployment or retraction now.
- Entity data reports whether the gear is currently deployed.
- Configuration may later define an automatic deployment policy.

State-setting Commands are explicit, such as `lighting.set_state`, rather than toggles. They are safe to repeat and make operator intent inspectable. Completion means the requested physical state was confirmed when the Asset can observe it. Any weaker guarantee must be explicit in that Command's documentation.

Direct configuration changes must not become a hidden second tasking system.

## Stopping movement

The initial empty catalog does not include `mobility.stop`, and the initial implementation contains no dormant stop policy. The following rules become mandatory in the same change that adds this Command.

That change also adds `mobility_stop` to `TaskCancellationCode`.

`mobility.stop` is an immediate controlled halt. Core atomically creates it, engages a mobility-stop barrier, and cancels every earlier queued Task for the same Asset, regardless of domain. This deliberately favors a simple and safe rule over trying to model which Asset-specific operations might use mobility.

No later queued Task may enter `in_progress` while the barrier is engaged. Successful completion of a stop Task confirms the physical halt and clears the barrier.

Failure, cancellation, or `immediate_start_timeout` does not clear the barrier because none confirms that movement stopped. Core accepts a replacement `mobility.stop` while the barrier is engaged; successful completion of that replacement clears the barrier and releases later queued work. This prevents both unsafe automatic release and a failed stop from becoming an unrecoverable queue block.

If the stop Task fails, is fenced by a restart, or reaches its start deadline, the halt remains unconfirmed and later queued work stays blocked. Recovery requires a new `mobility.stop` Task to complete; an operator cannot release the blocked queue by cancelling or dismissing the failed attempt.

Movement Tasks created after the stop remain valid.

## Safety

The initial empty catalog includes no Safety Commands, interlock persistence, or dormant Safety policy. The following target rules become mandatory in the same change that adds the applicable Commands.

That change also adds `emergency_stop` to `TaskCancellationCode` and extends the runtime safety barrier and registration handshake with the emergency-stop requirement.

Safety operations are ordinary Commands in the `safety` namespace, with additional Core enforcement where physical safety requires it. They are not a separate kind of Task.

### Emergency stop

Core atomically creates a `safety.emergency_stop` Task, engages the safety interlock, and cancels every earlier nonterminal Task for the Asset. Concurrent ordinary tasking therefore either occurs before that transition and is cancelled or occurs afterward and is rejected; it cannot slip between those effects.

The atomic transition:

1. creates the emergency-stop Task
2. immediately engages a persistent Core safety interlock
3. cancels all earlier nonterminal Tasks for that Asset, regardless of domain
4. blocks new non-safety tasking before Task creation

After the transition commits, Core attempts physical emergency stop by delivering the immediate Task.

The emergency-stop Task cannot be cancelled by a tasking client, including while it is still pending. Once Core has accepted the Task, only a completed `safety.reset_emergency_stop` can clear the interlock. A delivery failure or operator change of mind cannot silently withdraw the safety intent.

The Core interlock remains engaged if delivery fails or physical state is unknown. Repeated emergency-stop tasking safely reasserts the request. The newest safety intent governs the interlock, so a late result from an older Safety Task cannot override it.

The Asset independently rejects ordinary work while its safety latch is active. It publishes `emergency_stop_active` as observed Entity state. Missing or stale observed state means the physical state is unknown.

### Reset

`safety.reset_emergency_stop` is an immediate Command with empty input. It has no passcode, special identity requirement, or reference to the emergency-stop Task.

Reset is accepted only after the physical emergency stop has been confirmed active. If the Asset requires a local physical switch release, reset fails until that happens. The Core interlock clears only when the reset Task completes.

While the interlock is engaged, Core and the Asset accept only `safety.*` Commands. The interlock survives Asset process restarts. Previously cancelled Tasks never resume after reset.

Safety tasking uses the same authentication as other tasking. Tasks retain no record of who initiated either emergency stop or reset.

## Operator experience

When an operator selects an Asset, Atlas shows only the Commands in that Asset's current manifest. For each Command it shows:

1. the stable Protocol description: what the Command means everywhere
2. the Asset description: how this Asset performs it
3. the purpose-built input interface
4. whether it runs immediately or joins the Task Queue
5. whether an active Task can be cancelled and whether it reports progress

With the initial empty catalog and manifest, Atlas shows an intentional no-Commands state. It does not fall back to the retired Core catalog or invent controls from Asset data.

Task state is presented in user language:

- Pending: sent by Atlas, not yet accepted by the Asset
- Acknowledged: accepted and waiting in the Asset's Task Queue
- In progress: actively executing
- Completed: finished successfully
- Failed: could not complete
- Cancelled: withdrawn by Atlas

## Acceptance

The rebuild uses one Protocol-owned scenario corpus with focused consumers in each affected module:

```text
atlas_protocol/conformance/tasking/
├── lifecycle.json
├── scheduling.json
├── outcomes.json
└── restart.json

atlas_core/internal/integration/
└── tasking_acceptance_test.go

atlas_sdk/test/
└── tasking-wire.test.ts

atlas_asset_runtime/test/
└── tasking-fixtures.test.ts

atlas_simulations/test/
└── fake-core-tasking.test.ts
```

The JSON corpus defines portable inputs, events, and expected outcomes. Concrete Core tests are authoritative for lifecycle, ordering, runtime fencing, expiry, and transactional persistence. The SDK test verifies wire mapping, the Asset runtime test verifies fixture compatibility, and the simulation test verifies its in-memory adapter. None of those fake-backed tests claim Core lifecycle conformance. Because the shipped catalog starts empty, the focused consumers use test-only fixture Commands that are excluded from the generated catalog.

The empty-catalog infrastructure is not complete until these behaviors are demonstrated:

1. Task creation validates the Command, current Asset manifest, and input before persisting anything.
2. Repeating a creation request with the same idempotency key returns one Task and causes at most one physical action.
3. Queued Tasks are acknowledged and enter execution in authoritative `created_at` order.
4. An immediate Task enters `in_progress` less than 60 seconds after creation or fails permanently with `immediate_start_timeout`.
5. An expired immediate Task never executes after reconnection or reconciliation.
6. Progress is accepted only when advertised, only while in progress, and never decreases.
7. Completion validates any required output and commits the output and terminal transition atomically.
8. Competing terminal operations obey first-valid-update-wins and cannot mutate a terminal Task.
9. A restart fences the old runtime, fails its nonterminal Tasks, and establishes every registered module's safe state before new work is delivered.
10. The generated production catalog is empty, Core serves it unchanged, ready runtimes publish empty manifests, and production Task creation rejects every Command.

Command-specific acceptance travels with the change that adds that Command. In particular:

- adding `mobility.stop` must prove it cancels earlier queued work, blocks later queued execution until the halt is confirmed, retains the barrier after a failed stop, and releases it after a replacement stop completes
- adding `safety.emergency_stop` and `safety.reset_emergency_stop` must prove the interlock, cancellation, reset, and stale-runtime rules in this document
- adding `sensing.scan_area` must prove optional-duration completion and that different Asset implementations can publish their distinct Track types through the Entity system

## Replacement seam

This is a semantic rebuild, not a teardown of every task-aware subsystem.

Replace:

- the Core-owned command catalog
- generic Task components and arbitrary Task patches
- duplicated lifecycle definitions
- mutable Task assignment
- the Entity `task_queue` component
- task deletion as a normal operator action
- technology-specific Commands that express the same operator intent

Keep and adapt:

- Core persistence and transactions
- REST delivery surfaces
- snapshots and changed-since recovery
- WebSocket and other feed transports
- SDK cache and synchronization machinery
- pagination and concurrency protections
- the read-only catalog endpoint

The rebuilt Task module should expose the small lifecycle interface described here and hide persistence, validation, ordering, interlocks, and transport coordination behind it. Callers should not reimplement Task rules.

## Delivery sequence

The executable module-by-module work plan, cutover rules, and validation gates are defined in [Commands and Tasking Implementation Plan](commands-and-tasking-implementation-plan.md).

1. Add the empty Protocol catalog structure, Command authoring guide, canonical schema definitions, lifecycle requests, outcome enums, examples, conformance fixtures, generated Command Catalog, Task shape, lifecycle states, and manifest shape.
2. Replace Core Task behavior and have Core serve the Protocol-owned catalog.
3. Update the SDK and Asset runtime registration, local Task Queue, lifecycle operations, execution-module safety barrier, and runtime fencing.
4. Update the command interface to use manifests, purpose-built inputs, and the new Task lifecycle.
5. Update simulations, examples, focused tests, and developer documentation.
6. Remove the old catalog, generic Task mutation paths, duplicate status lists, and obsolete Task components.

Because Atlas is greenfield, replacement should be direct. Do not build parallel task systems or compatibility paths.

## Explicitly deferred

The design does not add:

- asset-defined Commands
- remote or asset-supplied schemas
- scheduling priorities or manual queue ordering
- exposed execution groups or subsystem locks
- a generic automatic form framework
- exhaustive Task-to-resource lineage
- individual Task deletion
- fine-grained tasking identity or provenance
- per-Asset authorization or runtime credentials
- special credentials for safety reset
- catalog generations, per-Command generations, or compatibility negotiation

These should be reconsidered only after a real operating need appears.
