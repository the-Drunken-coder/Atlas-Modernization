# Atlas Protocol

This is the buildable Atlas Protocol module. It owns reusable data-shape contracts, an ergonomic Go API, and generated validation artifacts for Atlas data. Planning and reference docs live in `../docs/atlas-protocol/`.

The canonical schema source is `schema/jsonschema/atlas.schema.json`.

The implemented protocol slice covers Entity, immutable Task, Object metadata, and Object detail resources; the Protocol Command Catalog and Command Manifest; Entity and Object create/update requests; Task creation and explicit lifecycle requests; Asset runtime registration and delivery; telemetry-only Entity check-in; query and revision responses; resource metadata; object references; error envelopes; feed events and subscriptions; generated Go validators; generated TypeScript types and runtime predicates; and revision metadata.

## Workflow

Regenerate checked-in artifacts:

```sh
go run ./tools/generate
```

When a schema change updates the protocol revision, also copy the generated
revision into `examples/feed/server/handshake.json`.

Check examples, authored Go/schema parity, and generated artifact freshness without rewriting files:

```sh
go run ./tools/check
```

Run protocol tests:

```sh
go test ./...
```

`conformance/request-validation.json` is the shared request corpus used by the
canonical schema, Go validation, generated TypeScript predicates, and all seven
Core create/update/check-in request boundaries. Cases separate `schema_valid` from full
runtime `valid` because polygon closure and aggregate position limits are
semantic checks that draft 2020-12 JSON Schema cannot express.

## Boundary

The reusable Go package lives under `generated/go/atlasprotocol` and is intended for multiple consumers. Its `types.go` file is authored for Go ergonomics, while `go run ./tools/check` derives the supported wire shapes and enums from the canonical schema and fails if that public API drifts. Atlas Core consumes this module through a local `replace` during development; protocol code should not move under `services/core/internal/`.

Generated validators, TypeScript, and revision files are checked in and marked `DO NOT EDIT`; update `schema/jsonschema/atlas.schema.json` and rerun `go run ./tools/generate`. Update authored `types.go` alongside schema changes when the parity check identifies a Go API change.
