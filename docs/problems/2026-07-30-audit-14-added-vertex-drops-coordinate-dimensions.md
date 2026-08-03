# Adding a geometry vertex drops trailing coordinate dimensions

1. **Time & Date:** 2026-08-03T06:07:56Z (revalidated; originally recorded 2026-07-30)
2. **Name:** Adding a geometry vertex drops trailing coordinate dimensions
3. **Issue:** GeoJSON positions allow `[longitude, latitude, ...number[]]`, but adding a vertex always constructs only `[longitude, latitude]`.
4. **Severity:** **S3 (Moderate)** — editing silently changes persisted coordinate dimensionality.
5. **Location:** `atlas_command_interface/src/atlas/geometry.ts`, `atlas_command_interface/src/atlas/geometry.test.ts`, `atlas_command_interface/src/ui/map/rendering/map-editing.ts`
6. **Expected:** A midpoint on consistently dimensioned positions retains the same arity and interpolates every dimension; mismatched arity follows one explicit tested rule.
7. **Actual:** Moving a position preserves trailing dimensions, but `addVertexAfter` still constructs a new 2D position. LineString and Polygon midpoint clicks therefore truncate altitude and later dimensions. This was revalidated against `main` at `f4b0187fdb68088ea0b59d28218d02204f4cfc9c`.
8. **Reproduction:**
   1. Start with `{type:"LineString",coordinates:[[0,0,100,1],[2,2,200,3]]}` and click its midpoint handle.
   2. The result is `[[0,0,100,1],[1,1],[2,2,200,3]]`.
   3. Pass a complete interpolated `Position` through the midpoint/insertion path and test 3D/4D LineStrings plus Polygon outer, inner, and closing edges.
