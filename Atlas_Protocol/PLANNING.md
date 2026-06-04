# Atlas Protocol Planning

Status: decision-complete planning document. The next implementation step is inventory, not schema authoring.

Atlas Protocol is the standalone contract package for Atlas data. It defines what valid Atlas data is, generates reusable artifacts for multiple systems, and stays independent from Atlas Core service behavior.

## Decisions

### Source Of Truth

Use CUE as the canonical authoring format.

CUE definitions are the only files humans should edit for protocol shape. Generated artifacts must be checked in, clearly marked as generated, and replaced through generation commands.

Planned generation flow:

1. Author contract definitions in `Atlas_Protocol/schema/`.
2. Validate checked-in examples in `Atlas_Protocol/examples/` against CUE.
3. Generate JSON Schema draft 2020-12 into `Atlas_Protocol/generated/jsonschema/`.
4. Generate TypeScript types and Ajv-compatible validators into `Atlas_Protocol/generated/typescript/`.
5. Generate Go types and validators for Atlas Core into `Atlas_Core/internal/protocol/`.
6. Run drift checks that fail when generated files no longer match current CUE source.

The CUE JSON Schema encoder is still a bootstrap risk. Current CUE releases support JSON Schema generation through `cue def --out jsonschema`, but the encoder has been described as experimental. The first slice must prove that generated JSON Schema, Ajv validation, and Go validation all agree for the same fixtures before Core switches over.

### Package Shape

Use `Atlas_Protocol/`, not `Atlas Protocol/`, for source and generated package material.

Target structure:

```text
Atlas_Protocol/
  PLANNING.md
  index.html
  cue.mod/
  schema/
    shared/
    entity.cue
    task.cue
    object.cue
    components/
  examples/
    entities/
    tasks/
    objects/
  generated/
    jsonschema/
    typescript/
  tools/
    generate/
    check/

Atlas_Core/
  internal/
    protocol/        # generated Go types and validators consumed by Core
```

Atlas Protocol owns source definitions and generation tooling. Atlas Core may expose a local command that invokes Protocol-owned tooling to refresh `Atlas_Core/internal/protocol/`, but Core must not become the source of truth.

### Generated Outputs

Initial outputs:

- JSON Schema draft 2020-12 for cross-language validation.
- TypeScript package artifacts: generated types and Ajv-compatible validators.
- Go package artifacts: generated types and validators for Atlas Core.

Deferred outputs:

- Postgres JSON validation artifacts.
- OpenAPI schema fragments.
- Human-readable generated reference docs.

Do not add database validation in the first build. Core still owns storage lifecycle and table behavior; Protocol owns JSON shape and validation.

### Ownership Boundary

Protocol owns shape and validity:

- Data structures, field types, required fields, and optional fields.
- Known entity and task component keys.
- Enum values and scalar constraints.
- Extension field rules.
- Example validation.
- Generated cross-language types and validators.

Atlas Core keeps behavior:

- HTTP routes, handlers, middleware, and auth.
- Database connections, table creation, SQL, row locks, transactions, and pagination.
- Merge and read-modify-write semantics.
- Task lifecycle transitions.
- Object storage wiring.
- Command catalog ownership.

If Atlas Protocol imports a database driver, knows about HTTP route behavior, or implements service operations, the boundary has been crossed.

### Command Catalog Boundary

The command catalog remains entirely in Atlas Core. It is not an Atlas Protocol domain package.

Protocol may validate generic task command payload shape, such as `components.command.type` and task parameter objects, because those are Atlas data contract fields. It must not own the command catalog contents, command execution semantics, or catalog storage.

### Replacement Policy

Do not build backwards-compatible protocol versioning during current development.

This repository is greenfield, with no real users and no real data yet. Protocol changes should be full replacements:

1. Change the CUE source.
2. Regenerate artifacts.
3. Update consumers.
4. Rebuild and test.

No compatibility shims, old protocol support, migration layers, or v1/v2 branching should be added unless the project later has real deployments that need them.

Drift detection is still required, but it must only answer: "were these generated files produced from the current protocol source?"

## Current Source Material

Atlas Protocol should be bootstrapped from current Atlas Core implementation and docs:

- `Atlas_Core/internal/models/`
- `Atlas_Core/internal/actions/validation.go`
- `Atlas_Core/internal/actions/component_validation.go`
- `Atlas_Core/internal/actions/entity_components.go`
- `Atlas_Core/internal/actions/geometry_validation.go`
- `Atlas_Core/internal/actions/task_components.go`
- `Atlas_Core/internal/serializers/`
- `Atlas_Core/internal/api/handlers/`
- `Atlas_Core/internal/database/db.go`
- `Atlas_Core/docs/database-structure/`
- `Atlas_Core/docs/database-structure/examples/`
- `Atlas_Core/command_catalog/` only as Core-owned context, not as Protocol-owned domain data.

