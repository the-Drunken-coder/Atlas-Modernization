# Repeated Task Acknowledgement Creates Redundant Changes

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Acknowledging an acknowledged task advances its version again
3. **Issue:** Repeating the acknowledge action on an already acknowledged task is accepted as a new mutation and emits unnecessary version/feed traffic.
4. **Severity:** S4 (Minor)
5. **Location:** `Atlas_Core/internal/actions/task_actions.go`, task lifecycle handlers under `Atlas_Core/internal/api/handlers/`
6. **Expected:** A repeated acknowledgement should either be a true idempotent no-op or return a typed transition response without creating a redundant resource version.
7. **Actual:** A second acknowledgement returned `200` and advanced the task from version 19 to version 20 even though its meaningful lifecycle state did not change.
8. **Reproduction:**
   1. Create a pending task
   2. Acknowledge it and record the returned version
   3. Acknowledge the same task again
   4. Observe another `200`, a new version, and a corresponding change event
9. **Notes:** This is not a correctness failure in the tested lifecycle, but retries or repeated operator actions can create avoidable feed churn and audit noise.
