# SDK sync engine uses error message strings as control flow

1. **Time & Date:** 2026-07-18T08:29:35-04:00
2. **Name:** SDK sync engine uses error message strings as control flow
3. **Issue:** `SyncEngine` stores human-readable error text in `lastError` and then branches on exact string equality and prefix matches to decide reconnect/recovery behavior, so rewording a message silently changes engine logic.
4. **Severity:** S4 (Minor)
5. **Location:** `atlas_sdk/src/sync-engine.ts` (lines 173, 190, 247, 530)
6. **Expected:** The engine tracks a typed error kind (small fixed set of values) for branching, and derives the display message from the kind. Renaming a message is then a cosmetic change with no behavioral effect.
7. **Actual:** Branches include `this.lastError === "Atlas Core feed connection failed"`, `this.lastError !== "Atlas Core recovery request failed"`, and `this.lastError?.startsWith("Atlas Core feed ")`. The message doubles as the machine-readable state discriminator.
8. **Reproduction:**
   1. Run `rg -n 'lastError ===|lastError !==|lastError\?\.startsWith' atlas_sdk/src/`
   2. Observe that each hit gates reconnect or error-clearing logic on message text
9. **Notes:** Latent fragility rather than a current bug: an innocent-looking message reword would pass type checks and most tests while changing which errors get cleared after a successful reconnect (the `startsWith("Atlas Core feed ")` case at line 530 is the most fragile). Fix pairs naturally with [2026-07-18-sdk-sync-engine-implicit-state-machine.md](2026-07-18-sdk-sync-engine-implicit-state-machine.md) since the error kind is part of the same state model. The existing reconnect/recovery test suites (`test/sync-engine-feed-recovery.test.ts`, `test/sync-engine-reconnect-cleanup.test.ts`) are the safety net for the change.
