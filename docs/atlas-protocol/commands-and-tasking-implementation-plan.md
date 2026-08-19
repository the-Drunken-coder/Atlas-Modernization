# Commands and Tasking Implementation Plan

This is the execution companion to [Commands and Tasking](commands-and-tasking.md). That document defines the target state. This document defines how the repository reaches it.

## Outcome

The work is complete when Atlas has one Protocol-owned Command Catalog, one immutable Task resource, explicit lifecycle operations, runtime-scoped delivery, restart fencing, and the safety behavior defined in the target-state specification.

The cutover removes the old task shape and catalog. It does not leave adapters, dual endpoints, legacy schema definitions, or compatibility code behind.

## Starting inventory

The current implementation is spread across every major Atlas module:

| Module | Current responsibility | Directly affected files found in the starting inventory |
| --- | --- | ---: |
| `atlas_protocol` | Generic Task and Core catalog wire shapes, generated Go and TypeScript contracts | 17 |
| `atlas_core` | Generic Task persistence, patching, deletion, command coercion, and the authored catalog | 25 |
| `atlas_sdk` | Generic Task create, update, delete, status helpers, feed caching, and check-in Task types | 21 |
| `atlas_asset_runtime` | Periodic Task polling and sequential command execution | 2 |
| `atlas_command_interface` | Generic parameter forms, catalog loading, task creation, and task display | 20 |
| `atlas_simulations` | Task fakes, generated IDs, lifecycle helpers, and Task deletion during cleanup | 6 |

These counts identify the cutover surface, not a requirement to edit every matching file. Generated files and tests account for a meaningful portion of it.

## Cutover strategy

Implement the replacement on one dedicated branch and review it as one direct cutover pull request. Use ordered commits to make review possible, but do not merge partially migrated contracts into `main`.

This shape is deliberate:

1. Replacing `TaskResource` immediately affects Core, the SDK, the Asset runtime, the command interface, and simulations.
2. Merging those changes separately would require temporary schemas or compatibility adapters.
3. Atlas is greenfield, so an atomic repository cutover is simpler than maintaining two Task systems.
4. The final branch must remain the only supported system. Temporary branch-local breakage between commits is acceptable; a pushed review head must pass the full validation ladder.

No implementation phase creates a second runtime path. When a replacement is complete, its old implementation and old tests are deleted in the same branch.

## Core module seam

Keep `TaskActions` as the concrete Core Task module rather than introducing a repository interface with one implementation. HTTP handlers, the delivery transport, and the timeout worker are adapters around it. Domain rules stay inside it.

The module's external interface is limited to:

- begin and complete Asset runtime registration
- create a Task
- apply one named lifecycle operation
- get and list Tasks
- return currently deliverable work for a runtime

The implementation owns all validation, transactions, ordering, idempotency, runtime fencing, supersession, interlocks, and terminal-state races. Handlers only parse requests and serialize results. The delivery adapter never decides whether work is eligible.

Organize the implementation for locality:

```text
atlas_core/internal/actions/
├── task_actions.go
├── task_create.go
├── task_transition.go
├── task_query.go
├── task_runtime.go
├── task_scheduling.go
└── task_safety.go
```

Tests exercise the concrete Task module against the existing local PostgreSQL test database. Do not add a mock repository or expose private scheduling helpers for tests.

## Settled implementation choices

### Runtime registration handshake

A process restart and a temporary transport reconnect are different operations.

On process startup, the Asset runtime generates a fresh `runtime_id` and begins registration:

```text
POST /entities/{asset_id}/runtime
```

Core atomically records the new runtime, fences the previous runtime, fails its nonterminal Tasks with `asset_restarted`, and returns whether the persistent emergency interlock must be established. The new runtime is not ready and receives no work.

The runtime then calls `establishSafeState` on every registered execution module. After they all succeed, it submits the fixed Command Manifest:

```text
POST /entities/{asset_id}/runtime/ready
```

Core accepts the ready transition only for the current `runtime_id`. Repeating either registration call with the same data is idempotent. An old process cannot become current again after a newer runtime has registered.

A WebSocket reconnect keeps the same runtime and uses feed recovery. It does not repeat process registration, clear the local queue, or establish safe state again.

### Runtime context

Asset-only Task lifecycle calls and runtime-scoped delivery carry the current runtime ID in an `Atlas-Runtime-ID` header. This is execution fencing, not operator identity, and it is never exposed as Task provenance.

Task creation and operator cancellation do not require that header. Existing Atlas authentication remains unchanged.

