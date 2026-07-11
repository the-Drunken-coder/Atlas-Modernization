# Atlas Protocol

This is the buildable Atlas Protocol module. It owns reusable data-shape contracts, an ergonomic Go API, and generated validation artifacts for Atlas data. Planning and reference docs live in `../docs/atlas-protocol/`.

The canonical schema source is `schema/jsonschema/atlas.schema.json`.

The implemented protocol slice covers entity, task, and object resources; request DTOs; resource metadata; object references; documented entity and task components; error envelopes; feed events; feed client messages; feed handshake messages; generated Go validators; generated TypeScript types and targeted request validators; and revision metadata.

## Workflow

Regenerate checked-in artifacts:

```sh
go run ./tools/generate
```

Check examples, authored Go/schema parity, and generated artifact freshness without rewriting files:

```sh
go run ./tools/check
```

Run protocol tests:

```sh
go test ./...
```

`conformance/request-validation.json` is the shared request corpus used by the
canonical schema, Go validator, generated TypeScript predicates, and selected
Core handlers. Cases separate `schema_valid` from full runtime `valid` because
polygon closure and aggregate position limits are semantic checks that draft
2020-12 JSON Schema cannot express.

## Boundary

The reusable Go package lives under `generated/go/atlasprotocol` and is intended for multiple consumers. Its `types.go` file is authored for Go ergonomics, while `go run ./tools/check` derives the supported wire shapes and enums from the canonical schema and fails if that public API drifts. Atlas Core consumes this module through a local `replace` during development; protocol code should not move under `Atlas_Core/internal/`.

Generated validators, TypeScript, and revision files are checked in and marked `DO NOT EDIT`; update `schema/jsonschema/atlas.schema.json` and rerun `go run ./tools/generate`. Update authored `types.go` alongside schema changes when the parity check identifies a Go API change.
