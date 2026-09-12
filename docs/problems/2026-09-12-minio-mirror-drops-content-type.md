1. **Time & Date:** 2026-09-12T23:38:45Z
2. **Name:** Filesystem MinIO mirror restore drops Object content type
3. **Issue:** The documented paired backup mirrors the MinIO bucket to a filesystem and later mirrors it back. That round trip preserves Object bytes but drops the S3 `Content-Type` metadata used by Core's download response, so a restored Object no longer downloads with its original media type even though its PostgreSQL representation still reports the original `content_type`.
4. **Severity:** S2 (Major)
5. **Location:** `services/core/docs/DEPLOYMENT_RUNBOOK.md:229-240,329-349`; `services/core/internal/storage/storage.go:238-245`; `services/core/internal/actions/object_actions.go:446-451`; `services/core/internal/api/handlers/handler_object_transfer.go:32-40`
6. **Expected:** After a documented paired restore, `GET /objects/:id`, the downloaded bytes, and the download `Content-Type` all match the pre-backup snapshot. The acceptance object was uploaded as `application/vnd.atlas.migration-restore`.
7. **Actual:** On clean revision `17c898372c248c8ae6f027a4ed05fc1ce912ea67`, the restored Object JSON still reported `application/vnd.atlas.migration-restore` and the 65-byte payload retained SHA-256 `eedc4c5b5e66c76cdfd3694de35d988d32756f34e8026c557c2896e9a10bf4b8`, but the download header became `application/octet-stream`. The `mc diff` used by the documented restore did not report the metadata loss.
8. **Reproduction:**
   1. Use Node 24 and a running Docker engine.
   2. Run `node tests/acceptance/migration-restore/run.mjs` from revision `17c898372c248c8ae6f027a4ed05fc1ce912ea67`.
   3. Observe failure at `after paired restore: Object bytes and content type match the pre-backup snapshot`.
9. **Notes:** Exact artifacts are `/private/tmp/atlas-test-378/.atlas/acceptance/migration-restore/20260912T233752Z-fdfc18c4-e1f6-4b06-a691-c1d6ca208b16`. The independent observer passed in 35,032 ms with six public operations overlapping the validated 1,573 ms restore interval. The primary run failed in 55,103 ms and its cleanup record shows zero remaining owned containers, volumes, or networks and removal of the owned image.
