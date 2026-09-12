# Issued Task cancellation is unavailable in the Command Interface

1. **Time & Date:** 2026-09-12T23:42:16Z
2. **Name:** Command Interface cannot cancel an issued Task
3. **Issue:** A Command whose manifest declares cancellation support can be issued through the existing UI, but its pending Task has no operator cancellation action.
4. **Severity:** S2 (Major)
5. **Location:** `surfaces/command-interface/src/features/assets/AssetInspector.tsx`, `surfaces/command-interface/src/features/shared/TaskRow.tsx`, `surfaces/command-interface/src/state/atlas-context.tsx`, `surfaces/command-interface/src/atlas/data-source.ts`
6. **Expected:** The operator can use a visible cancellation control in the issued pending Task's row, after which fresh authoritative Core state and the UI show the Task as cancelled.
7. **Actual:** `AssetInspector` renders active and queued Tasks through the read-only `TaskRow`; `TaskRow` contains only the command, relative time, message, and status. `AtlasContextValue` and `AtlasDataSource` expose Command submission but no Task cancellation operation. The test found zero visible cancellation buttons in the issued pending Task's row and timed out after 15 seconds. The Command form's `Cancel` action only dismisses an unsubmitted form.
8. **Reproduction:**
   1. Check out `edf563e5687859bd41baf70027485f1adab4b104` in `/tmp/atlas-test-381` with a clean working tree.
   2. Use Node 24 and run `npm run build:sdk && node tests/acceptance/browser/commands/commands.mjs --browser=chromium` from the repository root.
   3. Let the journey issue its final `fixture.queued` Command after the disconnect, recovery, session-expiry, and re-login cases complete.
   4. Observe that fresh Core state, the runtime interface, and the Task row all show the Task as pending, but the Task row exposes no visible cancellation button.
9. **Notes:** The clean run took 62.862 seconds. Its result, browser screenshot and HTML, trace, network log, Core responses, and stack logs are in `/tmp/atlas-test-381/.atlas/acceptance/browser-commands-chromium/browser-commands-chromium-resume-381-edf563e5-66bc29b7-b0af-4996-9f1d-1e0cb04aa833/`. That run also verifies actual `/feed` transport severance: it closes the established browser WebSocket, blocks a reconnect before it reaches Core, observes the visible connection error, restores the transport through the visible Retry control, and verifies authoritative recovery. The earlier `context.setOffline(true)` attempt at `5335feff6b654da3e001110ddef28659e836944a` did not produce a transport failure and is retained as corrected test-fault evidence in `/tmp/atlas-test-381/.atlas/acceptance/browser-commands-chromium/browser-commands-chromium-96a3c968-eee6-4f72-a203-3f8136c07fe8/`. Do not use the SDK cancellation API or a fixture-owned control as proof of operator cancellation through the application.
