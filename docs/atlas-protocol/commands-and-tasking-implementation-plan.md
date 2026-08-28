# Commands and Tasking Implementation Plan

This is the execution companion to [Commands and Tasking](commands-and-tasking.md). That document defines the target state. This document defines how the repository reaches it.

The Protocol, Core, SDK, interface, and simulation portions remain current. The former `@the-drunken-coder/atlas-asset-runtime` package was removed on 2026-08-27. Atlas does not currently ship an Asset host implementation.

## Outcome

The work is complete when Atlas has one Protocol-owned but initially empty Command Catalog, one immutable Task resource, explicit lifecycle operations, runtime-scoped delivery, and restart fencing. Core must serve the empty catalog unchanged, and production Task creation must reject every Command until one is added through the documented process.

The cutover removes the old task shape and every old Command. It does not leave adapters, dual endpoints, legacy schema definitions, dormant Command policies, or compatibility code behind. Stop, emergency-stop, scan-area, and other Command-specific behavior is implemented only in the later change that adds that Command.

## Starting inventory

The current implementation is spread across every major Atlas module:

| Module | Current responsibility | Directly affected files found in the starting inventory |
| --- | --- | ---: |
| `packages/protocol` | Generic Task and Core catalog wire shapes, generated Go and TypeScript contracts | 17 |
| `services/core` | Generic Task persistence, patching, deletion, command coercion, and the authored catalog | 25 |
| `packages/sdk` | Generic Task create, update, delete, status helpers, feed caching, and check-in Task types | 21 |
| Former Asset Runtime package | Periodic Task polling and sequential command execution | 2 |
| `surfaces/command-interface` | Generic parameter forms, catalog loading, task creation, and task display | 20 |
| `simulations` | Task fakes, generated IDs, lifecycle helpers, and Task deletion during cleanup | 6 |

These counts identify the cutover surface, not a requirement to edit every matching file. Generated files and tests account for a meaningful portion of it.

## Cutover strategy

Implement the replacement on one dedicated branch and review it as one direct cutover pull request. Use ordered commits to make review possible, but do not merge partially migrated contracts into `main`.

This shape is deliberate:

1. Replacing `TaskResource` immediately affects Core, the SDK, Asset implementations, the command interface, and simulations.
2. Merging those changes separately would require temporary schemas or compatibility adapters.
3. Atlas is greenfield, so an atomic repository cutover is simpler than maintaining two Task systems.
4. The final branch must remain the only supported system. Temporary branch-local breakage between commits is acceptable; a pushed review head must pass the full validation ladder.

No implementation phase creates a second runtime path. When a replacement is complete, its old implementation and old tests are deleted in the same branch.

## Discrepancy resolutions

The planning audit resolved seven points that were previously missing or ambiguous:

1. One queued Task may be in progress at a time. Immediate Tasks may overlap queued and other immediate work when prompt interruption or independent action is required.
2. `sensing.scan_area` accepts an optional positive duration. Without one, an Asset performs one bounded scan under its documented completion rule; it never silently runs forever.
3. The initial generated Command Catalog contains no Commands. Test-only fixture Commands exercise tasking conformance but never enter the production catalog.
4. Core exposes the current ready runtime's manifest read-only in Asset details. The command interface does not infer support from the catalog or use a separate editable field.
5. Command Manifests have no `produces` field. Command documentation and optional output schemas describe results without duplicating resource-system behavior in each Asset.
6. Forward-facing and gimballed sensors do not create different Atlas scheduling models. Their physical coordination remains private to the Asset while Atlas exposes one queued executor plus immediate work.
7. The greenfield cutover changes the canonical catalog and schemas directly. It does not add catalog generations, per-Command generations, negotiation tables, or parallel compatibility contracts.

The numbered questions used to discover these decisions are not a second specification. The target-state design and this implementation plan are the authoritative result; future changes must update them rather than relying on conversation history.

## Core module seam

Keep `TaskActions` as the concrete Core Task module rather than introducing a repository interface with one implementation. HTTP handlers, the delivery transport, and the timeout worker are adapters around it. Domain rules stay inside it.

The module's external interface is limited to:

- begin and complete Asset runtime registration
- create a Task
- apply one named lifecycle operation
- get and list Tasks
- return currently deliverable work for a runtime

The implementation owns all validation, transactions, ordering, idempotency, runtime fencing, and terminal-state races. Handlers only parse requests and serialize results. The delivery adapter never decides whether work is eligible. Command-specific supersession and interlocks join this module only when the corresponding Command is added.

Organize the implementation for locality:

```text
services/core/internal/actions/
├── task_actions.go
├── task_create.go
├── task_transition.go
├── task_query.go
├── task_runtime.go
└── task_scheduling.go
```

Tests exercise the concrete Task module against the existing local PostgreSQL test database. Do not add a mock repository or expose private scheduling helpers for tests.

