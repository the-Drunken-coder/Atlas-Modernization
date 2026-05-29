# Problem

1. **Time & Date:** 2026-05-29T00:00:00Z
2. **Name:** List endpoints use OFFSET pagination + `COUNT(*) OVER()` per request
3. **Issue:** `GET /entities`, `/tasks`, `/objects` paginate with `LIMIT/OFFSET` and compute the total via a `COUNT(*) OVER()` window on every query. Deep offsets scan and discard all preceding rows, and the window count re-counts the matching set on each page. Both degrade linearly with table size, diverging from the keyset/cursor pattern already used by the sync endpoints (`/queries/full`, `/queries/changed-since`).
4. **Severity:** S5 (Note) — no current impact (greenfield, no data); rises to S3 once tables grow.
5. **Location:** `Atlas_Core/internal/actions/entity_actions.go` (`List`, ~L330–369), `Atlas_Core/internal/actions/task_actions.go`, `Atlas_Core/internal/actions/object_actions.go`, `Atlas_Core/internal/api/handlers/handler_http.go` (`parseListPagination`, `setPaginationHeaders`)
6. **Expected:** List reads stay roughly constant-time as the table grows, ideally reusing the keyset-cursor approach in `query_actions.go` / `query_cursor.go`.
7. **Actual:** Cost grows with `offset` (rows skipped) and with table size (`COUNT(*) OVER()` re-counts every page).
8. **Reproduction:**
   1. Seed a large number of entities.
   2. Request `GET /entities?limit=100&offset=<large>` and observe latency growth vs a small offset.
   3. Compare query plans against the keyset queries in `query_actions.go`.
9. **Notes:** Two competing pagination paradigms in one codebase. Options: migrate list endpoints to keyset cursors (preferred — unifies on one model), or keep offset but drop the per-request window count in favor of a cheaper/cached count or an estimate. See `Atlas_Core/docs/PAGINATION.md`.
