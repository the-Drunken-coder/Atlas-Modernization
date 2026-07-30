# Audit 14: adding a geometry vertex drops trailing coordinate dimensions

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Original Audit Number:** 14
3. **Validation Status:** Confirmed against `main` at `2426bb6`.
4. **Name:** Adding a geometry vertex drops trailing coordinate dimensions
5. **Affected Surface & Severity:** Command-interface geofeature editing for multidimensional LineStrings and Polygon rings; **S3 (Moderate)** because the gesture silently changes the coordinate dimensionality of persisted geometry, but two-dimensional geometry is unaffected.
6. **Issue:** GeoJSON positions are explicitly modeled as `[longitude, latitude, ...number[]]`, and moving a vertex preserves the trailing numbers, but adding a vertex always constructs only `[longitude, latitude]`.
7. **Current vs Expected:**
   - **Current:** Clicking a midpoint on an elevated or otherwise extended LineString/Polygon inserts a two-dimensional position even when both neighboring positions have altitude or other dimensions. Point/circle geometries are unaffected because they have no add-vertex handles. Dragging an existing point, line, polygon, or circle vertex preserves its trailing dimensions.
   - **Expected:** For a consistently dimensioned segment, the inserted midpoint has the same coordinate arity and interpolated values for all dimensions. Inconsistent neighboring arity should follow one explicit, tested rule rather than silently truncating.
8. **Concrete Source Evidence:** `atlas_command_interface/src/atlas/geometry.ts:5` defines `Position` with trailing dimensions. `movePosition` at lines 232-234 preserves them and is used by point, circle, line, and polygon drag paths at lines 91-113 and 224-229. In contrast, `addVertexAfter` creates `const next: Position = [lng, lat]` at lines 116-133. The user gesture is real: `atlas_command_interface/src/ui/map/rendering/map-editing.ts:58-66` creates midpoint handles for LineStrings/Polygons and calls `addVertexAfter` on click. Existing tests at `atlas_command_interface/src/atlas/geometry.test.ts:123-143` protect drag preservation, while add tests around lines 148-188 use only two-dimensional fixtures.
9. **Reproduction / Static Proof:**
   1. Start with `{type:"LineString", coordinates:[[0,0,100,1],[2,2,200,3]]}`.
   2. Enter edit mode and click its midpoint handle.
   3. The click path calls `addVertexAfter` with midpoint longitude/latitude and returns `[[0,0,100,1],[1,1],[2,2,200,3]]`; altitude and the fourth dimension are absent from the new vertex.
   4. Repeat with an outer or inner Polygon ring; the same code inserts the same truncated position and then recloses the ring.
10. **Root Cause:** Midpoint rendering transports only `lng` and `lat`, and `addVertexAfter` constructs a fresh 2D position without access to the neighboring positions' remaining dimensions.
11. **Simplest Correct Proposed Solution:** Make the midpoint operation produce a complete `Position`: interpolate each dimension shared by consistently shaped adjacent positions, including longitude through the wrapped rule from finding 13, and pass that complete position to insertion. For mismatched dimensions, reject the insertion or use the minimal currently required explicit policy; do not invent a compatibility layer.
12. **Acceptance Criteria / Regression-Test Plan:**
   - User-path click tests cover a 3D LineString, 4D LineString, Polygon outer ring, Polygon inner ring, and Polygon closing edge.
   - New vertices retain the source arity and expected midpoint values; ring closure still duplicates the full first position.
   - Existing drag tests continue proving trailing dimensions are preserved.
   - Point and circle behavior is unchanged and no add handle is introduced for them.
13. **Scope / Non-Goals:** Do not add MultiPoint, MultiLineString, MultiPolygon, or arbitrary Feature editing. Do not infer semantics for trailing dimensions beyond numeric interpolation required to avoid destructive truncation.
14. **Overlaps:** Finding 13 changes longitude interpolation in the same midpoint path and should be covered by coordinated tests, without combining the two problem notes.
