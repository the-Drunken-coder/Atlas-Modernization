1. **Time & Date:** 2026-08-30T14:54:42Z
2. **Name:** Runtime delivery can return work to a replaced runtime
3. **Issue:** `TaskActions.Deliverable` validates the current ready runtime and selects pending Tasks in separate database statements without holding a lifecycle lock across both reads. A runtime replacement can commit between those statements, so the delivery route can return Tasks bound to a runtime that is no longer current.
4. **Severity:** S3 (Moderate)
5. **Location:** `services/core/internal/actions/task_runtime.go` (`Deliverable`, `installRuntimeRegistration`, and `failRuntimeTaskBatch`); `services/core/internal/api/handlers/handler_task_runtime.go`
6. **Expected:** `GET /entities/{entity_id}/runtime/tasks` returns Tasks only when the supplied `Atlas-Runtime-ID` is still the current ready runtime for the Asset. A runtime replacement should prevent delivery to the old process throughout the read.
7. **Actual:** `Deliverable` reads `runtime_id, ready` with `pool.QueryRow` at lines 357–359, then later queries pending Tasks at lines 374–383. `BeginRuntimeRegistration` can commit a new, not-ready runtime at lines 112–125 after the first statement and before the second. Its separate drain transaction has not necessarily failed the old runtime's pending Tasks yet, so the second query can return those old Tasks even though the old runtime is stale. Subsequent acknowledge/start calls reject that runtime, but the stale process has already received the work.
8. **Reproduction:**
   1. Register and ready runtime `runtime-1` for an Asset, then create a pending Task bound to `runtime-1`.
   2. Start `GET /entities/{asset_id}/runtime/tasks` with `Atlas-Runtime-ID: runtime-1`; let the first `SELECT runtime_id, ready` statement complete.
   3. Before the delivery query runs, register `runtime-2`. `installRuntimeRegistration` commits `runtime-2` as current and not ready, while the subsequent `failRuntimeTaskBatch` drain is still a separate transaction.
   4. Allow the in-flight delivery request's second query to run before the drain transaction commits. It filters by `runtime_id = 'runtime-1'` and `status = 'pending'` and returns the Task instead of rejecting the stale runtime.
   5. The normal lifecycle test `TestTaskLifecycleIdempotencyOrderingAndRuntimeFencing` covers only a serial delivery after the replacement drain completes; it does not cover this interleaving.
9. **Notes:** Confirmed by source-level interleaving at commit `804bf32fa733ca582f931816f58cdb5aae218701`; no product or test files were changed. Keep the runtime check and Task selection in one transaction while locking the current runtime row through the read (or use an equivalent lifecycle fence), then add a controlled concurrency regression test that pauses between the two statements.
