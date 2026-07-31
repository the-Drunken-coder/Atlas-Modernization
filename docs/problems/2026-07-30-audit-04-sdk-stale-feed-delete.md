# Stale SDK feed delete can clear a pending local delete

1. **Time & Date:** 2026-07-30T08:33:00Z
2. **Name:** Stale SDK feed delete can clear a pending local delete
3. **Issue:** `SyncEngine.applyEvent` clears a pending local delete before applying its version guard, so a delayed older feed delete can remove the pending protection and allow later recovery data to appear live.
4. **Severity:** **S2 (Major)** — Atlas SDK cache state can resurrect a Core-deleted resource, although Core's durable state remains correct.
5. **Location:** `atlas_sdk/src/cache.ts:186-203`, `atlas_sdk/src/sync-engine.ts:573-632`, `atlas_sdk/test/sync-engine-reconnect-cleanup.test.ts:434-477`
6. **Expected:** A stale delete is ignored without clearing the pending marker; only a delete newer than the local tombstone acknowledges the pending local delete.
7. **Actual:** The pending-delete branch clears `pendingDeletes` and overwrites the tombstone before `event.version <= versionFor(...)` is checked. A later recovered resource is then accepted. This was confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Hydrate entity version 1, delete it locally, emit a delayed feed delete at version 1, then return a changed-since entity at version 2.
   2. Call `client.changedSince()`; `client.entities.get(id)` resolves to the version-2 entity.
   3. Apply the per-resource version guard before mutating pending-delete state, and add a stale-delete counterpart to the existing stale-update regression.
