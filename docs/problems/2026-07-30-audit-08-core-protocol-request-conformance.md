# Core request acceptance drifts from the canonical Atlas Protocol

1. **Time & Date:** 2026-08-03T06:07:56Z (revalidated and narrowed; originally recorded 2026-07-30)
2. **Name:** Core request acceptance drifts from the canonical Atlas Protocol
3. **Issue:** Protocol validators and Core disagree about empty PATCH bodies, explicit nulls in non-nullable fields, and allowed initial task status.
4. **Severity:** **S3 (Moderate)** — generated clients can reject requests Core accepts or accept requests Core rejects.
5. **Location:** `atlas_protocol/schema/jsonschema/atlas.schema.json`, `atlas_core/internal/api/handlers/handler_requests.go`, `atlas_core/internal/actions/entity_actions.go`, `atlas_core/internal/actions/task_actions.go`, `atlas_core/internal/actions/object_actions.go`
6. **Expected:** Canonical validators and Core endpoints accept and reject the same wire bodies. Empty PATCH objects and explicit nulls for non-nullable fields are rejected; task-create status is constrained to `pending`; intentionally nullable entity alias/subtype and task entity ID still distinguish null from absence.
7. **Actual:** Schemas reject empty PATCH while Core still treats it as a no-op. The schema accepts any non-empty task-create status while Core accepts only `pending`. Core now distinguishes null from absence for intentionally nullable entity alias/subtype and task entity ID fields, but ordinary pointers, maps, and slices still collapse explicit null for non-nullable fields and accept several schema-invalid bodies. This narrower mismatch was revalidated against `main` at `f4b0187fdb68088ea0b59d28218d02204f4cfc9c`.
8. **Reproduction:**
   1. Protocol Go and TypeScript validators reject `{}` for all three PATCH types, accept task create with `status:"acknowledged"`, and reject `{"status":null}`.
   2. Core action paths accept `{}` as a no-op, reject acknowledged task creation, and decode several explicit nulls for non-nullable fields to the same zero value as absence. The custom `nullablePatchString` path correctly preserves null for the intentionally nullable fields.
   3. Reuse canonical request validation at the HTTP boundary and add one conformance matrix covering entities, tasks, and objects, including intended nullable fields.
