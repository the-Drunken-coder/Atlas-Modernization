# Command Catalog authoring

Atlas Protocol owns every Command. The production catalog is generated from JSON namespace files in this directory; with no namespace files, generation publishes `[]`.

Adding a Command is one cross-module change:

1. Define the stable operator intent, observable completion guarantee, cancellation behavior, and scheduling requirement.
2. Add or reuse its named input schema in `schema/jsonschema/atlas.schema.json`. Add an output schema only for a bounded Task result.
3. Add the Command definition to `<namespace>.json`. Every entry must use that filename as its `command` prefix.
4. Add `docs/atlas-protocol/commands/<namespace>/<command>.md` with preconditions, outcomes, durable resources, and examples.
5. Add the purpose-built command-interface input and the Asset execution implementation together. Do not add a generic schema-driven form or an Asset-defined Command.
6. Add focused conformance cases, including any special Core scheduling or safety policy.
7. Run `go run ./tools/generate`, `go run ./tools/check`, and `go test ./...` from `packages/protocol/`, then run the affected consumer checks.

Generated `../generated/command_catalog.json` is never edited directly. Test Commands belong in `../conformance/tasking/fixtures/`, not here, so they can exercise tasking without entering the production catalog.
