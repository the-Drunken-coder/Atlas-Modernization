# Object upload crash windows can leave untracked blobs

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Object upload crash windows can leave untracked blobs
3. **Original Audit Finding:** 6
4. **Validation Status:** Confirmed by static crash-window proof against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`.
5. **Issue:** Upload cleanup is durable only after a failure is observed by the running process. A crash between object-store mutation and database bookkeeping can leave a versioned blob with neither live metadata nor a deletion-outbox row, and a replacement crash can leave the superseded blob unqueued.
6. **Affected Surface & Severity:** Atlas Core production MinIO capacity, backup consistency, and operator durability; **S2 (Major)** because durable storage can accumulate unreachable data with no built-in detection or recovery path, although an individual orphan does not immediately corrupt the live metadata view.
7. **Location:** `atlas_core/internal/actions/object_upload.go:134-160`, `atlas_core/internal/actions/object_upload.go:185-261`, `atlas_core/internal/actions/object_storage_deletions.go:22-39,66-103,153-273`, `atlas_core/internal/storage/storage.go:171-207`, and `atlas_core/cmd/atlas_core/main.go:43-61,193-202`.
8. **Expected:** After restart/reconciliation, every versioned blob is either referenced by committed object metadata or represented by durable cleanup state; superseded paths are durably queued in the same transaction that makes them unreachable.
9. **Actual:** The new path is generated in memory, written to MinIO, and only then is the metadata transaction begun. Error returns invoke immediate deletion and queue a retry if deletion fails, but process termination bypasses those calls. After a successful replacement commit, the old path is deleted/queued only in later non-transactional code.
10. **Concrete Evidence / Reproduction:**
    1. **Window A—ambiguous/finished object-store write:** terminate after `PutObject` has created the versioned path but before `UploadObjectFromReaderToPath` returns or before line 205 begins the metadata transaction. No database row records the path.
    2. **Window B—metadata transaction in progress:** terminate after line 205 and before the commit at lines 233-240. PostgreSQL rolls back, but the already-written blob remains and no outbox row was committed.
    3. **Window C—replacement committed:** terminate after the new metadata commit at line 240 and before old-path cleanup at lines 255-258. The new blob is live, but the old now-unreferenced blob has no outbox row.
    4. Run the focused actions tests for `TestCleanupUploadedPathAfterFailure*`. Direct delete/reporting tests pass; the outbox test skips without a database. These tests prove handled error cleanup, not crash recovery.
    5. The one-minute reconciler (`main.go:43-61`) processes only existing `storage_deletion_outbox` rows and never inventories unreferenced object-store keys, so none of the three unrecorded paths can be discovered.
11. **Root Cause:** MinIO mutation and PostgreSQL metadata cannot be committed atomically, and upload has no durable intent/reconciliation record spanning that boundary. Old-path deletion is also queued after, rather than atomically with, the metadata swap.
12. **Simplest Correct Proposed Solution:** In the metadata transaction, enqueue the superseded old path at the same time the new path becomes authoritative; after commit, the existing reconciler can delete it. For newly written paths, add a narrow orphan-reconciliation operation that compares versioned object-store keys with committed metadata and deletes only unreferenced keys under a safe operator-controlled/quiesced or proven-expired policy. Do **not** put the new path into the current immediately-due deletion outbox before upload: the minute reconciler can claim and delete it while upload/metadata commit is still active, turning a successful upload into a dangling reference.
13. **Acceptance Criteria / Regression-Test Plan:**
    1. Failpoint/process-kill integration tests cover all three windows, restart Core/reconciliation, and assert no unreferenced blob remains.
    2. A normal replacement commits an outbox record for the old path atomically with the metadata swap; rollback commits neither.
    3. Reconciliation rechecks that a candidate path is not referenced before deletion and is idempotent across repeated runs/crashes.
    4. A paused long upload cannot have its destination deleted by reconciliation.
    5. Backups/restores include any new durable reconciliation state and retain the existing live object.
14. **Scope / Non-Goals:** Do not make MinIO and PostgreSQL a distributed transaction, delete by object-ID prefix during request handling, pre-queue an immediately claimable live destination, or redesign object download/upload APIs. This note does not cover ordinary delete outbox behavior, which is already transactionally queued.
15. **Overlaps:** Finding 2 uses the same upload timing window but concerns a concurrent tombstone and resurrection. Finding 1 can erase the entire MinIO volume; this finding concerns unreachable keys inside an otherwise durable volume.
