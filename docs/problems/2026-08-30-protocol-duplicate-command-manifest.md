# Problem Report

1. **Time & Date:** 2026-08-30T15:01:21Z
2. **Name:** Protocol validators accept duplicate Command Manifest entries
3. **Issue:** The Protocol documentation requires each Command to appear at most once in a Command Manifest, but the canonical schema and generated Go and TypeScript validators accept entries with the same `command` identifier more than once.
4. **Severity:** S4 (Minor)
5. **Location:** `docs/atlas-protocol/commands-and-tasking.md`, `packages/protocol/schema/jsonschema/atlas.schema.json`, `packages/protocol/validator/validator.go`, and generated runtime validators in `packages/protocol/generated/typescript/index.ts`
6. **Expected:** Every Protocol validator for `CommandManifest` rejects a manifest containing duplicate `command` identifiers, matching the documented contract and Core runtime-registration behavior.
7. **Actual:** The manifest schema only validates each entry's shape and array-ness; it has no constraint for uniqueness by `command` (`atlas.schema.json:118-123`). The Go semantic validator adds duplicate detection only for `CommandCatalog` (`validator.go:462-475`), while `ValidateCommandManifest` delegates directly to the schema (`generated/go/atlasprotocol/validators.go:163-165`). The generated TypeScript `isCommandManifest` predicate likewise checks each entry independently and returns true for duplicate identifiers (`generated/typescript/index.ts:592-594`). Core's runtime registration path independently rejects duplicates in `services/core/internal/actions/task_runtime.go:286-296`, so the disagreement is currently masked at that boundary.
8. **Reproduction:**
   1. Construct two otherwise-valid manifest entries with the same `command` and different descriptions:
      ```json
      [
        {
          "command": "fixture.inspect",
          "description": "Inspect.",
          "scheduling": "queued",
          "supports_cancel": false,
          "supports_progress": false
        },
        {
          "command": "fixture.inspect",
          "description": "Inspect again.",
          "scheduling": "queued",
          "supports_cancel": false,
          "supports_progress": false
        }
      ]
      ```
   2. Run the checked-in generated TypeScript predicate directly (using the repository's installed `tsx` loader; no ignored build output is required):
      ```sh
      node --import tsx --input-type=module -e 'import { isCommandManifest } from "./packages/protocol/generated/typescript/index.ts"; const e={command:"fixture.inspect",description:"Inspect.",scheduling:"queued",supports_cancel:false,supports_progress:false}; console.log(JSON.stringify({duplicate:isCommandManifest([e,{...e,description:"Inspect again."}]),single:isCommandManifest([e])}))'
      ```
   3. Observe `{"duplicate":true,"single":true}`; both entries satisfy the schema and `isCommandManifest` has no aggregate duplicate check. The Go source trace reaches `semanticErrors`, whose switch handles `CommandCatalog` but not `CommandManifest`; the targeted validator and protocol test suites pass, but contain no equivalent duplicate-manifest assertion.
   4. Register the same manifest through Core runtime registration and observe rejection from `validateCommandManifestCatalog`, demonstrating that only Core's higher-level path enforces the documented rule.
9. **Notes:** This is a Protocol contract gap rather than an immediate Core registration bypass. A consumer that validates a manifest independently can accept an invalid manifest, and future generated consumers may select one of the conflicting entries inconsistently. The smallest fix is to add one shared Command-identifier uniqueness semantic rule to the canonical validation path and generate/use it in Go and TypeScript, with conformance cases for duplicate and distinct entries. Do not rely only on Core's registration guard.
