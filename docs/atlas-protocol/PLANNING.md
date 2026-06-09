# Atlas Protocol Planning

Status: bootstrap, task, object, and documented entity-component protocol slices are implemented in `../../atlas_protocol/`. Future work should continue from the generated module and keep this directory as planning/reference material.

Atlas Protocol will be the standalone contract package for Atlas data. It should define what valid Atlas data is, generate reusable types and validators for multiple systems, and stay independent from Atlas Core service behavior.

## Decisions

### Authoring language

Use CUE as the source of truth.

CUE is better suited than hand-authored JSON Schema for this project because Atlas data needs reusable definitions, composition, constraints, open extension fields, and generated outputs. JSON Schema remains useful, but as a generated artifact for validators, tooling, database checks, and external consumers.

Planned flow:

1. Author protocol definitions in CUE.
2. Validate checked-in examples against CUE.
3. Generate JSON Schema from CUE.
4. Generate Go and TypeScript types/validators from the protocol artifacts.

The first build should pin CUE through Go tooling instead of assuming a global `cue` binary. The prep pass verified `go run cuelang.org/go/cmd/cue@v0.16.1 version`.

### Scope

Plan the full target surface before implementation. Build it in slices after the plan is clear.

The protocol should eventually cover:

- Entity envelope and entity components
- Task envelope, task specification, task status, and task components
- Object envelope, metadata, media references, and object references
- Shared primitive constraints
- Geometry shapes and coordinate rules
- Telemetry and heartbeat/status components
- Media reference roles and storage-facing object metadata
- Command catalog references
- Timestamp, enum, identifier, and extension-field rules
- Example JSON validation
- Generated artifacts and drift checks

### Generated outputs

Generated outputs should be reusable by systems other than Atlas Core. Atlas Core is a consumer, not the owner.

Initial outputs:

- Go types
- Go validators
- JSON Schema
- TypeScript types

Later outputs to consider:

- TypeScript validators
- OpenAPI schema fragments
- Postgres JSON validation artifacts
- Human-readable reference docs

Generated files should be checked in and clearly marked as generated. They should not be hand-edited.

### Ownership boundary

Protocol owns shape and validity:

- Data structures and field types
- Known component keys
- Enum values
- Required fields
- Format and range constraints
- Extension rules
- Cross-language type and validator generation
- Example validation

Atlas Core keeps behavior:

- HTTP handlers
- Auth and middleware
- Database connections
- Table creation and SQL execution
- Transactions and row locking
- Merge and read-modify-write semantics
- Task lifecycle transitions
- Pagination and query execution
- Object storage wiring

If Atlas Protocol imports a database driver, knows about HTTP routes, or implements service behavior, the boundary has been crossed.

### Replacement policy

Do not build backwards-compatible protocol versioning during current development.

This repo is greenfield, with no real users or real data yet. During this phase, protocol changes should be full replacements:

1. Change the protocol source.
2. Regenerate artifacts.
3. Update consumers.
4. Rebuild and test.

No compatibility shims, old protocol support, migration layers, or v1/v2 branching should be added unless the project later has real deployments that need them.

Drift detection is still useful, but it should not become compatibility versioning. Prefer a generated content hash or revision stamp that only answers: "were these generated files produced from the current protocol source?"

## Source Material In Atlas Core

Atlas Protocol should be bootstrapped from the current Atlas Core model, docs, and examples.

Primary references:

- `Atlas_Core/internal/models/`
- `Atlas_Core/internal/actions/component_validation.go`
- `Atlas_Core/internal/actions/validation.go`
- `Atlas_Core/internal/serializers/`
- `Atlas_Core/docs/database-structure/`
- `atlas_protocol/examples/`
- `Atlas_Core/command_catalog/`
- `Atlas_Core/internal/database/db.go`

Extraction should distinguish contract from behavior. For example, a component field constraint belongs in protocol; a transaction or merge rule stays in Core.

## Proposed Package Shape

Target implementation structure:

```text
atlas_protocol/
  README.md
  go.mod
  cue.mod/
  schema/
    entity.cue
    task.cue
    object.cue
    components/
    shared/
  examples/
    entities/
    tasks/
    objects/
  generated/
    jsonschema/
    go/
    typescript/
  tools/
    generate/
    check/
```

Planning and reference documentation live under `docs/atlas-protocol/`. Buildable Go packages should stay in the root `atlas_protocol/` module, not under `docs/`.

## Build-Readiness Decisions

- First build slice: entity JSON blob plus `telemetry` and `geometry` components.
- First contract surface: storage/blob data shape, not the full HTTP API request/response surface.
- Module boundary: `atlas_protocol/` with module path `github.com/the-drunken-coder/atlas/atlas_protocol`.
- Core consumption: local `replace` from `Atlas_Core/go.mod` to `../atlas_protocol` during development.
- Canonical names only: do not encode Core's legacy aliases into the protocol source.
- Extension rules: component keys must be known or prefixed with `custom_`; custom component payloads and extra blob fields remain free-form JSON for the first slice.
- Generated artifacts: JSON Schema and Go validators first; TypeScript after the CUE-to-JSON-Schema and Go-validator path is stable.
- Drift gate: `go run ./tools/check` from `atlas_protocol/` must validate examples and fail on stale generated artifacts.
- First Core validator replacements: `ValidateTelemetryComponent` and `ValidateGeometryComponent`.

See `IMPLEMENTATION_PREP.md` for the inventory and acceptance criteria.

## First Implementation Slice

Start with the smallest useful vertical slice:

1. Create the `atlas_protocol/` module skeleton.
2. Add CUE definitions for shared primitives and the entity blob envelope.
3. Add `telemetry` and `geometry` component definitions.
4. Copy or reference existing entity examples and validate them against CUE.
5. Generate JSON Schema for that slice.
6. Generate Go types/validators for that slice.
7. Wire Atlas Core to consume only the generated telemetry and geometry validators.
8. Add a check command that fails when generated files drift from source.

Do not attempt to replace every Core model and validator in the first slice.

## Deferred Decisions

- TypeScript validators should wait until JSON Schema generation is stable; TypeScript types may still be generated earlier if low-friction.
- Command catalog schemas remain a sibling artifact for now; Atlas Protocol can reference command identifiers as strings until command ownership is revisited.
- Postgres JSON checks are deferred until the protocol model settles.
- HTTP request/response envelope schemas are deferred until blob/component validation proves the workflow.
