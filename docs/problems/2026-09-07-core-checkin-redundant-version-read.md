1. **Time & Date:** 2026-09-07T20:51:16Z
2. **Name:** Core check-ins perform an unnecessary version read
3. **Issue:** Every check-in reads the entity version before calling `EntityActions.Update`, including ordinary heartbeat updates with no expected-version precondition. Update then reads the same entity under its transaction's row lock.
4. **Severity:** S5 (Note)
5. **Location:** `services/core/internal/actions/entity_checkin_actions.go:35-42`, `services/core/internal/actions/entity_actions.go:226-239` and `319-364`, `services/core/internal/api/handlers/handler_requests.go:79-82`.
6. **Expected:** A successful check-in without `If-Match` relies on Update's existing entity read and transactional validation without a separate version-only query.
7. **Actual:** `CheckIn` unconditionally invokes `checkExpectedVersion`. That helper issues `SELECT version FROM entities WHERE entity_id = $1` even when the expected version is nil. The following nonempty Update performs a second entity read with `FOR UPDATE` and checks the expected version again. HTTP check-ins always add a heartbeat component, so they take the nonempty Update path.
8. **Reproduction:**
   1. Inspect `entity_checkin_actions.go:35-42` with `ExpectedVersion` nil and a nonempty heartbeat component.
   2. Follow the first call to `entity_actions.go:226-239`. There is no nil-precondition guard before the version query. `internal/actions/precondition.go` returns success for a nil expected version.
   3. Follow Update through `entity_actions.go:339-364`. The heartbeat prevents its empty-update shortcut; the transaction reads the entity with `FOR UPDATE` before the second version check.
   4. From `services/core`, run `go test -race -count=1 -run '^TestEntityCheckinRequestComponentUpdate$' ./internal/api/handlers` to verify the HTTP heartbeat transformation.
9. **Notes:** Source finding F02a, review section 2, verified at `c62cb735a91c780c1fc8a5820dfe3cebf1656841`. The extra SQL operation is confirmed by source trace; this investigation did not measure its latency or count live database requests. The focused transformation test passed. An early check may help reject stale explicit preconditions before acquiring the global change lock; that does not justify the unconditional read when no precondition exists. Preserve Update's transactional version check. Delete this note when fixed or invalidated.
