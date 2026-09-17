# Problem

1. **Time & Date:** 2026-09-17T15:12:00Z
2. **Name:** Plugin update-plan equality is duplicated in production and preview operators
3. **Issue:** The real Core CLI operator and the in-memory TUI preview each carry a private, byte-for-byte copy of `samePluginUpdatePlan`. Both compare the reviewed update plan with a freshly resolved plan before applying an update. The copies match today, but a future change to the `PluginUpdatePlan` contract or equality policy can update one path and leave the other stale, making the preview no longer model the production review guard.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/core-cli/src/application.ts:6406-6423`; `surfaces/core-cli/src/tui-preview-operator.ts:604-621`; callers at `application.ts:1765-1769` and `tui-preview-operator.ts:516-520`
6. **Expected:** The production and preview operators should share one plan-comparison helper, or otherwise have a focused contract test that makes intentional differences explicit when the `PluginUpdatePlan` shape or comparison rules change.
7. **Actual:** The two private functions are currently identical, but there is no shared implementation. The production caller rejects a stale reviewed plan before a real Plugin update, while the preview caller independently applies the same comparison. The preview is reachable through `surfaces/core-cli/scripts/tui-preview.mjs:2-12` and `surfaces/core-cli/test/tui-preview.test.ts:170-182`; `tsconfig.build.json:10-11` compiles all `src` files into `dist` and `package.json:27-31` includes `dist` in the package.
8. **Reproduction:**
   1. Compare `application.ts:6406-6423` with `tui-preview-operator.ts:604-621`; the functions have no diff and compare the same ten plan fields plus ordered `restartServices`.
   2. Observe the production call at `application.ts:1765-1769` and the preview call at `tui-preview-operator.ts:516-520`.
   3. Change or add a reviewed-plan field in `PluginUpdatePlan`, then update only one private helper. The real operator and preview will enforce different review freshness rules while both compile against the shared type.
9. **Notes:** This is a current maintenance/drift risk, not a demonstrated runtime failure. Both copies were introduced by the same reviewed-update change (`git blame` identifies commit `798c2e066`), and the preview test currently verifies rejection of a stale display name (`tui-preview.test.ts:170-182`). The narrow Vitest command could not run in this checkout because the workspace has no installed `vitest` binary: `npm test --workspace atlas-core -- --run test/tui-preview.test.ts` failed with `vitest: command not found`. A focused `diff -u` of the two function ranges and `git diff --check` passed.
