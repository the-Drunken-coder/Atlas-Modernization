# Atlas Protocol Implementation Prep

Status: implemented for the bootstrap slice and extended through task, object, and documented entity-component blob validation in `../../atlas_protocol/`.

This document pins the decisions that must be true before Atlas Protocol becomes generated code. It narrows the first implementation pass to a small, useful slice while keeping the larger contract shape visible.

## Build Boundary

Buildable protocol code should live in a lower-case, importable sibling module:

```text
atlas_protocol/
  go.mod
  cue.mod/
  schema/
    entity.cue
    components/
      geometry.cue
      telemetry.cue
    shared/
      primitives.cue
  examples/
    entities/
  generated/
    jsonschema/
    go/
      atlasprotocol/
    typescript/
  tools/
    generate/
    check/
```

Planning and reference documentation live under `docs/atlas-protocol/`. Do not recreate a root-level `Atlas Protocol/` directory, and do not put Go packages that Atlas Core imports under `docs/`.

The Go module path for the protocol module should be:

```text
github.com/the-drunken-coder/atlas/atlas_protocol
```

During local development, `Atlas_Core/go.mod` should consume that module with a local `replace` directive:

```text
require github.com/the-drunken-coder/atlas/atlas_protocol v0.0.0
replace github.com/the-drunken-coder/atlas/atlas_protocol => ../atlas_protocol
```

Atlas Core is a consumer of generated protocol artifacts. Generated Go code should not be placed under `Atlas_Core/internal/` as the source of truth.

## Toolchain

CUE is the source language. This machine did not have a global `cue` binary on PATH during this prep pass, so the build should use a pinned Go-run toolchain path or a checked-in tool wrapper instead of relying on a developer-global install.

Use CUE `v0.16.1` for the first build slice. This command was verified in this checkout:

```sh
go run cuelang.org/go/cmd/cue@v0.16.1 version
```

The public commands for contributors should be wrappers inside `atlas_protocol/tools/`:

```sh
go run ./tools/generate
go run ./tools/check
```

`generate` should regenerate every generated artifact from CUE. `check` should fail if examples do not validate or generated files differ from the current CUE source.

## Contract Surface

Start with the storage/blob contract, not the full HTTP API contract.

The generated protocol slices now own:

- Shared primitive constraints used by Atlas data.
- Entity JSON blob shape.
- Entity component key rules.
- `components.telemetry`.
- `components.geometry`.
- Documented entity component payloads for task catalog, media refs, mil view, health, sensor refs, communications, task queue, status, and heartbeat.
- Task JSON blob shape and task components.
- Object JSON blob shape and object references.
- Example validation for checked-in entity, task, and object JSON examples.
- Generated JSON Schema for implemented slices.
- Generated Go types/validators for implemented slices.
- A drift check proving generated files came from the current CUE source.

The current generated slices do not own:

- HTTP handlers, routes, auth, pagination, request body size limits, or error response shape.
- Database DDL, table lifecycle, transactions, row locking, or storage wiring.
- Task lifecycle semantics.
- Object media upload/download behavior.
- TypeScript validators or Postgres JSON checks.

## First Slice Inventory

### Entity Blob

The first CUE schema should validate the JSON blob shape currently shown by `atlas_protocol/examples/entities/*.json`:

- `components` is optional, but when present it is an object keyed by component name.
- `published_at` is optional and must be RFC3339 when present.
- Other top-level blob fields are allowed as extension metadata.
- Promoted fields such as `entity_id`, `entity_type`, `type`, `subtype`, `alias`, `created_at`, and `updated_at` are not part of the blob contract.

### Entity Component Keys

Known entity component keys from Core:

- `telemetry`
- `geometry`
- `task_catalog`
- `media_refs`
- `mil_view`
- `health`
- `sensor_refs`
- `communications`
- `task_queue`
- `status`
- `heartbeat`

Component keys prefixed with `custom_` are allowed as extension components. For the first slice, custom component payloads may be any JSON value.

### Telemetry Component

First-slice telemetry fields:

- `latitude`: optional finite number in `[-90, 90]`
- `longitude`: optional finite number in `[-180, 180]`
- `altitude_m`: optional finite number
- `speed_m_s`: optional finite number, `>= 0`
- `heading_deg`: optional finite number in `[0, 360)`
- `last_update`: optional RFC3339 timestamp

Do not add the legacy `speed_ms` alias to Atlas Protocol. If Core tests currently depend on that alias, update Core during the wiring step instead of preserving the alias in the new protocol.

### Geometry Component

The first slice should include both geometry formats currently accepted by Core:

- GeoJSON-like `Point`, `LineString`, and `Polygon` using `[longitude, latitude]` positions.
- Atlas-specific point/radius, line, and polygon forms using explicit `point_lat`, `point_lng`, `radius_m`, `line`, and `polygon` fields.

Shared geometry constraints:

- Latitude range: `[-90, 90]`
- Longitude range: `[-180, 180]`
- Numeric coordinates must be finite.
- Line and polygon position counts must stay at or below 10,000.
- Atlas `radius_m` must be positive.
- GeoJSON polygon rings must be closed.

### Canonical Names

Atlas Protocol should define canonical field names only. Do not encode Core's legacy compatibility aliases into the protocol source unless a later design decision explicitly keeps one as canonical.

Known aliases to remove or keep out while wiring Core:

- `telemetry.speed_ms`
- `sensor_refs[].fov_horizontal`
- `sensor_refs[].fov_vertical`
- `sensor_refs[].orientation_yaw`
- `sensor_refs[].orientation_pitch`
- `sensor_refs[].orientation_roll`
- string-only task `components.command`

## Atlas Core Consumption

The first Core integration should replace behavior in a narrow order:

1. Generate protocol constants for entity component keys.
2. Generate telemetry and geometry validators.
3. Add Core adapter tests that compare generated validation behavior to the intended first-slice contract.
4. Replace `ValidateTelemetryComponent` and `ValidateGeometryComponent` with adapters that call the generated validators.
5. Keep handwritten validators only for behavior that is still outside Atlas Protocol's implemented blob/component slices.

Do not replace every Core model or validator in the first implementation pass.

## Generated Artifacts

Generated outputs:

- `atlas_protocol/generated/jsonschema/entity.schema.json`
- `atlas_protocol/generated/jsonschema/task.schema.json`
- `atlas_protocol/generated/jsonschema/object.schema.json`
- `atlas_protocol/generated/jsonschema/components/telemetry.schema.json`
- `atlas_protocol/generated/jsonschema/components/geometry.schema.json`
- `atlas_protocol/generated/jsonschema/components/*.schema.json`
- `atlas_protocol/generated/go/atlasprotocol/`

TypeScript output remains part of the target system, but it should be generated after the CUE-to-JSON-Schema and Go-validator path is stable.

Generated files must be checked in and marked as generated. The check command must fail when generated files are stale.

## Acceptance Criteria

The first build slice is complete when:

- `go run ./tools/check` succeeds from `atlas_protocol/`.
- `go run ./tools/generate` followed by `go run ./tools/check` leaves no diff.
- Every checked-in entity, task, and object example validates against CUE.
- Generated JSON Schema exists for implemented blob and component slices.
- Generated Go validators are consumed by Atlas Core for implemented blob and component slices.
- `go test ./...` succeeds from `Atlas_Core/`.
- `git diff --check` reports no whitespace errors.

## Deferred Work

- Task helper endpoint payloads.
- Object media upload/download behavior.
- TypeScript types and validators.
- OpenAPI schema fragments.
- Postgres JSON validation artifacts.
- Command catalog schema ownership.
- HTTP request/response envelope contracts.
