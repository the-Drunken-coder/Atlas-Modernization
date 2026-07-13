# Command Interface Does Not Use the Available Viewport

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Map height is truncated on desktop and effectively disappears on narrow screens
3. **Issue:** The command interface layout does not size the map workspace to the usable viewport and does not adapt its navigation/sidebar composition for narrow screens.
4. **Severity:** S2 (Major)
5. **Location:** `atlas_command_interface/src/ui/layout/`, `atlas_command_interface/src/ui/map/`, `atlas_command_interface/src/features/MapConsole.tsx`
6. **Expected:** The map should fill the remaining desktop viewport and remain operational at supported narrow widths through an adaptive or overlay layout.
7. **Actual:** At a 1440x1000 viewport, the map measured 1104x552 at `x=336,y=0`, leaving the lower 448 pixels as unused black space while the sidebar continued to full height. At 390x844, the navigation rail and sidebar consumed 335 pixels, leaving roughly 55 pixels of visible map; markers and map controls were clipped offscreen with no horizontal recovery path.
8. **Reproduction:**
   1. Start local Core and the command interface
   2. Sign in and open `/map`
   3. Set the browser viewport to 1440x1000 and inspect `.maplibre-host`
   4. Observe a 552-pixel map height and unused space beneath it
   5. Resize to 390x844
   6. Open Assets or an asset inspector
   7. Observe that the rail and panel leave only a narrow clipped map sliver
9. **Notes:** Reproduced across the default workspace, Assets, asset inspector, and Commands views. The narrow layout also makes a right-click-driven map workflow unavailable to touch-oriented operators.
