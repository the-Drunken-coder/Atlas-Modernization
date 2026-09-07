# Symbol service exposes unused catalog and preload methods

1. **Time & Date:** 2026-09-07T08:15:44Z
2. **Name:** Symbol service exposes unused catalog and preload methods
3. **Issue:** The private symbol service exposes `getAvailableSymbols`, `getSymbolConfigs`, and `preload`, but no production caller uses those methods.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/command-interface/src/ui/symbols/sidc-symbol-service.ts:326-346`; production consumer at `surfaces/command-interface/src/ui/map/rendering/map-symbol-markers.ts:23-36`; accessor test at `surfaces/command-interface/src/ui/symbols/sidc-symbol-service.test.ts:63-65`.
6. **Expected:** The private service exposes operations needed by the current renderer. Catalog inspection and preload behavior should remain only if a current feature consumes them.
7. **Actual:** Production code uses `getAssetSymbol`, `getTrackSymbol`, and `render`. The available-symbol accessor and preload method have no caller, and the configuration accessor is called only by a test of its defensive-copy behavior. These methods enlarge the interface and retain unused behavior without serving a current operator feature.
8. **Reproduction:**
   1. Run `rg -n 'getAvailableSymbols|getSymbolConfigs|preload|defaultSidcIconService|createSidcIconService' surfaces/command-interface/src`.
   2. Inspect the factory's returned object and the marker renderer. Separate declarations and test calls from production invocations; only the three rendering operations are used in production.
   3. Run `npm test --workspace @the-drunken-coder/atlas-command-interface -- src/ui/symbols/sidc-symbol-service.test.ts --maxWorkers=2` with Node 24. Existing symbol tests passed during this investigation.
9. **Notes:** Source finding F14, narrowed from the rendering row's broad-interface concern to the three demonstrably unused methods. Verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. This package is private and the service is internal to the command interface. No incorrect symbols or runtime performance impact is claimed. Retain defensive copying used by construction and rendering; this finding does not establish that those helpers are unused.
