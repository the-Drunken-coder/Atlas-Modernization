# Generic SDK watch permits filter and callback type mismatches

1. **Time & Date:** 2026-07-30T08:33:00Z
2. **Name:** Generic SDK watch permits filter and callback type mismatches
3. **Issue:** Callers can explicitly instantiate `client.watch<TaskResource>` with an entity filter; TypeScript accepts it and runtime passes an entity to a task-typed callback.
4. **Severity:** **S3 (Moderate)** — the public API can compile a callback whose promised resource type differs from runtime input.
5. **Location:** `atlas_sdk/src/types.ts:30-34,203-210`, `atlas_sdk/src/client.ts:263-268`, `atlas_sdk/src/sync-engine.ts:150-159`
6. **Expected:** Callback type is derived from the subscription discriminator: entity filters receive entities, task and `tasks_for_entity` filters receive tasks, object filters receive objects, and `all` receives the resource union.
7. **Actual:** `client.watch` and `SyncEngine.watch` expose a caller-selected generic independent of the filter, then suppress the mismatch with `resource as T | undefined`. This was confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Compile under strict TypeScript: `client.watch<TaskResource>({filter:"id", resource_type:"entity", id:"e"}, task => { task?.task_id; });`; it exits 0.
   2. At runtime, routing selects an entity event and the cast does not transform it.
   3. Make `watch` generic over subscription shape, derive its callback type, remove the broad cast, and add positive/negative type tests for every filter.
