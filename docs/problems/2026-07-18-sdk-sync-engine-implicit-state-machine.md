# SDK sync engine state is an implicit machine spread across boolean flags

1. **Time & Date:** 2026-07-18T08:29:35-04:00
2. **Name:** SDK sync engine state is an implicit machine spread across boolean flags
3. **Issue:** `SyncEngine` encodes its lifecycle in six independent fields (`syncRunning`, `healthy`, `degraded`, `reconnecting`, `reconnectAfterRecovery`, `lastError`) plus three counters (generation, feed attempt, recovery operation), so many invalid combinations are representable and nearly every method needs manual `isCurrent(...)` guards. The recent seam split did not move this complexity out.
4. **Severity:** S4 (Minor)
5. **Location:** `atlas_sdk/src/sync-engine.ts`, `atlas_sdk/src/sync-engine-lifecycle.ts`, `atlas_sdk/src/sync-engine-recovery.ts`, `atlas_sdk/src/sync-engine-reconnect.ts`
6. **Expected:** An explicit lifecycle state (e.g. stopped → starting → live → degraded → reconnecting) plus a typed error kind makes impossible combinations unrepresentable and turns most staleness guards into structural checks. Extracted helpers own a real behavior, not just storage.
7. **Actual:** `healthy` and `degraded` are always assigned as a pair (one tri-state pretending to be two booleans). The extracted `SyncLifecycle` (48 lines) and `ReconnectTimer` (23 lines) are counters/timers with getters and setters; `sync-engine.ts` retains all coordination logic at 745 lines plus a block of pure delegation accessors (lines 422–456). File sizes improved; the state design did not change.
8. **Reproduction:**
   1. Run `rg -n 'healthy = |degraded = ' atlas_sdk/src/sync-engine.ts` and observe the fields are always set together
   2. Read `atlas_sdk/src/sync-engine-lifecycle.ts` and note its API is getters/setters over private counters
   3. Count `isCurrent`/`isCurrentFeedConnection`/`isCurrentOperation` guard call sites in `sync-engine.ts`
9. **Notes:** This is the highest-stakes code in the SDK (AGENTS.md already flags stale-generation callbacks as a recurring hazard), so the risk is future edits, not current behavior — the reconnect/recovery suites pass. When rework happens, ask for the design change by name ("explicit state enum + typed error kind"), not for smaller files: file-size-driven splits reproduce the current shape. Related smaller cleanups in the same file: `readEntity`/`readTask`/`readObject` (lines 266–307) are three near-identical methods, and `applyEvent` contains two identical five-line delete blocks (lines 579–588 vs 597–606). See also [2026-07-18-sdk-sync-engine-error-string-state.md](2026-07-18-sdk-sync-engine-error-string-state.md).
