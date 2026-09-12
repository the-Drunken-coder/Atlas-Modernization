1. **Time & Date:** 2026-09-12T23:06:25Z
2. **Name:** Selected Geofeature has no delete control
3. **Issue:** The built Command Interface cannot delete a selected Geofeature through its browser controls.
4. **Severity:** S2 (Major)
5. **Location:** `surfaces/command-interface/src/features/geofeatures/GeofeatureInspector.tsx:27-101`, `surfaces/command-interface/src/atlas/data-source.ts:31-43`, `surfaces/command-interface/src/state/atlas-context.tsx:17-31`
6. **Expected:** A selected Geofeature exposes one enabled delete or remove control. Activating it deletes the Entity through Core, removes its row from the interface, and leaves an independent fresh SDK read returning HTTP 404.
7. **Actual:** The inspector exposes only `Edit` and `Raw entity JSON`. `GeofeatureInspectorProps`, `AtlasDataSource`, and `AtlasContextValue` provide create and geometry-update operations but no Geofeature deletion operation.
8. **Reproduction:**
   1. Check out `06472c8626560d0834197024f163fa1d9dc92fe3` with a clean working tree.
   2. With Node 24 and Docker running, execute `npm run test:acceptance:browser-geofeatures -- --browser=chromium`.
   3. Let the journey create, edit, save, reload, and reselect its line Geofeature.
   4. Observe the active assertion `chromium exposed an existing browser control to delete the selected Geofeature` fail with zero deletion controls.
9. **Notes:** The first clean-SHA failure took 88.968 seconds. Evidence is under `.atlas/acceptance/browser-geofeatures-chromium/browser-geofeatures-chromium-resume-380-06472c86-8b971b52-d3ec-4e4c-a7db-b04ff50c16ef/`. Earlier assertions in that run passed, including structural coordinate equality, real map selection, keyboard and pointer vertex editing, stale-save draft retention, discard confirmation, drawing precedence, successful save, reload, and an independent Core read. Keep the deletion assertion active until a separate product repair adds the supported UI and data-source path.
