# Missing-row upload preflight can ignore a newer deletion

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Missing-row upload preflight can ignore a newer deletion
3. **Original Audit Finding:** 2
4. **Validation Status:** Confirmed against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`. The related existing-row race is already fixed; the narrower missing-row race remains.
5. **Issue:** If an upload preflight sees no object row, another request can create and delete that ID while the blob write is in progress. Commit-time validation sees the newer tombstone but deliberately ignores it because the row did not exist at preflight, so the upload upsert recreates the deleted object.
6. **Affected Surface & Severity:** Atlas Core object upload consistency, changed-since consumers, and object durability; **S1 (Blocker)** because a delete that wins the concurrent race can be reversed and clients can observe a tombstone followed by an unintended resurrection.
7. **Location:** `atlas_core/internal/actions/object_upload.go:35-85`, `atlas_core/internal/actions/object_upload.go:185-240`, `atlas_core/internal/actions/object_actions.go:351-409`, and `atlas_core/internal/actions/object_actions_test.go:299-334,474-591`.
8. **Expected:** Any object tombstone committed after an upload's preflight prevents that in-flight upload from creating or updating the same ID. Tombstones already present at preflight do not prevent an intentional later recreation.
9. **Actual:** Preflight records both `rowExists` and `maxDeletionID`. Commit re-reads the same fields, but `objectDeletedAfterUploadPreflight` returns true only when `preflight.rowExists && current.maxDeletionID > preflight.maxDeletionID`. The unit case named `new object create is allowed despite prior tombstone` passes with `rowExists=false`, preflight deletion ID 7, and current deletion ID 8, even though ID 8 is not prior to the upload—it is newer.
10. **Concrete Evidence / Reproduction:**
    1. Run `(cd atlas_core && GOCACHE=/tmp/atlas-audit-go-cache-actions go test ./internal/actions -run 'TestObjectDeletedAfterUploadPreflight|TestUploadDoesNotResurrectObjectDeletedDuringBlobWrite' -count=1 -v)`.
    2. The predicate test passes all cases, including the missing-row/newer-tombstone case returning false.
    3. Static reachable schedule: start `Upload` for absent ID X and pause in `UploadObjectFromReaderToPath` after preflight; create X; delete X, which commits a new tombstone; resume the upload. Lines 215-220 do not reject it, and lines 228-240 upsert and commit X.
    4. The DB-backed existing-row race test skipped in this checkout because no test database was configured. Its setup creates the object before upload (`object_actions_test.go:513-520`), so it covers only `preflight.rowExists=true` and does not disprove the missing-row schedule.
11. **Root Cause:** The version comparison is incorrectly coupled to whether an object row existed at preflight. `maxDeletionID` already distinguishes an older tombstone from one created during the upload, so the `rowExists` condition discards the needed concurrency signal.
12. **Simplest Correct Proposed Solution:** Reject whenever `current.maxDeletionID > preflight.maxDeletionID`, regardless of `preflight.rowExists`. This keeps recreation after a pre-existing tombstone valid while preventing any delete committed during the blob-write window from being overwritten.
13. **Acceptance Criteria / Regression-Test Plan:**
    1. Add a DB-backed race test that pauses an absent-ID upload, creates and deletes that ID, resumes upload, and asserts `NotFoundError`, no object row, the tombstone remains, and the newly uploaded path is cleaned.
    2. Retain the existing existing-row delete race test.
    3. Add/adjust a pure predicate case proving an older tombstone present at both reads still allows intentional recreation.
    4. Verify the failed upload emits no create/update feed event and does not remove the concurrent delete tombstone.
14. **Scope / Non-Goals:** Do not ban all reuse of deleted IDs, add permanent tombstone uniqueness, change object IDs, or serialize object-store I/O inside the database transaction.
15. **Overlaps:** Finding 6 covers orphaned blobs across process crashes in the same upload workflow. This finding covers a live concurrency decision and should use the existing failure cleanup path once the newer tombstone is detected.
