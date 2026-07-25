# Atlas Protocol Implementation Prep

Status: implemented and superseded by the current JSON Schema source layout.

Atlas Protocol now keeps its canonical contract in `../../atlas_protocol/schema/jsonschema/atlas.schema.json`. The buildable module remains `../../atlas_protocol/`, and Atlas Core consumes its reusable Go package through the local module replacement during development.

## Current Workflow

```sh
cd atlas_protocol
go run ./tools/generate
go run ./tools/check
go test ./...
```

`generate` refreshes generated Go validators, TypeScript artifacts, and the protocol revision stamp from the JSON Schema source. `check` validates checked-in examples, structurally compares the authored Go API with the schema, and fails when generated artifacts drift.

## Current Contract Surface

The implemented protocol owns:

- entity, task, and object JSON blob shapes
- entity and task component keys and documented component payloads
- request DTOs, resource envelopes, metadata, object references, error envelopes, feed events, feed client messages, and feed handshake messages
- authored, schema-parity-checked Go types; generated Go validators; generated TypeScript types/request validators; and revision metadata

Atlas Core still owns service behavior: HTTP routes, auth, status codes, database tables, transactions, pagination, task lifecycle semantics, object upload/download behavior, and startup/storage wiring.

## Notes For Future Changes

- Edit `atlas_protocol/schema/jsonschema/atlas.schema.json`, not generated artifacts. Update the authored Go `types.go` only when a supported public contract changes.
- Keep the reusable Go package under `atlas_protocol/generated/go/atlasprotocol`; do not move protocol source or protocol packages under `atlas_core/internal/`.
- Preserve narrow semantic checks in `atlas_protocol/validator` when JSON Schema cannot express them cleanly, such as GeoJSON polygon ring closure and aggregate polygon position limits.
- OpenAPI fragments, Postgres JSON checks, and command-catalog schema ownership remain deferred.
