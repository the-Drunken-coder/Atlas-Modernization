# Design Decision

1. **Time & Date:** 2026-05-29T06:05:00Z
2. **Name:** Treat object references as historical investigation context
3. **Context:** Objects can record entity or task relationships in their JSON `referenced_by` field. These references are not modeled as database foreign keys, so deleting an entity does not automatically remove the object's reference to that entity. This initially looked like a referential-integrity problem, but objects may remain useful evidence or investigation artifacts even when the related entity no longer exists.
4. **Decision:** Keep object `referenced_by` entries as historical references. Do not automatically clear object references when an entity is deleted, and do not require object-to-entity references to become foreign-key-backed relationships at this stage.
5. **Alternatives considered:** Clear object `referenced_by` entries on entity deletion; rejected because it would erase useful investigation context. Move object references into a normalized join table with foreign keys; rejected for now because it would make object references behave like live ownership links rather than historical associations. Cascade-delete related objects; rejected because objects can remain independently useful after the entity is gone.
6. **Consequences:** Objects may intentionally contain references to deleted or otherwise unavailable entities. Consumers should treat `referenced_by` as historical/associative metadata, not as proof that the referenced entity currently exists. If a UI needs to display these relationships, it should handle missing entities gracefully.
7. **Location:** `Atlas_Core/internal/database/db.go` (`objects` table), `Atlas_Core/internal/actions/objectactions/references.go` (`referenced_by` handling), `Atlas_Core/internal/actions/entityactions/entityactions.go` (`Delete`)
8. **Notes:** This supersedes the transient problem note about object references lacking a foreign key to entities.
