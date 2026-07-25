# Memory Leak Notes

_Revision: 2026-02-13_

## Scope Clarification

This repository now runs Atlas Core as a Go service (`cmd/atlas_core`, `internal/...`).
The Python file paths previously documented in this file no longer exist in the active server
implementation.

## Current Go-Service Resource Safety

The active codebase includes the following resource-management safeguards:

- DB pool lifecycle:
  - pool configured in `internal/database/db.go`
  - pool closed during shutdown in `cmd/atlas_core/main.go`
- Upload file handles are explicitly closed in `UploadObject` (`handler_object_transfer.go`).
- Storage stream readers are closed with `defer reader.Close()` in download/view handlers (`handler_object_transfer.go`).
- Request body size limits are enforced to prevent unbounded memory growth on large payloads.

## If Investigating New Memory Growth

Use this checklist for the current Go implementation:

1. Verify DB pool settings (`DATABASE_POOL_SIZE`, `DATABASE_POOL_RECYCLE`,
   `DATABASE_POOL_TIMEOUT`, `DATABASE_POOL_IDLE_TIMEOUT`, `DATABASE_POOL_PRE_PING`).
2. Confirm no unusually high concurrency on large object uploads/views.
3. Check that clients are not repeatedly requesting `GET /queries/full` at high frequency.
4. Review logs for repeated storage or multipart parse failures.

## Historical Context

Prior Python-era leak investigations are retained in git history, but are intentionally not treated
as implementation guidance for the current Go server.
