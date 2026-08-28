1. **Time & Date:** 2026-08-12T22:55:06-04:00
2. **Name:** Login and simulations headers contain redundant muted labels
3. **Issue:** The command-interface login panels render a muted uppercase `Atlas` eyebrow, and the simulations top bar renders a muted `Atlas Core` subtitle above controls. Both conflict with the information-dense, minimal-copy guidance.
4. **Severity:** S4 (Minor)
5. **Location:** `surfaces/command-interface/src/auth/ui/AuthGate.tsx`, `surfaces/command-interface/src/ui/styles/layout.css`, `simulations/src/client/SimulationTargetControls.tsx`, and `simulations/src/client/styles.css`
6. **Expected:** Headers communicate context through their primary heading and controls without redundant light-gray subtitle lines or decorative eyebrow copy.
7. **Actual:** Both surfaces add muted secondary labels that repeat context already supplied by the application and primary heading.
8. **Reproduction:**
   1. Open the command interface while logged out or while Core is unavailable
   2. Observe the uppercase muted `Atlas` label above the main heading
   3. Open Atlas Simulations and observe the muted `Atlas Core` label below `Atlas Simulations`
9. **Notes:** Before editing production UI, create three distinct static header mocks for both surfaces, present them through the visualization workflow, and stop until the developer selects one. Keep the eventual change limited to approved copy and layout; do not redesign functional status controls.
