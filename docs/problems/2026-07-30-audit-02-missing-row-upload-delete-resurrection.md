# Missing-row upload preflight can ignore a newer deletion

1. **Time & Date:** 2026-08-03T06:07:56Z (revalidated; originally recorded 2026-07-30)
2. **Name:** Missing-row upload preflight can ignore a newer deletion
3. **Issue:** If upload preflight sees no object row, another request can create and delete that ID while the blob write is in progress. Commit-time validation sees the newer tombstone but ignores it because the row did not exist at preflight, so the upload upsert recreates the deleted object.
4. **Severity:** **S1 (Blocker)** — a delete that wins the concurrent race can be reversed and clients can observe a tombstone followed by an unintended resurrection.
5. **Location:** `atlas_core/internal/actions/object_upload.go`, `atlas_core/internal/actions/object_actions.go`, `atlas_core/internal/actions/object_actions_test.go`
6. **Expected:** Any object tombstone committed after an upload's preflight prevents that in-flight upload from creating or updating the same ID. Tombstones already present at preflight do not prevent an intentional later recreation.
7. **Actual:** `objectDeletedAfterUploadPreflight` still returns true only when `preflight.rowExists && current.maxDeletionID > preflight.maxDeletionID`. With `rowExists=false`, it ignores a tombstone newer than preflight. This narrower missing-row race was revalidated against `main` at `f4b0187fdb68088ea0b59d28218d02204f4cfc9c`; the related existing-row race remains fixed.
8. **Reproduction:**
   1. Run `(cd atlas_core && GOCACHE=/tmp/atlas-audit-go-cache-actions go test ./internal/actions -run 'TestObjectDeletedAfterUploadPreflight|TestUploadDoesNotResurrectObjectDeletedDuringBlobWrite' -count=1 -v)`.
   2. The pure predicate case passes with `rowExists=false`, preflight deletion ID 7, and current deletion ID 8 returning false.
   3. Pause an absent-ID upload after preflight; create and delete the ID; resume upload. The upsert recreates it because the commit-time predicate does not reject the newer tombstone.
   4. Reject whenever `current.maxDeletionID > preflight.maxDeletionID`, regardless of `rowExists`; add a DB-backed absent-ID race test proving the tombstone remains and the uploaded path is cleaned.
