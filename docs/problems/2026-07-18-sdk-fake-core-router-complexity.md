# Atlas SDK FakeCore dispatcher obscures route-specific test behavior

1. **Time & Date:** 2026-07-18T08:27:38-04:00
2. **Name:** Atlas SDK FakeCore dispatcher obscures route-specific test behavior
3. **Issue:** The SDK test double routes queries plus entity, task, and object operations through one large branching `fetch` function, making route behavior difficult to locate and review.
4. **Severity:** S4 (Minor)
5. **Location:** `atlas_sdk/test/support/fake-core.ts:49-258`
6. **Expected:** `FakeCore.fetch` performs request bookkeeping and delegates each route family to a focused handler whose behavior can be reviewed independently.
7. **Actual:** The 210-line dispatcher contains query pagination, entity/task/object routing, request validation, precondition handling, and error responses. Biome 2.5.5 reports cognitive complexity 86 for `FakeCore.fetch`.
8. **Reproduction:**
   1. From `atlas_sdk/`, run `../node_modules/.bin/biome lint --config-path biome.json --only=complexity/noExcessiveCognitiveComplexity --max-diagnostics=200 .`
   2. Observe the complexity-86 diagnostic at `test/support/fake-core.ts:49`.
   3. Inspect `test/support/fake-core.ts:58-258` and trace the single route chain from protocol revision through query, entity, task, and object endpoints.
9. **Notes:** Verified against `main` at `2d6106e` with Biome 2.5.5 on 2026-07-25. Extract only the existing route families into private methods; do not introduce a general-purpose router or change the fake's behavior.
