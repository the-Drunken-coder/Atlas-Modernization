# Design Decision

1. **Time & Date:** 2026-06-09T00:00:00Z
2. **Name:** Resource writes use serialized row changes plus optional strong ETag preconditions
3. **Context:** Entity telemetry/check-in writes were historically serialized by row locks but offered no optimistic-concurrency signal, while objects accepted `If-Match`. That made the model asymmetric and left last-writer-wins behavior implicit for entity component merges.
4. **Decision:** Entity, task, and object update paths all accept optional strong `If-Match` headers backed by the resource `version`. Handlers parse ETag strings, actions compare only the expected version against the row version after locking the row, and a mismatch returns `412 Precondition Failed`. Requests without `If-Match` keep the greenfield service's normal last-writer-wins behavior after row serialization.
5. **Alternatives considered:** Keep entity/task writes purely last-writer-wins; rejected because clients that sync through versions need a uniform conflict-avoidance primitive. Compare string ETags inside actions; rejected because HTTP representation details belong in handlers, not the action layer.
6. **Consequences:**
   - High-frequency telemetry and check-in clients can omit `If-Match` when overwrites are acceptable.
   - Clients that edit read-modify-write resource blobs can send the last observed strong ETag and receive a deterministic `412` on stale writes.
   - The action layer remains reusable by comparing versions, not HTTP header strings.
7. **Location:** `Atlas_Core/internal/api/handlers/handler_http.go`, `Atlas_Core/internal/actions/ifmatch.go`, `Atlas_Core/internal/actions/entityactions/update.go`, `Atlas_Core/internal/actions/taskactions/update.go`, `Atlas_Core/internal/actions/objectactions/update.go`, `Atlas_Core/internal/serializers/serializers.go`

(End of file)
