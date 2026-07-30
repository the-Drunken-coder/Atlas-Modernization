# Audit 13: geometry edit midpoint crosses the long way at the antimeridian

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Original Audit Number:** 13
3. **Validation Status:** Confirmed against `main` at `2426bb6`.
4. **Name:** Geometry edit midpoint crosses the long way at the antimeridian
5. **Affected Surface & Severity:** Command-interface map editing for LineString geofeatures and every Polygon ring; **S3 (Moderate)** because this antimeridian edge case can insert a vertex on the opposite side of the world and persist wrong geometry.
6. **Issue:** The edit overlay calculates longitude with an arithmetic mean. For adjacent coordinates at `179` and `-179`, it places the add-vertex handle at longitude `0` instead of on the short arc at `180`/`-180`.
7. **Current vs Expected:**
   - **Current:** `(179 + -179) / 2` produces `0`; the real editing path creates a clickable MapLibre marker there and persists that longitude through `addVertexAfter`.
   - **Expected:** Midpoints use the shortest wrapped longitudinal delta. The example segment should produce an equivalent antimeridian longitude (`180` or `-180`), while ordinary non-wrapping segments retain their existing midpoint.
8. **Concrete Source Evidence:** `atlas_command_interface/src/ui/map/rendering/map-editing.ts:58-66` turns every computed midpoint into the user-visible “Click to add a vertex” marker and passes its coordinates to `addVertexAfter`. `midpoints` covers LineStrings at lines 72-81 and every Polygon ring at lines 83-90. `midpoint` at lines 94-96 performs the incorrect arithmetic mean. `atlas_command_interface/src/features/MapConsole.tsx:219-225,327,348-360` establishes the path from a selected geofeature's geometry into live map edit state and back into the draft.
9. **Reproduction / Static Proof:**
   1. Select a LineString or Polygon whose adjacent positions are `[179, 10]` and `[-179, 10]`, then enter geofeature edit mode.
   2. Inspect the MapLibre marker titled `Click to add a vertex`; source evaluation gives `lng = (179 + -179) / 2 = 0`.
   3. Click it. The handler calls `addVertexAfter(..., 0, 10)`, so saving writes a vertex near Greenwich rather than at the antimeridian.
   4. A focused regression may exercise `createEditingMarkers` with a fake marker constructor and assert both the marker `setLngLat` input and the `onChange` geometry after a real click event; a helper-only assertion is insufficient.
10. **Root Cause:** Longitude is treated as an unbounded Cartesian coordinate even though valid longitudes wrap at ±180 degrees.
11. **Simplest Correct Proposed Solution:** Compute the signed shortest longitude delta in `[-180, 180]`, add half to the first longitude, and normalize the result to the repository's chosen `[-180, 180]` convention. Keep latitude's arithmetic mean.
12. **Acceptance Criteria / Regression-Test Plan:**
   - User-path marker/click tests cover `179 -> -179`, `-179 -> 179`, a segment ending exactly at ±180, and an ordinary segment such as `10 -> 20`.
   - Both LineString and Polygon closing-edge handles use the wrapped midpoint.
   - Clicking the antimeridian handle yields a saved draft with longitude equivalent to ±180 and does not move unrelated vertices.
13. **Scope / Non-Goals:** No geodesic great-circle editor, map-world-copy redesign, or support for geometry kinds the UI does not currently edit. Latitude interpolation remains linear.
14. **Overlaps:** Finding 14 concerns the same add-vertex gesture dropping trailing coordinate dimensions; one regression fixture can cover both behaviors, but the remedies and notes remain separate.