## Settled implementation choices

### Runtime registration handshake

A process restart and a temporary transport reconnect are different operations.

On process startup, the Asset runtime generates a fresh `runtime_id` and begins registration:

```text
POST /entities/{asset_id}/runtime
```

Core first records the new runtime as unready, so the previous process is fenced without holding one transaction across its entire Task backlog. It then fails the previous runtime's nonterminal Tasks with `asset_restarted` in committed batches of 100. An exact repeated Begin continues an interrupted drain. The new runtime receives no work, and Ready rejects until no stale nonterminal Task remains.

The runtime then calls `establishSafeState` on every registered execution module. After they all succeed, it submits the fixed Command Manifest:

```text
POST /entities/{asset_id}/runtime/ready
```

Core accepts the ready transition only for the current `runtime_id`. Repeating either registration call with the same data is idempotent. An old process cannot become current again after a newer runtime has registered. Registration stores the manifest and exposes it read-only in Asset details; the initial empty catalog permits only an empty manifest.

Deliberate process shutdown uses:

```text
POST /entities/{asset_id}/runtime/stop
```

A matching stop clears readiness and the manifest, publishes the Asset change, and fails that runtime's nonterminal Tasks with `asset_stopped` through the same committed batch drain. Missing and stale runtime IDs are successful no-ops, so a delayed shutdown cannot deactivate a newer process.

A WebSocket reconnect keeps the same runtime and uses feed recovery. It does not repeat process registration, clear the local queue, or establish safe state again.

### Runtime context

Asset-only Task lifecycle calls and runtime-scoped delivery carry the current runtime ID in an `Atlas-Runtime-ID` header. This is execution fencing, not operator identity, and it is never exposed as Task provenance.

Task creation and operator cancellation do not require that header. Existing Atlas authentication remains unchanged.

Atlas currently has one coarse API trust boundary: a valid API credential may mutate any Asset. Runtime registration uses that same boundary and is not Asset-scoped. Adding a credential only to registration would not create an effective Asset boundary while the same client can update or delete that Asset. Per-Asset authorization requires a system-wide authentication design and remains explicitly deferred.

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

Core persists current Asset runtime state in a dedicated table so registration and Task fencing can lock and update it atomically. The current manifest belongs to the runtime record, appears read-only in Asset details, and is not editable through generic Entity patching. A safety interlock table is added later with the Safety Commands that need it, not during the empty-catalog cutover.

### Task creation

`POST /tasks` accepts only `asset_id`, `command`, and `input`. Core generates `task_id` and requires an `Idempotency-Key` header. The key is globally unique within one Core deployment, not per Asset or client.

In one transaction, creation:

1. locks the current ready runtime for the Asset
2. resolves the Command from the generated Protocol catalog
3. validates the Command against the runtime manifest
4. validates input using the referenced Protocol schema
5. applies the Command and manifest scheduling rules
6. stores the Task and idempotency key
7. records the resource-feed event
8. exposes newly eligible work to the delivery adapter

Repeating the key returns the original Task. Reusing it with different tasking data, including a different Asset, is a conflict.

### Lifecycle operations

Replace generic Task patching with the six explicit routes from the target-state specification. Replace Task deletion with permanent retention.

Each operation locks the Task and current runtime state, validates the transition, writes its timestamp and data, records the feed event, and commits once. The first valid terminal operation wins. A repeated identical operation returns the current Task; a conflicting repeat is rejected.

Core validates output before completion. Invalid output atomically fails the Task with `invalid_output`; it cannot partially complete or leave the runtime retrying a deterministic rejection. Progress is stored from `0` to `1`, is accepted only while `in_progress`, requires manifest support, and never decreases.

### Scheduling and delivery

Preserve the general resource feed for operator clients. Add a runtime-scoped Task delivery endpoint for Asset runtimes.

The runtime-scoped adapter asks the Task module for eligible work. It does not forward every pending Task merely because a feed event exists. This lets Core enforce:

- queued release in ascending `created_at`, then `task_id`
- one queued Task in progress at a time
- acknowledgement before a later queued Task is released
- immediate start order without waiting for earlier immediate completion
- current-runtime fencing
- cancellation delivery

An in-process Core timeout worker fails immediate Tasks that have not started before the 60-second deadline. It also reconciles overdue Tasks at startup before any delivery occurs. It is a small timer and database query, not a second job or message-queue system.

The Asset runtime stops requesting pending Tasks through periodic Entity check-in. Check-in remains for telemetry and observed state. Independent five-second loops poll runtime-scoped delivery and reconcile accepted Task status with at most eight concurrent reads. A failed status read is isolated from the others, and slow reconciliation cannot delay new delivery.

