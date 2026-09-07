# Comparison and spatial selection duplicate rectangle transforms

1. **Time & Date:** 2026-09-07T08:15:44Z
2. **Name:** Comparison and spatial selection duplicate rectangle transforms
3. **Issue:** Two rectangle editors independently compose the same keyboard and pointer transformation policy, despite already sharing projection and clamping helpers.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/command-interface/src/ui/map/view/MapRegionComparison.tsx:224-243` and `475-497`; `surfaces/command-interface/src/ui/map/view/MapAreaSelection.tsx:196-214` and `304-323`; shared helpers in `surfaces/command-interface/src/ui/map/view/map-region-geometry.ts`.
6. **Expected:** Shared rectangle transformation policy has one maintenance point for keyboard step selection, move-versus-resize calculation, projection back to geography, and rejection of date-line crossings. Each feature retains its own result publication, panel behavior, cancellation, and search constraints.
7. **Actual:** Both keyboard handlers select 10 or 40 pixels, obtain a projected rectangle, choose `clampMovedRect` or `clampResizedRect`, call `regionFromScreenRect`, and report the same crossing error. Both pointer handlers also repeat the move-versus-resize and conversion sequence. Shared low-level helpers prevent mathematical duplication, but their higher-level policy composition remains separately maintained.
8. **Reproduction:**
   1. Run `sed -n '224,243p;475,497p' surfaces/command-interface/src/ui/map/view/MapRegionComparison.tsx`.
   2. Run `sed -n '196,214p;304,323p' surfaces/command-interface/src/ui/map/view/MapAreaSelection.tsx` and compare the transformation sequences.
   3. Run `npm test --workspace @the-drunken-coder/atlas-command-interface -- src/ui/map/view/MapAreaSelection.test.tsx src/ui/map/view/MapView.comparison.test.tsx --maxWorkers=2` with Node 24.
9. **Notes:** Source finding F11, from the region-comparison discussion. Verified by source trace at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`; both relevant test files passed in the focused run. Current behavior is not reported broken. Pointer capture, Shift-drag zoom, and rollback differ between the features, so this finding does not justify replacing their entire lifecycles with one generalized controller. The existing polygon-ring report concerns closing-coordinate policy, a different root cause.
