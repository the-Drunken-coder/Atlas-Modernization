# Problem Report

1. **Time & Date:** 2026-08-30T14:58:11Z
2. **Name:** First context click on an unselected map marker is dropped
3. **Issue:** A symbol marker selects its entity and opens the map command menu from the same native `contextmenu` listener, but React batches the selection update and the command-flow callback still observes the previous selection.
4. **Severity:** S3 (Moderate)
5. **Location:** Command interface, `surfaces/command-interface/src/ui/map/view/MapView.tsx` (`contextmenu` marker listener) and `surfaces/command-interface/src/features/commands/use-command-flow.ts` (selection-change cleanup and menu callback)
6. **Expected:** Right-clicking any visible asset marker should select that asset and open its map command menu at the clicked coordinates on the first gesture.
7. **Actual:** On an unselected marker, `MapView` calls `onSelectEntity` at lines 365 and then `onMapContextMenu` at line 366. The native listener runs outside React's handler and the `createRoot` application batches the selection update, so `onMapContextMenu` retains the previous render's `selectedEntity` at `use-command-flow.ts:109`. If the previous selection is not an asset it closes the menu immediately; if it is another asset it briefly sets the menu and the `[selectedId]` effect at lines 41–44 closes it after the selection commit. The operator must select the marker first and right-click again.
8. **Reproduction:**
   1. Run the focused existing guards: `npm test --workspace @the-drunken-coder/atlas-command-interface -- src/ui/map/view/MapView.markers.test.tsx` and `npm test --workspace @the-drunken-coder/atlas-command-interface -- src/features/commands/use-command-flow.test.tsx` (both pass, but they invoke the two callbacks independently and do not model the integrated selection state).
   2. Render the command interface with at least two visible asset markers and no selected entity (or a different selected entity).
   3. Right-click the unselected marker once.
   4. Observe `selectEntityById` dispatching the new selection, followed in the same native listener by `onMapContextMenu` evaluating the old `selectedEntity`; after React commits the selection, the selection-change effect clears `mapMenu`. No command menu remains visible.
   5. Right-click the same marker again. With the entity selected, `onMapContextMenu` now sees an asset and the menu opens.
9. **Notes:** A minimal React 19 `createRoot` probe with the same mutable handler-ref pattern records the old selection inside the native listener while the rendered button updates to the new selection, confirming the batching premise. Fix by passing the clicked entity (or its ID) into the context-menu flow, or by coordinating selection and menu state in one transaction; add an integrated MapConsole marker right-click test covering no selection and a different prior selection.