Delivered immediate work is processed before queued acknowledgement. Queued Tasks enter a provisional local queue in authoritative `created_at`, `task_id` order before acknowledgement, so an ambiguous acknowledgement cannot drop or reorder work. The runtime confirms Start before calling the physical handler. Exact idempotent lifecycle writes retry after transport failures, HTTP 408, 429, and server errors; permanent responses are reconciled against a fresh authoritative Task. Startup uncertainty after runtime allocation is compensated through the exact runtime-stop request.

### Empty production catalog

The production catalog generated by this cutover is `[]`. Do not migrate, rename, or preserve any current Core catalog entry. Do not add dormant switches, handlers, database tables, or runtime behavior for `mobility.stop`, Safety Commands, or `sensing.scan_area`.

The concrete Task module accepts the generated catalog as data. Production supplies the empty generated catalog; conformance tests supply a small fixture catalog from `packages/protocol/conformance/tasking/fixtures/`. This is test data, not a second production catalog or an asset extension point.

When a real Command is added later, its change follows the Protocol authoring guide and includes its schemas, documentation, purpose-built operator input, Asset implementation, and any special Core policy. Safety Commands add their interlock persistence and atomic rules at that time. No passcode, extra identity, or Task provenance is introduced.

### Simulation cleanup

Simulations stop calling Task deletion because individual Task deletion no longer exists. Scratch runs may reset the scratch database. Deployed runs retain terminal Tasks as execution history and remove them from cleanup-ledger expectations.

Simulation-created Entities and Objects continue using the existing guarded cleanup path. A simulation must not invent an administrative Task-deletion endpoint to restore the previous cleanup behavior.

## Work plan

### Phase 1: Protocol catalog and contracts

Own this phase in `packages/protocol/`.

1. Add `packages/protocol/commands/README.md` with the complete cross-module process for adding a Command.
2. Add no production namespace files. Teach catalog generation to accept zero namespace files and deterministically emit `[]`.
3. Add shared domain schemas, the manifest, the flat Task resource, lifecycle requests, outcome codes, and runtime registration requests.
4. Add deterministic catalog aggregation to `tools/generate` and validation to `tools/check`.
5. Add canonical request, response, Task, empty-manifest, and empty-catalog examples.
6. Add test-only fixture Commands and the shared conformance scenarios under `conformance/tasking/`. Keep the fixtures outside `commands/` so generation cannot publish them accidentally.
7. Regenerate Go and TypeScript artifacts.
8. Remove `CommandParameterSchema`, generic Task components, `TaskUpdateRequest`, Task deletion events, `TaskCatalogComponent`, `TaskQueueComponent`, and check-in Task payload definitions that no longer exist.
9. Delete the old Core catalog without mapping or preserving any of its Command IDs.

Exit gate:

- the empty production catalog and non-empty fixture catalog both validate
- duplicate Commands and namespace mismatches fail generation
- generated artifacts are reproducible
- Protocol tests and checks pass with no old Task contract or old Command ID remaining

### Phase 2: Core persistence and Task module

Own this phase in `services/core/internal/database/`, `services/core/internal/models/`, and `services/core/internal/actions/`.

1. Add the guarded Task-storage migration and migration tests for empty and non-empty databases.
2. Replace the generic JSON-blob Task model with the target fields and internal fencing fields.
3. Add persistent current-runtime records and read-only manifest exposure in Asset details.
4. Rebuild `TaskActions` around create, lifecycle transition, queries, registration, and ordering.
5. Add database constraints and indexes for idempotency, runtime lookup, status lookup, and `(asset_id, created_at, task_id)` ordering.
6. Keep resource-feed recording inside the same transaction as every Task change.
7. Preserve Object references to `task_id` without coupling Object storage to Task output.

Exit gate:

- the Core module passes the lifecycle, idempotency, ordering, terminal-race, and restart scenario corpus directly through its public interface using fixture Commands
- the non-empty migration safety test proves retained data cannot be discarded accidentally
- no caller can mutate assignment, Command, or input after creation

### Phase 3: Core routes and delivery

Own this phase in `services/core/internal/api/`, `services/core/internal/feed/`, and `services/core/cmd/atlas_core/`.

1. Add begin and ready runtime-registration routes.
2. Replace Task PATCH and DELETE with the six lifecycle routes.
3. Require and validate `Idempotency-Key` on creation.
4. Require current runtime context on Asset lifecycle operations.
5. Serve the generated Protocol catalog from the existing read-only catalog endpoint.
6. Add runtime-scoped delivery polling and independent accepted-Task reconciliation.
7. Add the immediate-deadline timeout worker and startup reconciliation.
8. Remove pending-Task delivery from Entity check-in while retaining telemetry behavior.
9. Remove `services/core/command_catalog/` and its duplicate coercion rules.

Exit gate:

