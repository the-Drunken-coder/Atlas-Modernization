# Problem Report

1. **Time & Date:** 2026-09-17T15:09:57Z
2. **Name:** Core CLI recovery hints misclassify an active mutation lock
3. **Issue:** The terminal UI classifies lifecycle and Plugin failures by searching the rendered error string for the word `pending`. The active mutation-lock error itself contains the conditional sentence `If recovery is pending`, so an ordinary lock held by a live operation is presented as pending recovery.
4. **Severity:** S4 (Minor)
5. **Location:** `surfaces/core-cli/src/terminal-ui.tsx:2039-2047,2349-2370`; error construction in `surfaces/core-cli/src/application.ts:3728-3788,4044-4105`
6. **Expected:** A lifecycle or Plugin operation blocked by an active mutation lock should tell the operator to wait for the lock owner and retry. Only an error describing an actual pending recovery should recommend `atlas-core recover`.
7. **Actual:** `#acquireMutationLock` throws an active-lock error containing `If recovery is pending` (`application.ts:3785-3788`). `lifecycleRecoveryHint` tests `/...|pending/i` first (`terminal-ui.tsx:2349-2353`), so it returns `Finish the pending recovery or Plugin disable...` and never reaches the specific mutation-lock branch at lines 2354-2355. The same precedence affects `pluginRecoveryHint` (`terminal-ui.tsx:2039-2047`).
8. **Reproduction:**
   1. Start one lifecycle or Plugin mutation and keep its mutation owner alive. The existing application test creates this state with a fenced process group and verifies the operation is rejected as a deployment lock at `surfaces/core-cli/test/application.test.ts:5687-5706`.
   2. Invoke a second lifecycle operation through `runLifecycle` (or a Plugin operation through `pluginEnable`/`pluginDisable`) while that lock is held. The lifecycle path carries `LifecycleOperationResult.error` into the UI view at `terminal-ui.tsx:376-419`; the Plugin path carries the rejected error into `PluginActivityView.error` at `terminal-ui.tsx:498-539`.
   3. The error text is `Atlas Core deployment mutation is locked ... Wait for its owner to finish. If recovery is pending, inspect atlas-core recover status; do not remove deployment locks independently.` The broad `pending` match selects the wrong recovery hint instead of the intended active-lock hint.
9. **Notes:** This is a concrete UI guidance defect, not merely future regex fragility. The same active-lock message is deliberately emitted for both the filesystem lock (`application.ts:3785-3788`) and Docker lock network (`application.ts:4102-4105`). A focused regression test should feed that exact message through each classifier and assert the active-mutation hint; a semantic error code or structured failure reason would avoid substring precedence.