### Persistence

Append a Core database migration rather than editing the immutable baseline migration. The migration must refuse to continue when the old `tasks` table contains rows. Developers may reset a scratch database; the migration must never silently delete or guess how to convert retained Task records.

The rebuilt persistence model stores:

- the public Task fields from the target-state specification
- the opaque idempotency key, not returned to clients
- the bound `runtime_id`, not returned in `TaskResource`
- lifecycle timestamps and the existing resource-feed change counter
- input, optional output, failure, and cancellation as validated JSON
- numeric progress separately from Command input and output

`asset_id`, `command`, `input`, and the internal runtime binding are immutable after creation. `asset_id` remains on the Task even if the Asset Entity is later removed; assignment must never turn into `null`.

Core also persists current Asset runtime state and the safety interlock in dedicated tables so registration, Task fencing, and safety transitions can lock and update them atomically. The current manifest belongs to the runtime record and is not editable through generic Entity patching.

### Task creation

`POST /tasks` accepts only `asset_id`, `command`, and `input`. Core generates `task_id` and requires an `Idempotency-Key` header.

In one transaction, creation:

1. locks the current ready runtime for the Asset
2. resolves the Command from the generated Protocol catalog
3. validates the Command against the runtime manifest
4. validates input using the referenced Protocol schema
5. applies any Command-defined scheduling or safety policy
6. stores the Task and idempotency key
7. records the resource-feed event
8. exposes newly eligible work to the delivery adapter

Repeating the key returns the original Task. Reusing it with different tasking data is a conflict.

### Lifecycle operations

Replace generic Task patching with the six explicit routes from the target-state specification. Replace Task deletion with permanent retention.

Each operation locks the Task and current runtime state, validates the transition, writes its timestamp and data, records the feed event, and commits once. The first valid terminal operation wins. A repeated identical operation returns the current Task; a conflicting repeat is rejected.

Core validates output before completion. Invalid output cannot partially complete a Task. Progress is stored from `0` to `1`, is accepted only while `in_progress`, requires manifest support, and never decreases.

### Scheduling and delivery

Preserve the general resource feed for operator clients. Add a runtime-scoped Task delivery adapter around the existing WebSocket and recovery machinery.

The runtime-scoped adapter asks the Task module for eligible work. It does not forward every pending Task merely because a feed event exists. This lets Core enforce:

- queued release in ascending `created_at`, then `task_id`
- one queued Task in progress at a time
- acknowledgement before a later queued Task is released
- immediate start order without waiting for earlier immediate completion
- current-runtime fencing
- safety-interlock filtering
- cancellation and supersession delivery

An in-process Core timeout worker fails immediate Tasks that have not started before the 60-second deadline. It also reconciles overdue Tasks at startup before any delivery occurs. It is a small timer and database query, not a second job or message-queue system.

The Asset runtime stops requesting pending Tasks through periodic Entity check-in. Check-in remains for telemetry and observed state. Task delivery is push-driven, and feed recovery reconciles missed changes from Core's authoritative records.

### Safety

Implement `mobility.stop`, `safety.emergency_stop`, and `safety.reset_emergency_stop` as Command policies inside the Task module, not special handler shortcuts.

Task creation for those Commands performs the required Task creation, cancellation, queue blocking, and interlock update in one database transaction. The safety state stores the governing Safety Task so a late outcome from older work cannot clear newer intent.

The Asset runtime independently latches emergency stop and rejects ordinary work while latched. Reset completion requires current-runtime confirmation of physical state. No passcode, extra identity, or Task provenance is added.

### Simulation cleanup

Simulations stop calling Task deletion because individual Task deletion no longer exists. Scratch runs may reset the scratch database. Deployed runs retain terminal Tasks as execution history and remove them from cleanup-ledger expectations.

Simulation-created Entities and Objects continue using the existing guarded cleanup path. A simulation must not invent an administrative Task-deletion endpoint to restore the previous cleanup behavior.

## Work plan

### Phase 1: Protocol catalog and contracts

Own this phase in `atlas_protocol/`.

1. Add the namespace catalog files under `atlas_protocol/commands/` and their authoring rules.
2. Consolidate current implementation-specific intent:
   - `adsb_monitoring` and `ais_monitoring` become `sensing.scan_area`.
   - `move_to_location` and `goto` become `mobility.goto`.
   - `hold_position` becomes `mobility.stop`.
   - `emergency_disarm` becomes `safety.emergency_stop`.
   - `rf_scan` becomes `sensor.rf.scan`.
   - `rf_calibrate` becomes `sensor.rf.calibrate`.
   - `get_signal_strength` becomes `tracking.localize_emitter` when the implementation actually creates a location estimate.
   - `return_to_home` becomes `navigation.return_home`.
   - `arm_test` and `motor_test` do not enter the permanent catalog unless they receive a stable operator guarantee and documented schema before cutover.
