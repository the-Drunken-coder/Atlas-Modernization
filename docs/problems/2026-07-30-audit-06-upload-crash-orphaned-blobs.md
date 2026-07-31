# Object upload crash windows can leave untracked blobs

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Object upload crash windows can leave untracked blobs
3. **Issue:** A crash between object-store mutation and database bookkeeping can leave a versioned blob with neither live metadata nor a deletion-outbox row; a replacement crash can leave the superseded blob unqueued.
4. **Severity:** **S2 (Major)** — durable storage can accumulate unreachable data with no built-in detection or recovery path.
5. **Location:** `atlas_core/internal/actions/object_upload.go:134-160,185-261`, `atlas_core/internal/actions/object_storage_deletions.go:22-39,66-103,153-273`, `atlas_core/internal/storage/storage.go:171-207`, `atlas_core/cmd/atlas_core/main.go:43-61,193-202`
6. **Expected:** Uploads create a durable lease/intent containing owner and expiry before writing the destination. Reconciliation waits through an explicit grace period, operates only on expired intents while the owner is absent or uploads are quiesced, and rechecks both live metadata and lease state immediately before deletion. Superseded paths are queued in the same transaction that makes them unreachable.
7. **Actual:** The destination exists only in memory until after the MinIO write and metadata transaction. Process death bypasses failure cleanup. A replaced old path is queued only after commit. The current reconciler sees only existing deletion-outbox rows and cannot discover these unrecorded paths. This was confirmed by static crash-window proof against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`.
8. **Reproduction:**
   1. Terminate after `PutObject` succeeds but before the metadata transaction begins or commits; the new blob has no database record.
   2. For replacement, terminate after metadata commit but before old-path cleanup; the old blob is unreachable and unqueued.
   3. Existing `TestCleanupUploadedPathAfterFailure*` tests cover handled errors, not process termination.
   4. Add failpoint/process-kill tests for each window, plus a paused long upload proving reconciliation cannot delete an active destination; verify restart cleanup is idempotent and rechecks references immediately before delete.