Extraction must distinguish contract from behavior. For example, a component field range belongs in Protocol; a transaction, merge rule, task state transition, or storage upload flow stays in Core.

## Inventory Phase

The first implementation phase is inventory only. Do not create CUE schemas until this inventory is complete and reviewed.

Inventory deliverable:

- A table of every current entity, task, object, component, request, response, extension field, and legacy alias.
- Each entry marked as `required`, `optional`, `generated`, `promoted column`, `JSON blob`, `extension`, `legacy`, or `behavior-only`.
- A canonical-shape decision for each legacy or duplicated shape.

Initial inventory from current Core:

| Area | Current contract material | Classification | Protocol decision |
| --- | --- | --- | --- |
| Resource IDs | `entity_id`, `task_id`, `object_id`; non-empty after trim; max 50; starts alphanumeric; allows alphanumeric, `.`, `_`, `-` | Required ID primitive | Define shared ID primitive in Protocol. |
| Alias | Entity alias optional; max 255; starts alphanumeric; allows spaces, `.`, `_`, `-` | Optional promoted column | Define as optional entity field. |
| Timestamps | API metadata emits `created_at` and `updated_at`; components use RFC3339 strings | Generated/optional timestamp primitive | Define RFC3339 timestamp primitive; metadata timestamps are generated by Core. |
| Entity envelope | `entity_id`, `entity_type`, `subtype`, `alias`, `components`, `metadata`, `extra` | Entity contract plus Core-generated metadata | Protocol owns wire shape; Core owns create/update/list behavior. |
| Entity storage split | Columns: `entity_id`, `type`, `subtype`, `alias`; JSON blob contains `components` and extra metadata | Promoted columns plus JSON blob | Protocol documents public shape, not table layout behavior. |
| Entity extra | Create accepts typed `published_at`, `updated_at`; `extra` keys excluding promoted fields are stored in JSON | Extension fields | Define extension rules; decide whether typed `updated_at` remains in canonical wire input during inventory review. |
| Entity components | Known keys: `telemetry`, `geometry`, `task_catalog`, `media_refs`, `mil_view`, `health`, `sensor_refs`, `communications`, `task_queue`, `status`, `heartbeat`; `custom_*` allowed | Component catalog and extension namespace | Protocol owns known key set and `custom_*` rule. |
| Geometry | GeoJSON `Point`, `LineString`, `Polygon`; Atlas format `point_lat`, `point_lng`, `radius_m`, `polygon`, `line`; finite numeric coordinates; latitude/longitude ranges; max 10000 positions | Component shape and constraints | First slice includes geometry. Inventory must choose whether both GeoJSON and Atlas format remain canonical. |
| Telemetry | `latitude`, `longitude`, `altitude_m`, `speed_m_s`, `heading_deg`, `last_update`; finite numbers; lat/lon ranges; speed non-negative; heading `[0, 360)` | Component shape and constraints | First slice includes telemetry. |
| Status | `status.value` required non-empty string; optional `last_update` RFC3339 | Component shape and constraints | First slice includes object-form status only. |
| Heartbeat | `heartbeat.last_seen` required non-empty RFC3339 string | Component shape and constraints | First slice includes object-form heartbeat only. |
| Health | `battery_percent` optional finite number in `[0, 100]` | Component shape and constraints | Inventory before schema. |
| Military view | `classification` enum `friendly`, `hostile`, `neutral`, `unknown`, `civilian`; `last_seen` RFC3339 | Component shape and constraints | Inventory before schema. |
| Task catalog component | `supported_tasks` optional array of non-empty strings | Component shape and constraints | Protocol may validate shape, but command catalog contents stay in Core. |
| Media refs | Array of objects with required `object_id` and role enum `camera_feed`, `thumbnail`, `heatmap_data` | Component shape and constraints | Inventory before schema. |
| Sensor refs | Array of objects with required `sensor_id` and `type`; numeric FOV/orientation fields | Component shape and constraints plus legacy aliases | Keep documented names as canonical; remove legacy aliases when Protocol takes over. |
| Communications | `link_state` enum `connected`, `disconnected`, `degraded`, `unknown` | Component shape and constraints | Inventory before schema. |
| Task queue | `current_task_id` null or non-empty string; `queued_task_ids` array of non-empty strings | Component shape and constraints | Inventory before schema. |
| Task envelope | `task_id`, `status`, `entity_id`, `components`, `metadata`, `extra`; default status `pending` | Task contract plus Core behavior | Protocol owns wire shape; Core owns defaulting and lifecycle transitions. |
| Task components | Known keys: `command`, `parameters`, `progress`, `target`, `status_message`; `custom_*` allowed | Component catalog and extension namespace | Protocol owns known key set and `custom_*` rule. |
| Task command | Canonical object with required non-empty `type`; current Core also accepts legacy string command | Component shape plus legacy alias | Canonical object only; remove string command support when Protocol takes over. |
| Task parameters/target | Optional objects; `latitude` and `longitude` obey finite numeric lat/lon ranges when present | Component shape and constraints | Inventory before schema. |
| Task progress | `progress.percent` optional finite number `[0, 100]`; `updated_at` optional RFC3339; status endpoint clamps incoming progress | Component shape plus Core behavior | Protocol validates shape; Core keeps clamping behavior. |
| Task status message | Optional string component | Component shape | Inventory before schema. |
| Task result/error | `extra.result` and `extra.error` used by complete/fail helpers; model accessors expect result success/description/data and error code/message | Extra payload shape | Inventory decides whether these become Protocol-defined task extra fields. |
| Object envelope | `object_id`, `path`, `content_type`, `type`, `size_bytes`, `usage_hints`, `referenced_by`, `bucket`, `metadata`, `payload` | Object contract plus storage behavior | Protocol owns metadata shape; Core owns storage upload/download behavior. |
| Object storage split | Columns: `object_id`, `path`, `content_type`, `type`; JSON blob contains `bucket`, `size_bytes`, `usage_hints`, `referenced_by`, extra payload | Promoted columns plus JSON blob | Protocol documents public shape, not table layout behavior. |
| Object references | `referenced_by` array; each entry may include `entity_id` and/or `task_id`; used by query endpoints | Object metadata contract | Keep historical reference metadata intentional; validate shape, not referential behavior. |
| Object size | `size_bytes` non-negative int64-like JSON number; Core preserves large integer precision via `json.Number` | Object metadata constraint | Define integer/non-negative constraint. |
| Object usage hints | `usage_hints` array of strings; upload accepts singular `usage_hint` form field and stores array | Metadata shape plus handler behavior | Protocol owns array shape; upload form behavior stays in Core. |
| Object payload | Extra object metadata keys outside promoted fields become `payload` in full responses; list responses omit payload and `referenced_by` | Extension fields plus response shape | Define payload extension rule and separate full/list response shapes. |
| Pagination/cursors | List endpoints use limit/cursor headers and cursor internals | Behavior-only | Keep out of Protocol except response fields if later formalized. |
| Tombstones/deletions | Hard deletes record tombstones for changed-since behavior | Behavior-only | Keep out of Protocol unless changed-since wire shape is later formalized. |

