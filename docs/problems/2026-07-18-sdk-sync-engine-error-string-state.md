# SDK sync engine uses error message strings as control flow

1. **Time & Date:** 2026-07-18T08:29:35-04:00
2. **Name:** SDK sync engine uses error message strings as control flow
3. **Issue:** `SyncEngine` stores human-readable error text in `lastError` and then branches on exact string equality and prefix matches to decide reconnect/recovery behavior, so rewording a message silently changes engine logic.
4. **Severity:** S4 (Minor)
5. **Location:** `atlas_sdk/src/sync-engine.ts` (lines 173, 190, 247, 530)
6. **Expected:** The engine tracks a small typed error kind for lifecycle decisions and keeps human-readable error text out of control flow.
7. **Actual:** Branches include `this.lastError === "Atlas Core feed connection failed"`, `this.lastError !== "Atlas Core recovery request failed"`, and `this.lastError?.startsWith("Atlas Core feed ")`. The message doubles as the machine-readable state discriminator.
8. **Reproduction:**
   1. Run `rg -n 'lastError ===|lastError !==|lastError\?\.startsWith' atlas_sdk/src/`
   2. Observe four hits in `sync-engine.ts` at lines 173, 190, 247, and 530, each gating error preservation or clearing on message text.
9. **Notes:** Verified against `main` at `2d6106e` on 2026-07-25. Add a private typed error kind alongside the existing public message, switch these four branches to the kind, and preserve the current messages and lifecycle behavior. Cover the change with `test/sync-engine-feed-recovery.test.ts` and `test/sync-engine-reconnect-cleanup.test.ts`.