3. Add shared domain schemas, Command input and optional output schemas, the manifest, the flat Task resource, lifecycle requests, outcome codes, and runtime registration requests.
4. Add deterministic catalog aggregation to `tools/generate` and validation to `tools/check`.
5. Add canonical request, response, Task, manifest, and catalog examples.
6. Add and validate the shared conformance scenarios under `conformance/tasking/`.
7. Regenerate Go and TypeScript artifacts.
8. Remove `CommandParameterSchema`, generic Task components, `TaskUpdateRequest`, Task deletion events, `TaskCatalogComponent`, `TaskQueueComponent`, and check-in Task payload definitions that no longer exist.

Exit gate:

- all catalog schema references resolve
- duplicate Commands and namespace mismatches fail generation
- generated artifacts are reproducible
- Protocol tests and checks pass with no old Task contract remaining

### Phase 2: Core persistence and Task module

Own this phase in `atlas_core/internal/database/`, `atlas_core/internal/models/`, and `atlas_core/internal/actions/`.

1. Add the guarded Task-storage migration and migration tests for empty and non-empty databases.
2. Replace the generic JSON-blob Task model with the target fields and internal fencing fields.
3. Add persistent current-runtime and safety-interlock records.
4. Rebuild `TaskActions` around create, lifecycle transition, queries, registration, ordering, and safety.
5. Add database constraints and indexes for idempotency, runtime lookup, status lookup, and `(asset_id, created_at, task_id)` ordering.
6. Keep resource-feed recording inside the same transaction as every Task change.
7. Preserve Object references to `task_id` without coupling Object storage to Task output.

Exit gate:

- the Core module passes the lifecycle, idempotency, ordering, terminal-race, restart, stop, and safety scenario corpus directly through its public interface
- the non-empty migration safety test proves retained data cannot be discarded accidentally
- no caller can mutate assignment, Command, or input after creation

### Phase 3: Core routes and delivery

Own this phase in `atlas_core/internal/api/`, `atlas_core/internal/feed/`, and `atlas_core/cmd/atlas_core/`.

1. Add begin and ready runtime-registration routes.
2. Replace Task PATCH and DELETE with the six lifecycle routes.
3. Require and validate `Idempotency-Key` on creation.
4. Require current runtime context on Asset lifecycle operations.
5. Serve the generated Protocol catalog from the existing read-only catalog endpoint.
6. Add runtime-scoped delivery and reconnect reconciliation around the feed.
7. Add the immediate-deadline timeout worker and startup reconciliation.
8. Remove pending-Task delivery from Entity check-in while retaining telemetry behavior.
9. Remove `atlas_core/command_catalog/` and its duplicate coercion rules.

Exit gate:

- handler integration tests prove request validation and resulting Task resources for every route
- a stale runtime cannot acknowledge, start, progress, or finish a Task
- transport reconnect does not create a new runtime or reorder work
- Core restart fails overdue immediate work before it can be delivered

### Phase 4: SDK and Asset runtime

Own this phase in `atlas_sdk/` and `atlas_asset_runtime/`.

1. Replace SDK Task update, delete, and free-form status helpers with typed create and lifecycle methods.
2. Make the idempotency key required in the SDK create options so a retry reuses the same tasking attempt.
3. Add runtime begin, ready, and runtime-scoped delivery methods.
4. Keep Task resources in the existing SDK cache and snapshots, updated from ordinary feed events.
5. Split the Asset runtime into the target `runtime`, `execution-module`, and `safety-barrier` files.
6. Require a Protocol-valid manifest entry and handler for every advertised Command.
7. Run the safety barrier before marking a runtime ready.
8. Maintain one local queued executor plus independently abortable immediate executions.
9. Start, progress, complete, fail, and abort work only through the explicit lifecycle methods.
10. Apply cancellation and safety changes from runtime-scoped delivery immediately.
11. Remove periodic Task polling and the old `setStatus` behavior.

Exit gate:

- SDK request conformance tests cover every new request shape and header
- runtime tests cover queue order, immediate work, cancellation, progress, restart fencing, and failed safe-state establishment
- packed consumer checks prove the public SDK and runtime exports work outside the monorepo

