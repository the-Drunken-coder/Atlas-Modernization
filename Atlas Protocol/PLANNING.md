# Atlas Protocol Planning

Status: planning first, implementation later.

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
- `Atlas_Core/docs/database-structure/examples/`
- `Atlas_Core/command_catalog/`
- `Atlas_Core/internal/database/db.go`

Extraction should distinguish contract from behavior. For example, a component field constraint belongs in protocol; a transaction or merge rule stays in Core.

## Proposed Package Shape

Target structure:

```text
Atlas Protocol/
  PLANNING.md
  index.html
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

The exact structure can change during design, but the package should keep source definitions, examples, generated artifacts, and tooling visibly separated.

## Planning Work Before Build

1. Inventory Atlas Core data shapes.
2. List every entity, task, object, and component field currently accepted.
3. Identify which fields are required, optional, extensible, or legacy.
4. Define extension rules for `extra`, `custom_*`, and free-form payloads.
5. Decide the exact generated artifact locations.
6. Decide how Atlas Core will consume generated Go types and validators.
7. Define the check command that proves generated artifacts are current.
8. Define example validation and add representative examples.
9. Decide what existing Core validators get replaced first.

## First Implementation Slice

After planning is complete, start with the smallest useful vertical slice:

1. Add CUE definitions for shared primitives and the entity envelope.
2. Add one or two core components, such as geometry and telemetry.
3. Validate existing entity examples against CUE.
4. Generate JSON Schema for that slice.
5. Generate Go types/validators for that slice.
6. Wire Atlas Core to consume only that generated slice.
7. Add a check command that fails when generated files drift from source.

Do not attempt to replace every Core model and validator in the first slice.

## Open Questions

- Which Core validators should be replaced first after the entity slice proves the workflow?
- Should TypeScript validators be generated directly, or should frontend consumers validate against generated JSON Schema?
- Should command catalog schemas live inside Atlas Protocol or remain a sibling artifact consumed by it?
- Should Postgres JSON checks be generated during development, or deferred until the model settles?
- Should the current `Atlas Protocol/index.html` be updated to remove language about protocol versioning and align with the full-replacement policy?
