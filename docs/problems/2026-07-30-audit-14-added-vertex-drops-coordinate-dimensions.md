# Adding a geometry vertex drops trailing coordinate dimensions

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Name:** Adding a geometry vertex drops trailing coordinate dimensions
3. **Issue:** GeoJSON positions allow `[longitude, latitude, ...number[]]`, but adding a vertex always constructs only `[longitude, latitude]`.
4. **Severity:** **S3 (Moderate)** — editing silently changes persisted coordinate dimensionality.
5. **Location:** `atlas_command_interface/src/atlas/geometry.ts:5,91-133,224-234`, `atlas_command_interface/src/atlas/geometry.test.ts:123-188`, `atlas_command_interface/src/ui/map/rendering/map-editing.ts:58-66`
6. **Expected:** A midpoint on consistently dimensioned positions retains the same arity and interpolates every dimension; mismatched arity follows one explicit tested rule.
7. **Actual:** Moving a position preserves trailing dimensions, but `addVertexAfter` constructs a new 2D position. LineString and Polygon midpoint clicks therefore truncate altitude and later dimensions. This was confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Start with `{type:"LineString",coordinates:[[0,0,100,1],[2,2,200,3]]}` and click its midpoint handle.
   2. The result is `[[0,0,100,1],[1,1],[2,2,200,3]]`.
   3. Pass a complete interpolated `Position` through the midpoint/insertion path and test 3D/4D LineStrings plus Polygon outer, inner, and closing edges.
