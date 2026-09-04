1. **Time & Date:** 2026-09-04T23:55:26+00:00
2. **Name:** Core CLI log commands duplicate Compose execution
3. **Issue:** The Core CLI `logs` and `pluginLogs` methods duplicate the Docker runtime scope, engine-state assertion, log argument construction, inherited Compose execution, and nonzero-result handling. This is observable maintenance duplication: a future change to shared log behavior must be kept in sync in both methods.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/core-cli/src/application.ts:1306-1367`
6. **Expected:** A private log-execution helper owns the shared Compose log behavior while `pluginLogs` retains its enabled-state and deployed metadata validation before selecting the Plugin service.
7. **Actual:** `logs` implements the shared block at lines 1308-1316, while `pluginLogs` repeats it at lines 1358-1366. The only command-specific differences are the optional Core service argument versus the validated Plugin service argument.
8. **Reproduction:**
   1. Inspect `surfaces/core-cli/src/application.ts` lines 1306-1367.
   2. Compare `logs` lines 1308-1316 with `pluginLogs` lines 1358-1366. Both call `#preflight`, enter `#dockerRuntimeScope.run`, assert the state engine, build `logs --tail 200` plus `--follow`, call `#runCompose(..., true, state.enabledPlugins)`, and throw `commandFailure("docker compose logs", result)` on a nonzero result.
   3. Run the focused application tests `maps core logs to the api service`, `targets Source Gateway logs directly`, and `uses staged metadata for Plugin status and logs across CLI-only catalog drift`; the configured test runner is unavailable in this checkout because `vitest` is not installed.
9. **Notes:** Source finding F03, Slopo cluster `18/951fc444310b`, reviewed at `cf90a53ad03b4796ea47c649b525f0cb282c1a14`. Existing tests assert Core service mapping, inherited output, and Plugin service selection at `surfaces/core-cli/test/application.test.ts:2773-2788` and `4033-4056`. The source trace confirms a concrete consolidation opportunity but no current runtime failure; no Docker, deployment, log stream, or service was invoked during this investigation.
