# Problem: Plugin list hides update availability

1. **Time & Date:** 2026-09-17T15:13:04Z
2. **Name:** Plugin list does not report update availability
3. **Issue:** The shipped Plugin-management TUI has an `updatePlan` display path, but the real status-loading path no longer populates it. An Installed Plugin therefore shows only a generic `u update` action; the operator cannot see whether the signed catalog has a compatible replacement, whether the Plugin is current, or why an update is blocked without starting update planning.
4. **Severity:** S3 (Moderate)
5. **Location:** `surfaces/core-cli/src/application.ts:3159-3192`, `surfaces/core-cli/src/terminal-ui.tsx:641-667`, `surfaces/core-cli/src/terminal-ui.tsx:2408-2411`, `surfaces/core-cli/src/terminal-ui.tsx:2503-2508`
6. **Expected:** Opening Plugin management should report the selected version and signed-catalog update availability for each Installed Plugin, including current, compatible replacement, incompatible, revoked, or catalog-blocked states, without mutating deployment state.
7. **Actual:** `pluginStatuses()` returns `selectedVersion`, `availableVersions`, and compatibility, but never sets `updatePlan`. The TUI renders the `Catalog ...` availability line only when `plugin.updatePlan` is present. It fetches the plan only after the operator presses `u`, then enters a busy screen and review flow.
8. **Reproduction:**
   1. Use an initialized schema-4 deployment with an Installed Plugin at `1.0.0` and a signed catalog containing a compatible `1.1.0` release.
   2. Open `Manage Plugins` in the terminal UI.
   3. Observe `Selected  1.0.0` and the generic `u update` footer, but no `Catalog   1.1.0 compatible update` (or equivalent current/blocked explanation).
   4. Press `u`; only then does `reviewPluginUpdate()` call `pluginUpdatePlan()` and display the availability result.
9. **Notes:**
   - GitHub issue [#429](https://github.com/the-Drunken-coder/Atlas-Modernization/issues/429) explicitly requires the UI to show whether the signed catalog offers a compatible replacement and to report a Plugin as current when none exists. Its implementation decision says to resolve an update plan before confirmation; PR #431 claims it “adds signed-catalog availability to the Plugins menu.”
   - The previous implementation populated plans while loading the menu (`798c2e06^:surfaces/core-cli/src/terminal-ui.tsx:257-273`). Commit `7c462913` removed that population to avoid waiting for every plan, but retained `updatePlan`, `pluginCatalogAvailability`, and the corresponding rendering branch. The current test now asserts that plan loading does not occur on menu open (`surfaces/core-cli/test/terminal-ui.test.ts:1667-1687`, `2178-2222`), confirming the regression rather than the #429 contract.
   - A small fix can either restore an availability-only status plan before rendering or add a separate bounded status operation; blindly restoring full release-document downloads for every Plugin may make the menu slow. No deployment state changes occur while checking a plan.
