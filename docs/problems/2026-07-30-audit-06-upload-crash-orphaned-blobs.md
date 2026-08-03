# Object upload crash windows can leave untracked blobs

1. **Time & Date:** 2026-08-03T06:07:56Z (revalidated; originally recorded 2026-07-30)
2. **Name:** Object upload crash windows can leave untracked blobs
3. **Issue:** A crash between object-store mutation and database bookkeeping can leave a versioned blob with neither live metadata nor a deletion-outbox row; a replacement crash can leave the superseded blob unqueued.
4. **Severity:** **S2 (Major)** — durable storage can accumulate unreachable data with no built-in detection or recovery path.
5. **Location:** `atlas_core/internal/actions/object_upload.go`, `atlas_core/internal/actions/object_storage_deletions.go`, `atlas_core/internal/storage/storage.go`, `atlas_core/cmd/atlas_core/main.go`
6. **Expected:** Uploads create a durable lease/intent containing owner and expiry before writing the destination. Reconciliation waits through an explicit grace period, operates only on expired intents while the owner is absent or uploads are quiesced, and rechecks both live metadata and lease state immediately before deletion. Superseded paths are queued in the same transaction that makes them unreachable.
7. **Actual:** The destination still exists only in memory until after the MinIO write and metadata transaction. Process death bypasses failure cleanup. A replaced old path is queued only after commit. The reconciler sees only existing deletion-outbox rows and cannot discover these unrecorded paths. This was revalidated by static crash-window proof against `main` at `f4b0187fdb68088ea0b59d28218d02204f4cfc9c`.
8. **Reproduction:**
   1. Terminate after `PutObject` succeeds but before the metadata transaction begins or commits; the new blob has no database record.
   2. For replacement, terminate after metadata commit but before old-path cleanup; the old blob is unreachable and unqueued.
   3. Existing `TestCleanupUploadedPathAfterFailure*` tests cover handled errors, not process termination.
   4. Add failpoint/process-kill tests for each window, plus a paused long upload proving reconciliation cannot delete an active destination; verify restart cleanup is idempotent and rechecks references immediately before delete.
