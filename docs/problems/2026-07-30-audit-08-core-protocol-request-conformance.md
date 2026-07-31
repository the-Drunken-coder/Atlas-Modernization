# Core request acceptance drifts from the canonical Atlas Protocol

1. **Time & Date:** 2026-07-30T08:33:00Z
2. **Name:** Core request acceptance drifts from the canonical Atlas Protocol
3. **Issue:** Protocol validators and Core disagree about empty PATCH bodies, explicit nulls in non-nullable fields, and allowed initial task status.
4. **Severity:** **S3 (Moderate)** — generated clients can reject requests Core accepts or accept requests Core rejects.
5. **Location:** `atlas_protocol/schema/jsonschema/atlas.schema.json:301-338,1107-1143,1360-1422,1593-1626`, `atlas_core/internal/api/handlers/handler_requests.go`, `atlas_core/internal/actions/entity_actions.go:238-287`, `atlas_core/internal/actions/task_actions.go:222-280`, `atlas_core/internal/actions/object_actions.go:189-206`
6. **Expected:** Canonical validators and Core endpoints accept and reject the same wire bodies. Empty PATCH objects and explicit nulls for non-nullable fields are rejected; task-create status is constrained to `pending`; intentionally nullable entity alias/subtype and task entity ID still distinguish null from absence.
7. **Actual:** Schemas reject empty PATCH but Core treats it as a no-op. The schema accepts any non-empty task-create status while Core accepts only `pending`. Ordinary Go pointers/maps/slices collapse explicit null to absence and Core accepts several schema-invalid nulls. This was confirmed against `main` at `2426bb6`.
8. **Reproduction:**
   1. Protocol Go and TypeScript validators reject `{}` for all three PATCH types, accept task create with `status:"acknowledged"`, and reject `{"status":null}`.
   2. Core action paths accept `{}` as no-op, reject acknowledged task creation, and decode several explicit nulls to the same zero value as absence.
   3. Reuse canonical request validation at the HTTP boundary and add one conformance matrix covering entities, tasks, and objects, including intended nullable fields.
