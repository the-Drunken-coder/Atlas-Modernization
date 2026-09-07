# Heartbeat ticks republish unchanged geofeature map data

1. **Time & Date:** 2026-09-07T08:15:44Z
2. **Name:** Heartbeat ticks republish unchanged geofeature map data
3. **Issue:** The one-second heartbeat clock rebuilds every map feature collection and triggers geofeature `setData` calls even when geometry and selection have not changed.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/command-interface/src/features/useHeartbeatClock.ts:7`, `surfaces/command-interface/src/features/MapConsole.tsx:321-324`, `surfaces/command-interface/src/ui/map/rendering/map-sources.ts:59-104`, `surfaces/command-interface/src/ui/map/view/MapView.tsx:399-405`, and `surfaces/command-interface/src/ui/map/rendering/map-layers.ts:27-29`.
6. **Expected:** Heartbeat freshness continues to update asset presentation while unchanged geofeature geometry retains its projection identity and avoids redundant map publication. Geometry and selection changes must still update the map.
7. **Actual:** `now` invalidates the complete `buildMapSources` result every second. Circle display polygons are reconstructed too. `MapView` watches the changed `sources` object, and `pushSources` unconditionally calls `setData` on the geofeature source. With one static circle and no assets, three heartbeat ticks produced three new geofeature objects with equal content and three `setData` calls.
8. **Reproduction:**
   1. Run `sed -n '321,324p' surfaces/command-interface/src/features/MapConsole.tsx` and trace `buildMapSources` into `displayGeometry` in `surfaces/command-interface/src/atlas/geometry.ts`.
   2. Render the real `MapConsole` under `AtlasStaticProvider` with a ready, fixed value containing one circle geofeature, an empty task map and catalog, and an available basemap. Use a disposable map adapter that calls the real `pushSources` from a React effect depending on `sources`, with a recording `setData` sink.
   3. After lazy imports settle, record the last geofeature payload. Advance fake timers by 1,000 ms in three separate React `act` calls. Each tick delivers a different object whose content equals the original payload.
   4. Inspect the real `MapView` source synchronization effect to verify that it has the same `sources` dependency and calls `pushSources`.
9. **Notes:** Source finding F06, from the rendering row and update-work discussion. Verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. The disposable probe passed with a recording map sink; it did not run WebGL or measure GPU usage. The confirmed issue is redundant projection and publication. This is separate from F03a: it occurs with a static provider and no health polling.
