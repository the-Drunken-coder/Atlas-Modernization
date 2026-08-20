# Atlas Protocol

Atlas Protocol is the reusable contract layer for Atlas data. The buildable module lives in [`atlas_protocol/`](../../atlas_protocol/); this directory keeps the project-level design notes.

## Current Shape

- JSON Schema in `atlas_protocol/schema/jsonschema/atlas.schema.json` is the source of truth.
- Checked-in examples validate against the JSON Schema source.
- Authored, schema-parity-checked Go types plus generated Go validators, TypeScript types and runtime predicates, and a protocol revision stamp live under `atlas_protocol/generated/`.
- Atlas Core consumes Protocol request, response, resource, and validator types at shared wire boundaries while retaining route orchestration and service behavior.
- The Atlas SDK imports and re-exports generated TypeScript directly; generated-artifact checks and the protocol revision token detect drift or deployment mismatches.

The implemented contract covers Entity, immutable Task, and Object resources; the Protocol-owned Command Catalog and Command Manifest; Entity and Object create/update requests; Task creation and six explicit lifecycle requests; Asset runtime registration, readiness, explicit stop, and delivery; telemetry-only Entity check-in; query and revision responses; resource metadata; object references; error envelopes; feed events and subscriptions; generated Go validators; generated TypeScript types and predicates; and revision metadata. The measured restart-fencing decision is recorded in [`runtime-restart-benchmark.md`](runtime-restart-benchmark.md).

The shared request corpus in `atlas_protocol/conformance/request-validation.json` checks the canonical schema, Go validation, generated TypeScript predicates, and Core request boundaries against the same cases. `atlas_protocol/conformance/tasking/` adds portable lifecycle, scheduling, outcome, and restart scenarios using fixture Commands that never enter the production catalog.

## Boundary

Protocol owns data shape and validity:

- field names and types
- required fields, enum values, and ranges
- extension rules and known component keys
- example validation
- generated cross-language artifacts

Atlas Core owns service behavior:

- HTTP routes, auth, status codes, and middleware
- database tables, transactions, locks, and pagination
- task lifecycle semantics
- object upload/download behavior
- storage wiring and startup lifecycle

If protocol code starts importing a database driver, defining route behavior, or carrying deployment policy, the boundary has been crossed.

## Change Policy

This repo is still greenfield. Prefer full protocol replacement over compatibility shims:

1. Update the JSON Schema source.
2. Update the authored Go API when its supported contracts change, then regenerate artifacts.
3. Update consumers.
4. Rebuild and test.

The generated revision stamp is a drift/mismatch token, not compatibility versioning. Core reports it through `GET /protocol/revision` and the feed `hello` frame; the SDK compares it with its generated types and fails loudly on mismatch.

## Workflow

Use the module-level workflow in [`atlas_protocol/README.md`](../../atlas_protocol/README.md):

```sh
cd atlas_protocol
go run ./tools/generate
go run ./tools/check
go test ./...
```

Generated validators, TypeScript, and revision files are checked in and marked `DO NOT EDIT`. Update JSON Schema and rerun the generator rather than editing those artifacts by hand. The authored Go `types.go` is the exception: edit it intentionally when the structural parity check reports a supported contract change.

## Deferred

- OpenAPI fragments.
- Postgres JSON checks.
