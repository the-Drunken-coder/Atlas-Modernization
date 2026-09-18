# Problem: SDK README omits idempotent delete behavior for missing resources

1. **Time & Date:** 2026-09-17T11:38:07-04:00 America/New_York
2. **Name:** Document the SDK delete 404 exception
3. **Issue:** `AtlasClient` deliberately treats an exact resource-specific `404` (`ENTITY_NOT_FOUND` or `OBJECT_NOT_FOUND`) from a delete as an idempotent success, but the SDK README says without qualification that HTTP failures reject with `AtlasAPIError`. A consumer following that statement cannot know that a missing-resource delete resolves instead of rejecting.
4. **Severity:** S4 (Minor)
5. **Location:** `packages/sdk/src/sync-engine.ts:540-567,916-922`; `packages/sdk/README.md:30`; coverage in `packages/sdk/test/sync-engine-cache.test.ts:185-198,227-241`
6. **Expected:** The SDK documentation should state that delete treats the matching resource-specific `404` as an idempotent no-op, while other HTTP failures, including unrelated `404` responses, still reject with `AtlasAPIError`.
7. **Actual:** `deleteResource` catches the transport's `AtlasAPIError`, identifies only the resource-specific status/code pair with `isResourceNotFound`, evicts or reconciles local state, and returns at `sync-engine.ts:556-560`. The README's only error contract says `HTTP failures reject with AtlasAPIError` and does not describe this delete exception.
8. **Reproduction:**
   1. Create an `AtlasClient` against the SDK's `FakeCore` and load an entity into its cache.
   2. Remove the entity through `FakeCore` so a subsequent `DELETE /entities/{id}` returns `404` with `error_code: ENTITY_NOT_FOUND` (`packages/sdk/test/support/fake-core.ts:515-547`).
   3. Call `await client.entities.delete(id)`. The promise resolves `undefined` and the cached entity is evicted, as asserted by `sync-engine-cache.test.ts:185-198`; the same behavior is asserted after an already-observed delete at `:227-241`.
   4. Compare that result with `packages/sdk/README.md:30`, which currently presents all HTTP failures as rejecting with `AtlasAPIError`.
9. **Notes:** This is a confirmed documentation/contract issue, not a reason to remove the runtime behavior. Commit `43b5928c` added the exact-404 exception to preserve local-cache correctness during delete retries and added the corresponding tests. The narrow predicate means unrelated route `404`s and all other HTTP failures still reject; instance-token `412`s also remain errors. The focused SDK Vitest command could not run because the checkout has no installed workspace dependencies and the available Node binary fails to load its Homebrew `libllhttp` dependency; static source/test inspection and `git diff --check` were used instead. No SDK code or tests were changed.
