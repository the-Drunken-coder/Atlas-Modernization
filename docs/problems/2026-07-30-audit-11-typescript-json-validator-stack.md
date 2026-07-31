# Generated TypeScript JSON validation can overflow the call stack

1. **Time & Date:** 2026-07-30T08:33:00Z
2. **Name:** Generated TypeScript JSON validation can overflow the call stack
3. **Issue:** `atlasProtocolIsJSONValueInternal` recursively descends arrays and objects, so a deeply nested but protocol-valid, sub-request-limit document throws `RangeError`.
4. **Severity:** **S3 (Moderate)** — public validators and SDK reads can fail outside the normal validation error path.
5. **Location:** `atlas_protocol/tools/internal/artifacts/typescript_runtime_helpers.go:107-141`, `atlas_protocol/generated/typescript/index.ts:625-655`, `atlas_sdk/src/validation.ts:57-61`, `atlas_sdk/src/sync-engine.ts:298-306`
6. **Expected:** Validation returns a boolean or the SDK's normal validation error for every payload within supported body limits, without exhausting the JavaScript call stack.
7. **Actual:** On required Node 24, depth 2,000 validates while depth 3,000 throws `RangeError: Maximum call stack size exceeded`; an SDK object-detail response reaches the same failure. This was confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Build nested JSON iteratively and call the public object-create validator; depth 3,000 throws on Node 24.
   2. Return a sub-request-limit nested object-detail response through `AtlasClient.objects.get`; SDK validation throws the same error.
   3. Replace recursive traversal with a small iterative worklist preserving finite-number, plain-record, and cycle checks; test depth 3,000, cycles, and non-JSON values.
