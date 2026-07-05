# Atlas Protocol

Atlas Protocol is the reusable contract layer for Atlas data. The buildable module lives in [`atlas_protocol/`](../../atlas_protocol/); this directory keeps the project-level design notes.

## Current Shape

- JSON Schema in `atlas_protocol/schema/jsonschema/atlas.schema.json` is the source of truth.
- Checked-in examples validate against the JSON Schema source.
- Generated Go types/validators, TypeScript types, and a protocol revision stamp live under `atlas_protocol/generated/`.
- Atlas Core consumes generated protocol artifacts; it does not own or duplicate the protocol source.
- The Atlas SDK imports generated TypeScript directly so SDK, Core, and protocol artifacts move in lockstep.

The implemented contract covers entity, task, and object resources; request DTOs; resource metadata; object references; documented entity and task components; error envelopes; feed events; feed client messages; feed handshake messages; generated validators; and revision metadata.

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
2. Regenerate artifacts.
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

Generated files are checked in and marked `DO NOT EDIT`. Update JSON Schema and rerun the generator rather than editing generated artifacts by hand.

## Deferred

- TypeScript runtime validators beyond the targeted request checks the SDK already needs.
- OpenAPI fragments.
- Postgres JSON checks.
- Command catalog schema ownership.
