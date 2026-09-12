1. **Time & Date:** 2026-09-12T19:57:00Z
2. **Name:** Map source selector blocks the native zoom-in control
3. **Issue:** The built Command Interface renders the map-source selector over MapLibre's top-right navigation controls, so a normal pointer click cannot activate the visible zoom-in button.
4. **Severity:** S2 (Major)
5. **Location:** `surfaces/command-interface/src/ui/map/view/MapView.tsx:286`, `surfaces/command-interface/src/features/MapConsole.tsx:649-657`, `surfaces/command-interface/src/ui/map/MapSourcePicker.tsx:248-265`, `surfaces/command-interface/src/ui/styles/map.css:739-764`
6. **Expected:** An operator can activate the visible native MapLibre zoom-in button with a normal pointer click.
7. **Actual:** Playwright resolves a visible, enabled, stable `.maplibregl-ctrl-zoom-in`, but the `Map` label inside `.map-overlay-tr.map-source-control` intercepts every pointer attempt. `MapView` adds the native navigation control at `top-right`, while `MapConsole` renders `MapSourcePicker` as an overlay whose CSS also fixes it to the top-right at a higher stacking level.
8. **Reproduction:**
   1. Check out `3bf7b11737e8994a2875a8651d799ed6a8ff8a15` with a clean working tree.
   2. With Node 24 and Docker running, execute `ATLAS_ACCEPTANCE_RUN_LABEL=local-mapwin-chromium node tests/acceptance/browser/map-windows.mjs --browser=chromium`.
   3. Sign in through the automated journey, open the Map window fixture Plugin operation, and let the normal click target `.maplibregl-ctrl-zoom-in`.
   4. Observe the click time out because `<label class="map-source-control__label">Map</label>` intercepts pointer events.
9. **Notes:** The first clean-SHA failure took 57.109 seconds. Its screenshot, trace, HTML, result, requests, and logs are under `.atlas/acceptance/browser-map-windows-chromium/browser-map-windows-chromium-local-mapwin-chromium-ec300a5e-706c-43db-8a9b-e467e8a824d9/`. Keep the normal pointer assertion active until a separate product repair makes both top-right controls reachable. The test may use the same visible button's keyboard interaction to exercise independent later window behavior, but that does not satisfy the pointer assertion.
