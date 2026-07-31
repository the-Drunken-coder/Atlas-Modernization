# SDK sync engine used error message strings as status control flow (resolved)

1. **Time & Date:** 2026-07-30T08:33:00Z (audit revalidation; originally recorded 2026-07-18)
2. **Name:** SDK sync engine used error message strings as status control flow (resolved)
3. **Issue:** **Resolved.** `SyncEngine` now stores a private `SyncErrorCode` and maps it to display wording only when returning `SyncStatus`.
4. **Severity:** **S4 (Minor)** — rewording can leave stale errors visible or replace the wrong error, but current evidence does not show it suppressing connection, recovery, or reconnect work.
5. **Location:** `atlas_sdk/src/sync-engine.ts:51-72,99,135-160,209-284,555-556`
6. **Expected:** Display wording is independent from a small structured error discriminator; reconnect and recovery scheduling retain current behavior.
7. **Actual:** The four string predicates were replaced with typed-code comparisons while preserving public error messages and lifecycle behavior. The original stronger recovery-suppression claim remains unconfirmed against pre-fix `main` at `2426bb6`.
8. **Reproduction:**
   1. Run `rg -n 'lastError ===|lastError !==|lastError\?\.startsWith' atlas_sdk/src/sync-engine.ts`; it returns no matches.
   2. Inspect `SyncErrorCode`, `SYNC_ERROR_MESSAGES`, and `lastErrorCode` in `atlas_sdk/src/sync-engine.ts`; lifecycle decisions use the code and `status()` performs the display mapping.
   3. Run `npm run test:coverage --workspace @the-drunken-coder/atlas-sdk`; the full Node suite passes with the public status wording unchanged.