### Phase 5: Command interface

Own this phase in `atlas_command_interface/`.

1. Load the Protocol catalog and selected Asset's current manifest.
2. Show only manifest-supported Commands and display both the stable and Asset-specific descriptions.
3. Replace the generic parameter-schema form with a registry of purpose-built inputs for the initial catalog.
4. Submit `{ asset_id, command, input }` with one idempotency key per user tasking attempt.
5. Add `in_progress`, progress, output, failure, and cancellation presentation.
6. Offer cancellation only when the Task state and manifest allow it.
7. Show whether a Command is queued or immediate.
8. Remove UI assumptions about Task components, mutable assignment, generic status messages, and Task deletion.

Exit gate:

- focused interface tests cover Asset-specific Command availability and descriptions
- input tests prove `sensing.scan_area` can target both ADS-B and AIS Assets through the same Command
- Task rows render every lifecycle and outcome state without reading removed fields

### Phase 6: Simulations and documentation

Own this phase in `atlas_simulations/`, `docs/`, and module READMEs.

1. Rebuild the simulation fake around the flat Task resource and explicit lifecycle operations.
2. Remove Task deletion from the cleanup ledger and update deployed-run safety tests.
3. Add one commanded-Asset closed-loop scenario that tasks two different Assets with `sensing.scan_area` and observes their distinct Track outputs.
4. Add restart, stale-runtime, immediate-timeout, cancellation, stop, and emergency-stop scenarios where a cross-module test adds evidence beyond the shared corpus.
5. Add Command reference pages and the outcome-code reference.
6. Replace Core, SDK, runtime, interface, simulation, API, and database documentation that describes the old system.
7. Remove old examples, fixtures, fake behavior, and duplicate status lists.

Exit gate:

- repository search finds no old Command IDs, task catalog, task queue Entity component, generic Task patch, Task delete, or component-based Task payloads outside historical migration tests
- the closed-loop scenario proves Command intent, runtime delivery, lifecycle updates, and Track publication together

### Phase 7: Final acceptance

Run the smallest checks during each phase, then run the complete repository ladder on the final cutover head:

```text
(cd atlas_protocol && go run ./tools/generate && go run ./tools/check && go test ./...)
(cd atlas_core && go test ./...)
npm ci
npm run lint --workspace @the-drunken-coder/atlas-sdk
npm run format:check --workspace @the-drunken-coder/atlas-sdk
npm test --workspace @the-drunken-coder/atlas-sdk
npm run lint --workspace @the-drunken-coder/atlas-asset-runtime
npm run format:check --workspace @the-drunken-coder/atlas-asset-runtime
npm run typecheck --workspace @the-drunken-coder/atlas-asset-runtime
npm test --workspace @the-drunken-coder/atlas-asset-runtime
npm run lint --workspace @the-drunken-coder/atlas-command-interface
npm run format:check --workspace @the-drunken-coder/atlas-command-interface
npm run typecheck --workspace @the-drunken-coder/atlas-command-interface
npm test --workspace @the-drunken-coder/atlas-command-interface
npm run lint --workspace @the-drunken-coder/atlas-simulations
npm run format:check --workspace @the-drunken-coder/atlas-simulations
npm run typecheck --workspace @the-drunken-coder/atlas-simulations
npm test --workspace @the-drunken-coder/atlas-simulations
npm run build
git diff --check
```

The final acceptance review checks every behavior listed in the target-state specification, confirms the generated catalog is the one served by Core, and verifies there is only one Task model from Protocol through the operator interface.

## Reviewable commit sequence

Use this commit order inside the direct cutover pull request:

1. Protocol catalog, schemas, examples, generated artifacts, and conformance corpus
2. Core persistence and deep Task module
3. Core runtime registration, lifecycle routes, delivery, timeout, and safety
4. SDK and Asset runtime
5. Command interface
6. Simulations, documentation, old-system deletion, and final acceptance fixes

Commits describe review slices, not mergeable intermediate products. The pull request is ready only when the last commit passes the full validation ladder.

## Explicitly not part of the implementation

Do not add:

- a legacy Task adapter
- old-to-new Task data conversion
- asset-defined Commands or remote schemas
- priority or manual queue reordering
- exposed subsystem locks or execution groups
- generic schema-generated operator forms
- Task source identity or operator provenance
- individual Task deletion
- a special safety-reset credential
- a separate job or message-queue platform

If a real implementation constraint requires one of these, stop and change the target-state design deliberately before adding it.
