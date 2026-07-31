# SDK sync engine uses error message strings as status control flow

1. **Time & Date:** 2026-07-30T08:33:00Z (audit revalidation; originally recorded 2026-07-18)
2. **Name:** SDK sync engine uses error message strings as status control flow
3. **Issue:** `SyncEngine` stores only `lastError: string` and compares exact display wording or prefixes to decide which error to clear or preserve.
4. **Severity:** **S4 (Minor)** — rewording can leave stale errors visible or replace the wrong error, but current evidence does not show it suppressing connection, recovery, or reconnect work.
5. **Location:** `atlas_sdk/src/sync-engine.ts:106,173-217,224-258,501-565`
6. **Expected:** Display wording is independent from a small structured error discriminator; reconnect and recovery scheduling retain current behavior.
7. **Actual:** Four string predicates control only `lastError` mutation. Connection, recovery invalidation, health flags, and reconnect scheduling occur outside them. The original stronger recovery-suppression claim was not confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Run `rg -n 'lastError ===|lastError !==|lastError\?\.startsWith' atlas_sdk/src/sync-engine.ts`; it returns four comparisons.
   2. Rewording assignments can prevent the corresponding successful path from clearing an error or allow a feed error to overwrite a recovery error.
   3. Store a private structured kind beside the message, branch only on kind, preserve the public `SyncStatus` shape, and add wording-independent feed/recovery tests.
