import type { EntityResource, FeedEvent, ObjectResource, TaskResource } from "../../src";

export type FakeLedgerState = {
  version: number;
  entities: Map<string, EntityResource>;
  tasks: Map<string, TaskResource>;
  objects: Map<string, ObjectResource>;
  objectExtras: Map<string, Record<string, unknown>>;
  deletions: FeedEvent[];
  events: FeedEvent[];
  recordedVersions: Set<number>;
};

export function recordLedgerEvent(state: FakeLedgerState, event: FeedEvent): void {
  if (state.recordedVersions.has(event.version)) {
    throw new Error(`duplicate fake core event version ${event.version} for ${event.resource_type}/${event.id}`);
  }
  state.recordedVersions.add(event.version);
  state.version = Math.max(state.version, event.version);
  state.events.push(event);
  if (event.event === "delete") {
    state.deletions.push(event);
    if (event.resource_type === "entity") state.entities.delete(event.id);
    if (event.resource_type === "task") state.tasks.delete(event.id);
    if (event.resource_type === "object") {
      state.objects.delete(event.id);
      state.objectExtras.delete(event.id);
    }
    return;
  }
  if (event.resource_type === "entity") state.entities.set(event.id, event.resource as EntityResource);
  if (event.resource_type === "task") state.tasks.set(event.id, event.resource as TaskResource);
  if (event.resource_type === "object") state.objects.set(event.id, event.resource as ObjectResource);
}

export function isEntityUpsert(event: FeedEvent): event is FeedEvent & { resource: EntityResource } {
  return event.event !== "delete" && event.resource_type === "entity";
}

export function isTaskUpsert(event: FeedEvent): event is FeedEvent & { resource: TaskResource } {
  return event.event !== "delete" && event.resource_type === "task";
}

export function isObjectUpsert(event: FeedEvent): event is FeedEvent & { resource: ObjectResource } {
  return event.event !== "delete" && event.resource_type === "object";
}

export function isDelete(type: "entity" | "task" | "object") {
  return (event: FeedEvent) => event.event === "delete" && event.resource_type === type;
}

export function deleted(event: FeedEvent) {
  const value: { id: string; type: string; version: number; entity_id?: string | null } = {
    id: event.id,
    type: event.resource_type,
    version: event.version
  };
  if ("entity_id" in event && event.entity_id != null) value.entity_id = event.entity_id;
  return value;
}
