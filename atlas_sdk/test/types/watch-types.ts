import type { AtlasClient, EntityResource, ObjectResource, SyncSnapshot, TaskResource } from "../../src/index.js";

declare const client: AtlasClient;

client.watch({ filter: "all" }, (resource: EntityResource | TaskResource | ObjectResource | undefined) => resource);
client.watch(
  { filter: "id", resource_type: "entity", id: "entity-1" },
  (resource: EntityResource | undefined) => resource
);
client.watch({ filter: "type", resource_type: "task" }, (resource: TaskResource | undefined) => resource);
client.watch(
  { filter: "id", resource_type: "object", id: "object-1" },
  (resource: ObjectResource | undefined) => resource
);
client.watch({ filter: "tasks_for_entity", entity_id: "entity-1" }, (resource: TaskResource | undefined) => resource);
client.sync.watchSnapshot((snapshot: SyncSnapshot) => snapshot.entities);

// @ts-expect-error entity subscriptions cannot produce objects
client.watch({ filter: "type", resource_type: "entity" }, (resource: ObjectResource | undefined) => resource);
// @ts-expect-error tasks-for-entity subscriptions cannot produce entities
client.watch({ filter: "tasks_for_entity", entity_id: "entity-1" }, (resource: EntityResource | undefined) => resource);
