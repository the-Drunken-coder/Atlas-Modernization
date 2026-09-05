# F01: Duplicated polygon ring handling in the command interface

1. **Time & Date:** 2026-09-04T23:55:26+00:00
2. **Name:** Duplicated polygon ring handling in the command interface
3. **Issue:** Polygon editing owns two private copies of the same ring-opening policy. `geometry.ts` and `map-editing.ts` each implement `openRing`, and each implementation uses the same coordinate-equality rule to remove a repeated closing coordinate.
4. **Severity:** S5 (Note)
5. **Location:** Atlas Command Interface, [`surfaces/command-interface/src/atlas/geometry.ts`](../../surfaces/command-interface/src/atlas/geometry.ts#L240) and [`surfaces/command-interface/src/ui/map/rendering/map-editing.ts`](../../surfaces/command-interface/src/ui/map/rendering/map-editing.ts#L103)
6. **Expected:** Polygon geometry helpers have one geometry-owned `openRing` and coordinate-equality policy. Map editing reuses that helper while preserving the current `1e-9` tolerance and closed-ring behavior.
7. **Actual:** `geometry.ts:240-255` defines `openRing` and `positionsEqual` using `COORDINATE_EPSILON = 1e-9`. `map-editing.ts:103-113` defines a second `openRing` and `positionsEqual` with the same effective `1e-9` tolerance. The renderer already imports the geometry module, so both copies are reachable from the same command-interface package. Current behavior matches; the concrete issue is duplicate policy ownership that can drift during later polygon-editing changes.
8. **Reproduction:**
   1. Run `sed -n '240,255p' surfaces/command-interface/src/atlas/geometry.ts`.
   2. Run `sed -n '103,113p' surfaces/command-interface/src/ui/map/rendering/map-editing.ts`.
   3. Compare the two `openRing` bodies and their `positionsEqual` calls. Both remove the final coordinate when the first and last coordinates differ by less than `1e-9`; `geometry.ts` is used by vertex listing, add, remove, move, validation, and summaries, while `map-editing.ts` independently uses the same policy for polygon midpoint markers.
9. **Notes:**
   - Source mapping: F01 combines Slopo cluster 03 (`30bc94dd8fb2`) and cluster 04 (`fb4ae71c24ba`), which the review summary identifies as one cleanup.
   - Source evidence refreshed against main commit `cf90a53ad03b4796ea47c649b525f0cb282c1a14`.
   - This is a confirmed maintenance duplication, not a reported runtime failure. The focused command-interface tests could not run because `vitest` is not installed in this checkout (`npm test --workspace @the-drunken-coder/atlas-command-interface -- src/atlas/geometry.test.ts src/ui/map/view/MapView.editing.test.tsx` exited with `sh: vitest: command not found`). No dependencies were installed.
