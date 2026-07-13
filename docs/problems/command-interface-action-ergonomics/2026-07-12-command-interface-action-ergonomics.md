# Command Actions Are Difficult to Discover and Scan

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Position-command discovery, command-list hierarchy, and touch targets impede operation
3. **Issue:** Several related interaction choices make common command work harder to discover and execute than necessary.
4. **Severity:** S3 (Moderate)
5. **Location:** `atlas_command_interface/src/features/commands/`, `atlas_command_interface/src/features/MapConsole.tsx`, `atlas_command_interface/src/ui/layout/`, `atlas_command_interface/src/ui/map/`
6. **Expected:** Available commands should be visually dominant and directly discoverable, position commands should have a visible non-mouse-only entry point, and primary controls should provide comfortable pointer/touch targets.
7. **Actual:** The position-command entry point is prose deep in the selected asset inspector instructing the operator to right-click the map. Unsupported commands dominate the Commands panel with very low contrast, labels visually run into status text, and task history/raw data are pushed down. Primary rail controls measured about 38x38 pixels, account/collapse controls about 30x30, and map zoom controls about 29x29.
8. **Reproduction:**
   1. Sign in and select an asset that supports a position command
   2. Look for a visible map action or command button before reading the inspector prose
   3. Open Commands and compare supported actions with the volume and contrast of unsupported entries
   4. Inspect row spacing between names, connection state, and unsupported explanations
   5. Measure the rail, account, collapse, and map-control hit areas
9. **Notes:** Once discovered, right-clicking the map opened a coherent command menu and form, and `Send` remained disabled until the required altitude was supplied. Primary controls generally had accessible names; the problem is discoverability, hierarchy, and physical interaction size.
