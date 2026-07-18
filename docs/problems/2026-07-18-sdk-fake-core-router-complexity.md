# Atlas SDK FakeCore request router is becoming a second Core implementation

1. **Time & Date:** 2026-07-18T08:27:38-04:00
2. **Name:** Atlas SDK FakeCore request router is becoming a second Core implementation
3. **Issue:** The SDK test double implements most Core HTTP routes through one large branching `fetch` function, making the fake difficult to navigate and increasing the chance that its behavior diverges from the real server.
4. **Severity:** S4 (Minor)
5. **Location:** `atlas_sdk/test/support/fake-core.ts`
6. **Expected:** The fake remains a small deterministic test boundary with route-specific behavior that can be compared easily with protocol conformance and live integration tests.
7. **Actual:** `FakeCore.fetch` contains query pagination, entity/task/object CRUD, task lifecycle, check-in, download, validation, and error routing in one dispatcher. Biome reports cognitive complexity 86 for the function.
8. **Reproduction:**
   1. From `atlas_sdk/`, run `../node_modules/.bin/biome lint --config-path biome.json --only=complexity/noExcessiveCognitiveComplexity --max-diagnostics=200 .`
   2. Observe the complexity diagnostic at `test/support/fake-core.ts:49`
   3. Inspect the single route chain from protocol revision through the entity, task, and object endpoints
9. **Notes:** Live Core integration coverage reduces the current correctness risk. Split the dispatcher into route-specific handlers without creating a general-purpose router or replacing the existing conformance checks.
