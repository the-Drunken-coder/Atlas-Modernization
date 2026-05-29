# Problem

1. **Time & Date:** 2026-05-29T00:00:00Z
2. **Name:** `EntityResponse` exposes both `entity_type` and `type` with identical values
3. **Issue:** `EntityResponse` serializes the entity's type twice — `EntityType` (`json:"entity_type"`) and `Type` (`json:"type"`) — both set from `e.Type`. This is a backwards-compatibility artifact; with no external callers to preserve (see `AGENTS.md`), the duplication should collapse to a single field. (Consolidates the two review bullets — "both entity_type and type" and "compatibility artifact" — into one finding, since they describe the same redundancy.)
4. **Severity:** S4 (Minor) — API surface cleanliness; harmless but confusing and a drift risk.
5. **Location:** `Atlas_Core/internal/serializers/serializers.go` (`EntityResponse`, `SerializeEntity`, ~L21–98)
6. **Expected:** The entity type appears once in the response under a single agreed key.
7. **Actual:** Both `entity_type` and `type` are emitted with the same value, so consumers can't tell which is canonical.
8. **Reproduction:**
   1. `GET /entities/{entity_id}` and inspect the JSON — both `entity_type` and `type` are present and equal.
9. **Notes:** Pick the canonical key (the request body uses `entity_type` on create/update; responses currently emit both). Remove the other field and update docs/examples and any frontend reads. `AGENTS.md` explicitly permits breaking changes in this phase. Check `Atlas_Core/docs/database-structure/entities.md` and the example JSON for the same duplication.