- handler integration tests use fixture Commands to prove request validation and resulting Task resources for every route
- a stale runtime cannot acknowledge, start, progress, or finish a Task
- delivery retries do not create a new runtime or reorder work
- Core restart fails overdue immediate work before it can be delivered
- the production catalog endpoint returns `[]` and production Task creation rejects every Command

### Phase 4: SDK

Own this phase in `packages/sdk/`.

1. Replace SDK Task update, delete, and free-form status helpers with typed create and lifecycle methods.
2. Make the idempotency key required in the SDK create options so a retry reuses the same tasking attempt.
3. Add runtime begin, ready, and runtime-scoped delivery methods.
4. Keep Task resources in the existing SDK cache and snapshots, updated from ordinary feed events.
Exit gate:

- SDK wire tests cover every new request shape and header
- packed consumer checks prove the public SDK exports work outside the monorepo
- Asset execution, local scheduling, and physical safe-state acceptance remain future Asset implementation work

### Phase 5: Command interface

Own this phase in `surfaces/command-interface/`.

1. Load the empty Protocol catalog and the selected Asset's read-only current manifest from Asset details.
2. Present a clear no-Commands state rather than showing old catalog entries or an empty broken form.
3. Replace the generic parameter-schema form with an empty registry for purpose-built Command inputs. The Command authoring guide explains how a later Command adds its form.
4. Keep typed Task submission and lifecycle presentation ready for future Commands without adding production form entries.
5. Add `in_progress`, progress, output, failure, and cancellation presentation using fixture Tasks in focused tests.
6. Remove UI assumptions about Task components, mutable assignment, generic status messages, and Task deletion.

Exit gate:

- focused interface tests prove the empty catalog and empty manifest produce the intentional no-Commands state
- fixture tests prove a later Command appears only when both the catalog and selected Asset manifest contain it
- Task rows render every lifecycle and outcome state without reading removed fields

### Phase 6: Simulations and documentation

Own this phase in `simulations/`, `docs/`, and module READMEs.

1. Rebuild the simulation fake around the flat Task resource and explicit lifecycle operations.
2. Remove Task deletion from the cleanup ledger and update deployed-run cleanup safeguards.
3. Use fixture Commands for restart, stale-runtime, immediate-timeout, cancellation, and overlap scenarios where a cross-module test adds evidence beyond the shared corpus.
4. Add the Command authoring guide and outcome-code reference. Add no production Command reference pages.
5. Document that scan-area, stop, and Safety acceptance travels with the later change that adds each Command.
6. Replace Core, SDK, runtime, interface, simulation, API, and database documentation that describes the old system.
7. Remove old examples, fixtures, fake behavior, and duplicate status lists.

Exit gate:

- repository search finds no old Command IDs, task catalog, task queue Entity component, generic Task patch, Task delete, or component-based Task payloads outside historical migration tests
- the command interface and Core both expose the intentional empty-catalog state without fallback behavior

### Phase 7: Final acceptance

Run the smallest checks during each phase, then run the complete repository ladder on the final cutover head:

```text
(cd packages/protocol && go run ./tools/generate && go run ./tools/check && go test ./...)
(cd services/core && go test ./...)
npm ci
npm run lint --workspace @the-drunken-coder/atlas-sdk
npm run format:check --workspace @the-drunken-coder/atlas-sdk
npm test --workspace @the-drunken-coder/atlas-sdk
npm run test:package --workspace @the-drunken-coder/atlas-sdk
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

The final acceptance review checks every empty-catalog infrastructure behavior listed in the target-state specification, confirms the generated `[]` catalog is the one served by Core, and verifies there is only one Task model from Protocol through the operator interface. Command-specific acceptance remains attached to the future change that adds each Command.

## Reviewable commit sequence

Use this commit order inside the direct cutover pull request:

1. Empty Protocol catalog machinery, Command authoring guide, schemas, examples, generated artifacts, and conformance fixtures
2. Core persistence and deep Task module
3. Core runtime registration, lifecycle routes, delivery, timeout, and runtime fencing
4. SDK
5. Command interface
6. Simulations, documentation, old-system deletion, and final acceptance fixes

Commits describe review slices, not mergeable intermediate products. The pull request is ready only when the last commit passes the full validation ladder.

## Explicitly not part of the implementation

Do not add:

- a legacy Task adapter
- old-to-new Task data conversion
- preset initial Commands or mapped legacy Command IDs
- dormant Command-specific policy code
- asset-defined Commands or remote schemas
- priority or manual queue reordering
- exposed subsystem locks or execution groups
- generic schema-generated operator forms
- Task source identity or operator provenance
- individual Task deletion
- a special safety-reset credential
- a separate job or message-queue platform
- catalog generations, per-Command generations, negotiation tables, or parallel compatibility contracts

If a real implementation constraint requires one of these, stop and change the target-state design deliberately before adding it.
