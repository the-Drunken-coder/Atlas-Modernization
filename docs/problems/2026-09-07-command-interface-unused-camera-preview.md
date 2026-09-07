# Main-map preview and restoration have no production caller

1. **Time & Date:** 2026-09-07T08:15:44Z
2. **Name:** Main-map preview and restoration have no production caller
3. **Issue:** The main camera retains preview-origin storage, preview flight behavior, and return-to-origin logic although the current workspace never issues a preview camera command.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/command-interface/src/ui/map/interaction/use-map-camera.ts:44-48`, `72-78`, `130-140`, and `159-169`; `surfaces/command-interface/src/ui/map/interaction/map-camera.ts`; command producers in `surfaces/command-interface/src/features/MapConsole.tsx:106-124`, `357-363`, and `625-628`.
6. **Expected:** The private main-camera implementation supports the workspace's actual camera intents. Place hover/focus previews remain in the separate noninteractive detail map, as documented in the command-interface README.
7. **Actual:** Workspace command producers issue default focus, commit, or world intents. Hovering a place sets `placePreviewTarget` and renders `PlaceDetailLens`; it does not issue a main-camera preview. The main-camera preview branches remain reachable through synthetic test commands but have no production producer.
8. **Reproduction:**
   1. Run `rg -n 'issueCameraCommand|setCameraCommand|placePreviewTarget' surfaces/command-interface/src/features/MapConsole.tsx` and inspect every producer and the `placeDetailTarget` prop.
   2. Run `rg -n 'previewOriginRef|PREVIEW_RESTORE_MS|intent === "preview"' surfaces/command-interface/src/ui/map/interaction` to identify the retained preview-only behavior.
   3. Search production source for camera intent producers with `rg -n 'intent|issueCameraCommand|setCameraCommand' surfaces/command-interface/src --glob '!*.test.*' --glob '!*.test-harness.*'`. Verify that no call supplies the preview intent.
   4. Inspect the README's Place Search contract and `PlaceDetailLens.tsx:166-183`; the local map frames previews independently. The existing place-detail and camera-planning tests passed in the focused run.
9. **Notes:** Source finding F13, from the camera module row. Verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. This is unused private behavior, not a camera failure. Preserve `PREVIEW_POINT_ZOOM` and `PREVIEW_FIT_MAX_ZOOM`, which the detail lens still uses. Preserve world-copy handling used by live commit/focus commands. Do not remove preview behavior merely by matching names.
