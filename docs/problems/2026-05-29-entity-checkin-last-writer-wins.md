# Problem

1. **Time & Date:** 2026-05-29T00:00:00Z
2. **Name:** `EntityCheckin` component merge has no optimistic-concurrency guard
3. **Issue:** `POST /entities/{entity_id}/checkin` (and `PATCH .../telemetry`) merge status/telemetry/heartbeat into the entity JSON via `EntityActions.Update`, which is row-locked (`SELECT ... FOR UPDATE`) and therefore not corrupting — but it offers no `If-Match`/optimistic concurrency, so concurrent check-ins are last-writer-wins per field. Objects, by contrast, *do* support `If-Match`. The asymmetry is probably fine for high-frequency telemetry, but it's currently implicit rather than a recorded decision.
4. **Severity:** S5 (Note) — no data corruption (writes are serialized by the row lock); only a lost-update-style overwrite of concurrent component edits.
5. **Location:** `Atlas_Core/internal/api/handlers/handler_entity.go` (`EntityCheckin`, `UpdateEntityTelemetry`), `Atlas_Core/internal/actions/entity_actions.go` (`Update`), compare `Atlas_Core/internal/actions/ifmatch.go` (object path)
6. **Expected:** A conscious, documented choice: either accept last-writer-wins for check-in/telemetry (and say so), or offer optional `If-Match` like objects.
7. **Actual:** Concurrency behavior for entity component merges is undocumented and differs from objects without a stated rationale.
8. **Reproduction:**
   1. Issue two concurrent `POST /entities/{id}/checkin` with different `components.status`.
   2. Observe the later commit's value wins with no conflict signal.
9. **Notes:** If last-writer-wins is intended for telemetry/heartbeat (likely), capture it as a short decision under `docs/design-decisions/` so the asymmetry with object `If-Match` is explicit. See `Atlas_Core/docs/ASSET_STATUS_SYSTEM.md`.
