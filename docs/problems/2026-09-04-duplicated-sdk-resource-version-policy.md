1. **Time & Date:** 2026-09-04T23:55:26+00:00
2. **Name:** SDK cache and sync engine duplicate embedded resource version policy
3. **Issue:** The SDK keeps two private `embeddedResourceVersion` implementations for the same resource-version mapping, so a future policy change requires synchronized edits in both modules.
4. **Severity:** S5 (Note)
5. **Location:** `packages/sdk/src/cache.ts:311-314` and `packages/sdk/src/sync-engine.ts:932-936`; callers are `ResourceCache.cacheResource()` at `packages/sdk/src/cache.ts:189` and `SyncEngine.writeResource()` at `packages/sdk/src/sync-engine.ts:516`.
6. **Expected:** One SDK-internal helper owns the policy that tasks or resources without metadata use version `0`, while entity/object metadata supplies `metadata.version`, and both callers use that helper.
7. **Actual:** `cache.ts` and `sync-engine.ts` each define the policy locally. The implementations currently return the same values, but they can drift if one copy changes without the other.
8. **Reproduction:**
   1. Run `rg -n -C 3 "function embeddedResourceVersion" packages/sdk/src/cache.ts packages/sdk/src/sync-engine.ts`.
   2. Compare the two functions: each returns `0` for tasks or missing metadata and otherwise returns `metadata.version`; the only difference is guard ordering.
   3. Trace the callers at `cache.ts:189` and `sync-engine.ts:516`. The cache helper supplies an implicit cache version when no explicit event version is passed, while the sync-engine helper supplies the version for a synthetic event created from an entity/object write.
   4. The protocol types confirm that entity and object resources contain metadata while task resources do not (`EntityResource`, `ObjectResource`, and `TaskResource` in `packages/protocol/generated/typescript/index.ts`). The SDK validators and client routing preserve that distinction.
9. **Notes:** Stable finding `F02`; source mapping is original Slopo cluster 27 (hash `06bae4d2aff1`), refreshed against main commit `cf90a53ad03b4796ea47c649b525f0cb282c1a14`. This is confirmed maintenance duplication, not a reproduced runtime defect; the current implementations are behaviorally equivalent. The narrow command `npm run test:node --workspace @the-drunken-coder/atlas-sdk -- test/sync-engine-cache.test.ts test/sync-engine-reconnect-cleanup.test.ts` could not run because `vitest` is not installed in the checkout; no dependencies were installed. No matching active problem report existed before this file.
