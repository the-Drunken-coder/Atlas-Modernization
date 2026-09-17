# Problem

1. **Time & Date:** 2026-09-17T15:09:28Z
2. **Name:** Ctrl-C behavior is state-dependent but not documented consistently
3. **Issue:** The interactive Core CLI takes ownership of Ctrl-C, but its meaning changes with the current screen and the README does not explain that policy. Ctrl-C exits from the home menu and exits after cancelling active operations, while on several passive screens it acts as Back. Most of those screens advertise only Escape, so users cannot predict whether Ctrl-C will leave the application or only leave the current screen.
4. **Severity:** S4 (Minor)
5. **Location:** `surfaces/core-cli/src/terminal-ui.tsx` (`runInkApp`, `ActionListMenu`, `StatusScreen`, `PluginsMenu`/`SimpleMenu`, `PasswordScreen`, `UpdateReview`, and operation screens); `surfaces/core-cli/README.md` interactive controls section
6. **Expected:** The README and screen footers should state one discoverable Ctrl-C policy, including the distinction between exiting from the home screen, returning from passive screens, and requesting cancellation followed by safe cleanup for active operations.
7. **Actual:** `runInkApp` sets `exitOnCtrlC: false` (`terminal-ui.tsx:154-156`), so each screen handles Ctrl-C itself. The home menu calls `onExit` (`terminal-ui.tsx:1078-1083`) but its footer says only `Esc exit` (`1124-1125`). Status calls `onBack` (`1362-1367`), as do the Plugin menu (`2428-2434`), generic menus whose footer says only `Esc back` (`2611-2642`), the password screen (`2688-2693`, footer `2725`), and update review (`2835-2840`, footer `2876-2877`). In-progress lifecycle, Plugin, and update screens instead describe Ctrl-C as cancellation followed by exit and safe cleanup (`2082-2101`, `1905-1926`, `2177-2205`). The README documents Escape only: `surfaces/core-cli/README.md:17-24`.
8. **Reproduction:**
   1. Run `atlas-core` without arguments in an interactive terminal.
   2. Press Ctrl-C at the home action list. The app exits.
   3. Re-enter the TUI, open Status, Logs, Plugins, admin-password configuration, or an update review, and press Ctrl-C. The app returns to the previous screen instead.
   4. Start a lifecycle, Plugin, or update operation and press Ctrl-C. The operation requests cancellation, waits for its promise/cleanup path, and then exits. The focused tests encode these distinct outcomes (`surfaces/core-cli/test/terminal-ui.test.ts:542-609`, `2765-2800`, `3739-3776`).
9. **Notes:** This is a documentation and discoverability issue, not confirmation of unsafe cleanup. Mutation paths use `runCancelableOperation`, which installs a SIGINT handler that calls `operator.cancelPending()` and removes it only after the operation settles (`terminal-ui.tsx:3045-3066`); the operation screens show and test the safe-cleanup wait. The focused test command could not run in this checkout because the workspace has no installed `vitest` binary (`npm test --workspace atlas-core -- --run test/terminal-ui.test.ts` failed with `vitest: command not found`).
