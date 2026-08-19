# Adding a Command

Atlas Protocol owns every Command. The generated production catalog is currently empty, and a Command becomes real only when its complete cross-module behavior lands together.

1. Define stable operator intent, scheduling, cancellation, progress, preconditions, and the observable completion guarantee.
2. Add or reuse named input and optional bounded-output schemas in `atlas_protocol/schema/jsonschema/atlas.schema.json`.
3. Add the definition to `atlas_protocol/commands/<namespace>.json`. The namespace file must match the prefix of every Command it contains.
4. Add `docs/atlas-protocol/commands/<namespace>/<command>.md` with semantics, preconditions, outcomes, durable resource effects, and examples.
5. Add a purpose-built operator input to `atlas_command_interface/src/features/commands/command-input-registry.tsx`.
6. Add the Asset handler and manifest entry. Add special Core scheduling, supersession, or safety policy only when the Command requires it.
7. Extend the shared tasking conformance corpus and the focused consumers that exercise the new behavior.
8. Generate and validate Protocol artifacts, then run every affected module's checks.

The source-side generator rules live in [`atlas_protocol/commands/README.md`](../../../atlas_protocol/commands/README.md). Generated catalogs and codecs are never edited directly. Test-only fixture Commands remain under `atlas_protocol/conformance/tasking/fixtures/` and never enter the production catalog.

Do not add a generic schema-generated operator form, an Asset-defined Command, a compatibility alias, or dormant Core policy for a Command that does not yet exist.
