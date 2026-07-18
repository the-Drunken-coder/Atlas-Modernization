# Atlas Simulations App owns too many lifecycle concerns

1. **Time & Date:** 2026-07-18T08:27:38-04:00
2. **Name:** Atlas Simulations App owns too many lifecycle concerns
3. **Issue:** The simulations client `App` component owns target and scenario loading, API-key state, run selection, polling, event-stream lifecycle, run reconciliation, start/stop/cleanup mutations, error handling, and rendering in one component.
4. **Severity:** S4 (Minor)
5. **Location:** `atlas_simulations/src/client/App.tsx`
6. **Expected:** Run lifecycle and event-stream coordination have one focused controller seam, while `App` primarily composes view state and panels.
7. **Actual:** `App` contains 16 state hooks, 9 refs, and several intertwined lifecycle operations. The configured Biome complexity check reports six functions above the allowed complexity of 15, ranging from 21 to 31.
8. **Reproduction:**
   1. From the repository root, run `npm run lint --workspace @the-drunken-coder/atlas-simulations`
   2. Observe complexity warnings for `App`, `refreshRuns`, `startSelectedRun`, `activateRun`, the event-stream message handler, and `cleanupCurrentRun`
9. **Notes:** The current tests pass, so this is a maintainability risk rather than a demonstrated correctness failure. Prefer extracting one cohesive run/event-stream controller hook over introducing a generalized state framework.
   - Addendum (2026-07-18T08:29:35-04:00, second reviewer): `App` also uses an every-render ref self-assignment (`effectsRef.current = { captureError, refreshHealth, ... }` at `App.tsx:53-54`) to let effects call the latest closures without listing them as dependencies. It works, but it sidesteps React's dependency model and is a symptom of the same missing controller seam — extracting the run/event-stream controller hook should remove the need for it rather than carrying the pattern into the new hook.
