# TypeScript can silently corrupt valid large size_bytes values

1. **Time & Date:** 2026-08-03T06:07:56Z (revalidated; originally recorded 2026-07-30)
2. **Name:** TypeScript can silently corrupt valid large `size_bytes` values
3. **Issue:** The schema permits int64-sized non-negative integers, but generated TypeScript represents `size_bytes` as `number`, so valid values above `Number.MAX_SAFE_INTEGER` silently round.
4. **Severity:** **S3 (Moderate)** — object metadata can be silently corrupted at a valid but extreme wire-contract value.
5. **Location:** `atlas_protocol/schema/jsonschema/atlas.schema.json`, `atlas_protocol/generated/typescript/index.ts`, `atlas_sdk/src/http.ts`
6. **Expected:** Every protocol-valid `size_bytes` value round-trips exactly through supported JavaScript clients.
7. **Actual:** `JSON.parse` rounds `9007199254740993` to `9007199254740992`; the generated validator still accepts the rounded value and SDK serialization transmits it. Core and generated Go use `int64`, so supported ranges differ. This was revalidated against `main` at `f4b0187fdb68088ea0b59d28218d02204f4cfc9c`.
8. **Reproduction:**
   1. Run `JSON.parse('{"object_id":"o","size_bytes":9007199254740993}')`; inspect the rounded result and its accepted generated validation.
   2. An SDK create sends the rounded number and an SDK read returns the rounded value from exact inbound JSON.
   3. Add a schema maximum of `9007199254740991`, regenerate artifacts, and test 0/max accepted plus max+1 rejected across object create, update, blob, resource, and detail shapes.