Legacy and duplicate shapes to remove or canonicalize:

- `components.telemetry.speed_ms` -> use `speed_m_s`.
- `components.status` as a string -> use object form `{ "value": "..." }`.
- `components.heartbeat` as a string -> use object form `{ "last_seen": "..." }`.
- Task `components.command` as a string -> use object form `{ "type": "..." }`.
- Task `extra.progress` -> use `components.progress.percent`.
- Sensor aliases `fov_horizontal`, `fov_vertical`, `orientation_yaw`, `orientation_pitch`, `orientation_roll` -> use documented names `horizontal_fov`, `vertical_fov`, `horizontal_orientation`, `vertical_orientation`.
- Any versioned protocol payload language -> replace with full-regeneration and drift checks.

## First Build Slice After Inventory

After the inventory is complete, implement the smallest useful vertical slice:

1. Add CUE definitions for shared primitives and the entity envelope.
2. Add geometry, telemetry, status, and heartbeat components.
3. Copy/adapt representative entity examples into `Atlas_Protocol/examples/entities/`.
4. Validate examples against CUE.
5. Generate JSON Schema for the slice.
6. Generate TypeScript types and Ajv validators for the slice.
7. Generate Go types and validators into `Atlas_Core/internal/protocol/`.
8. Wire Atlas Core to consume only that generated entity slice.
9. Remove equivalent handwritten Core validators for the slice.
10. Add a drift check for generated files.

Do not attempt to replace every Core model and validator in the first build slice.

## Tooling Plan

Pin tool versions before generated files are committed.

Expected tools:

- `cue` for CUE evaluation, example validation, and JSON Schema generation.
- `json-schema-to-typescript` for TypeScript declarations.
- `ajv` for TypeScript/runtime validation.
- `go-jsonschema` or an equivalent Go generator for Go types and validators.
- A Protocol-owned `check` command that validates examples and verifies generated output is current.

Local fact: this repository currently has only `Atlas_Core/go.mod`; Protocol generation must not assume a separate Go module already exists.

## Acceptance Criteria

Inventory phase is complete when:

- Every field and component currently accepted by Core is listed with classification and canonical decision.
- Every known legacy input shape is either deleted from the future protocol or deliberately retained with a reason.
- `Atlas_Protocol/PLANNING.md`, top-level docs, and package references use `Atlas_Protocol/`.
- No CUE schema files are added before inventory review.

First generated slice is complete when:

- CUE validates all checked-in examples for the slice.
- Generated JSON Schema validates the same examples.
- Ajv validates the same TypeScript fixtures.
- Go generated validators pass parity tests against JSON Schema validation.
- Atlas Core tests pass with `go test ./...` from `Atlas_Core/`.
- A drift check fails if generated files are stale.
