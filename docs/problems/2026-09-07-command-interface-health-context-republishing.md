# Unchanged connection health republishes the Atlas context

1. **Time & Date:** 2026-09-07T08:15:44Z
2. **Name:** Unchanged connection health republishes the Atlas context
3. **Issue:** Each successful health poll creates a new health object, which changes the entire Atlas context even when every health field and resource is unchanged. Consumers that only read configuration rerender too.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/command-interface/src/atlas/data-source.ts`, `health()`; `surfaces/command-interface/src/state/atlas-context.tsx:87-98`, `143-149`, and `180-221`.
6. **Expected:** Repeated equal health samples preserve the published state identity. Unchanged health should not invalidate configuration-only or resource-only consumers. Actual connection changes must remain observable.
7. **Actual:** The SDK adapter returns a fresh health object. `publishHealth` passes it directly to `setHealth`, and `health` is a dependency of the combined context value. A disposable probe with a memoized configuration-only consumer, a constant snapshot, and equal healthy samples observed three extra renders after three successive 3-second polls.
8. **Reproduction:**
   1. Inspect `health()` in `surfaces/command-interface/src/atlas/data-source.ts`, then run `sed -n '87,98p;143,149p;180,221p' surfaces/command-interface/src/state/atlas-context.tsx` to trace the fresh object into the context.
   2. Render `AtlasProvider` with a fixed config and an injected data source whose snapshot is constant, whose startup and catalog load resolve, and whose `health()` returns a fresh `{ running: true, healthy: true, degraded: false }` each time. Render a memoized child that calls `useAtlas()` only to read `config`; count its renders after startup settles.
   3. Advance fake timers by 3,000 ms in three separate React `act` calls. The render count increases by three although the consumed configuration and all health values remain unchanged.
9. **Notes:** Source finding F03a, from the live-data row and UI-state discussion in the preceding module assessment. Verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. The disposable Vitest probe passed outside the repository; existing provider tests also passed. This confirms redundant publication, not a measured frame-rate or latency regression. Equality suppression is a narrower first remedy than replacing the state system. Separate contexts are an architectural option, not required by this report.
