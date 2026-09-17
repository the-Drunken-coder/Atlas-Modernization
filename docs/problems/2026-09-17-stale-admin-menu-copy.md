# Problem: Admin password screen retains the removed Configure breadcrumb

1. **Time & Date:** 2026-09-17T11:38:07-04:00 America/New_York
2. **Name:** Admin password navigation still names the removed Configure submenu
3. **Issue:** The action-list TUI replaced the former Configure submenu with a top-level `Change admin password` action, but the password screen and its test still describe the old submenu hierarchy. The test also selects the action by assuming its fixed numeric position.
4. **Severity:** S4 (Minor)
5. **Location:** `surfaces/core-cli/src/terminal-ui.tsx:853-856,1130-1150,2713-2725`; `surfaces/core-cli/test/terminal-ui.test.ts:3076-3095`
6. **Expected:** The password screen should use current action-list terminology, such as `ATLAS CORE > CHANGE ADMIN PASSWORD`, and the navigation test should select the named action through a stable interaction seam rather than relying on six Down-arrow presses.
7. **Actual:** The menu exposes `Change admin password` directly (`terminal-ui.tsx:1146-1149`) and routes it directly to the password screen (`:853-856`), but the screen renders `Configure > Admin account` (`:2716`). The test is titled “opens the admin account from the Configure submenu” and reaches the action with `"\u001b[B".repeat(6)` (`terminal-ui.test.ts:3076-3084`). The repository has no current `ConfigureMenu` implementation; the README already documents the direct `Change admin password` action (`surfaces/core-cli/README.md:151-154`).
8. **Reproduction:**
   1. Start the full-screen TUI with a ready deployment.
   2. Observe `Change admin password` as a top-level action in the action list, not under a Configure submenu.
   3. Select it and observe the password screen header `Configure > Admin account`, which describes a hierarchy that no longer exists.
   4. Inspect `surfaces/core-cli/test/terminal-ui.test.ts:3076-3084`; the test assumes the action remains the sixth Down-arrow target from the initial selection. Adding or reordering any preceding action silently sends the test to another action or causes it to time out.
9. **Notes:** This is stale UI copy and brittle maintenance coverage, not a broken password workflow. The direct `config` command intentionally opens the same prompt, and the password operation remains reachable from the current action list. The action-list replacement was introduced by commit `575a41ac` (`feat(core-cli): replace the default TUI`), which removed the old submenu while retaining this breadcrumb and test wording.
