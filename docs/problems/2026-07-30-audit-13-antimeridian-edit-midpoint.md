# Geometry edit midpoint crosses the long way at the antimeridian

1. **Time & Date:** 2026-07-30T18:00:00-07:00
2. **Name:** Geometry edit midpoint crosses the long way at the antimeridian
3. **Issue:** The edit overlay uses an arithmetic longitude mean, so adjacent positions at `179` and `-179` place the add-vertex handle at `0` instead of the antimeridian.
4. **Severity:** **S3 (Moderate)** — the edge case can persist a vertex on the opposite side of the world.
5. **Location:** `atlas_command_interface/src/ui/map/rendering/map-editing.ts:58-96`, `atlas_command_interface/src/features/MapConsole.tsx:219-225,327,348-360`
6. **Expected:** Midpoints use the shortest wrapped longitude delta and normalize the result to the repository convention; latitude remains an arithmetic mean.
7. **Actual:** `(179 + -179) / 2` produces `0`; the real marker click passes that longitude to `addVertexAfter` and persists it. This was confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Edit a LineString or Polygon edge between `[179,10]` and `[-179,10]`.
   2. The add-vertex marker appears at longitude 0; clicking it writes `[0,10]`.
   3. Add marker/click tests for both directions, exact ±180 endpoints, ordinary segments, LineStrings, and Polygon closing edges.
