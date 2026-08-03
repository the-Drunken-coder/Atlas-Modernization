# Generic SDK watch permits filter and callback type mismatches

1. **Time & Date:** 2026-08-03T06:07:56Z (revalidated; originally recorded 2026-07-30)
2. **Name:** Generic SDK watch permits filter and callback type mismatches
3. **Issue:** Callers can explicitly instantiate `client.watch<TaskResource>` with an entity filter; TypeScript accepts it and runtime passes an entity to a task-typed callback.
4. **Severity:** **S3 (Moderate)** — the public API can compile a callback whose promised resource type differs from runtime input.
5. **Location:** `atlas_sdk/src/types.ts`, `atlas_sdk/src/client.ts`, `atlas_sdk/src/sync-engine.ts`
6. **Expected:** Callback type is derived from the subscription discriminator: entity filters receive entities, task and `tasks_for_entity` filters receive tasks, object filters receive objects, and `all` receives the resource union.
7. **Actual:** `client.watch` and `SyncEngine.watch` still expose a caller-selected generic independent of the filter, then suppress the mismatch with `resource as T | undefined`. This was revalidated against `main` at `f4b0187fdb68088ea0b59d28218d02204f4cfc9c`.
8. **Reproduction:**
   1. Compile under strict TypeScript: `client.watch<TaskResource>({filter:"id", resource_type:"entity", id:"e"}, task => { task?.task_id; });`; it exits 0.
   2. At runtime, routing selects an entity event and the cast does not transform it.
   3. Make `watch` generic over subscription shape, derive its callback type, remove the broad cast, and add positive/negative type tests for every filter.
