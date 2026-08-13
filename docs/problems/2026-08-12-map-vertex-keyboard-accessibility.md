1. **Time & Date:** 2026-08-12T22:55:06-04:00
2. **Name:** Map vertex handles are not keyboard operable
3. **Issue:** Existing geometry vertices can be moved by dragging and removed with a context-menu action, but the vertex handles are non-focusable `div` elements with no keyboard equivalents.
4. **Severity:** S3 (Moderate)
5. **Location:** Atlas Command Interface, `atlas_command_interface/src/ui/map/rendering/map-editing.ts` and `atlas_command_interface/src/ui/styles/map.css`
6. **Expected:** A focused vertex handle moves by 1 meter with an arrow key, moves by 10 meters with Shift plus an arrow key, and removes the vertex with Delete or Backspace only when `canRemoveVertex` permits it. The numeric inspector remains available for exact coordinates.
7. **Actual:** Vertex handles cannot receive keyboard focus. The existing focus-visible rule is unreachable, and drag plus right-click are the only direct-map controls.
8. **Reproduction:**
   1. Open a geofeature with editable point, line, or polygon geometry
   2. Enter geometry editing mode
   3. Use Tab to navigate the map editing controls
   4. Observe that midpoint add buttons receive focus but existing vertex handles do not
9. **Notes:** Before editing production UI, create three distinct static mocks covering handle appearance, focus state, labels, and keyboard guidance. Present them through the visualization workflow and stop until the developer selects one. Add focused keyboard tests for movement bounds, polygon closure, guarded removal, and event propagation.
