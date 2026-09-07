# Entity lists sort unrelated kinds before filtering

1. **Time & Date:** 2026-09-07T08:15:44Z
2. **Name:** Entity lists sort unrelated kinds before filtering
3. **Issue:** Requesting a single entity kind sorts every selectable entity, including entities that the requested list will discard.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/command-interface/src/atlas/selectors.ts:11-19` and its list-rendering caller at `surfaces/command-interface/src/features/MapConsole.tsx:856-865`.
6. **Expected:** A kind-specific list filters to the requested kind before sorting, while preserving the current display-name ordering of the returned entities.
7. **Actual:** `entitiesByKind` calls `listEntities`, which filters only for selectability and sorts the full collection, and then filters to the requested kind. A disposable probe with one asset and one track recorded a string comparison while returning the single asset; sorting the requested one-item list needs no comparisons.
8. **Reproduction:**
   1. Run `sed -n '10,19p' surfaces/command-interface/src/atlas/selectors.ts` and inspect the `entitiesByKind` call in `MapConsole.tsx`.
   2. Using `entityFixture`, create an asset with alias `Z` and a track with alias `A`. Put both in one `AtlasSnapshot` and spy on `String.prototype.localeCompare`.
   3. Call `entitiesByKind(snapshot, "asset")`. It returns only the asset but performs one comparison involving the unrelated track. Filtering to assets first produces the same output without that comparison.
9. **Notes:** Source finding F07a, split from the entity-browsing row and selector discussion because entity sort order and repeated task derivation have distinct causes. Verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. The disposable probe passed. No incorrect list ordering or measured user-visible slowdown is claimed. A direct filter-before-sort expression is sufficient; a new cache or abstraction is not required.
