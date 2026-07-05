# Atlas Protocol

This is the buildable Atlas Protocol module. It owns reusable data-shape contracts and generated validation artifacts for Atlas data. Planning and reference docs live in `../docs/atlas-protocol/`.

The canonical schema source is `schema/jsonschema/atlas.schema.json`.

The implemented protocol slice covers entity, task, and object JSON blobs; entity and task component keys; generated validators for documented entity components; task components; object references; `telemetry`; and `geometry`.

## Workflow

Regenerate checked-in artifacts:

```sh
go run ./tools/generate
```

Check examples and generated artifact freshness without rewriting files:

```sh
go run ./tools/check
```

Run protocol tests:

```sh
go test ./...
```

## Boundary

Generated Go lives under `generated/go/atlasprotocol` and is intended for multiple consumers. Atlas Core consumes this module through a local `replace` during development, but generated protocol artifacts should not move under `Atlas_Core/internal/`.

Generated files are checked in and marked `DO NOT EDIT`; update `schema/jsonschema/atlas.schema.json` and rerun `go run ./tools/generate` instead.
