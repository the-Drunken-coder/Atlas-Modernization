import type { AtlasWatchEvent, EntityResource, TaskResource } from "../../../atlas_sdk/src/index.js";

// A flat, immutable snapshot of the resources the console cares about. Object
// resources (including the command catalog) are tracked separately.
export type AtlasSnapshot = {
  entities: Record<string, EntityResource>;
  tasks: Record<string, TaskResource>;
};

export function emptySnapshot(): AtlasSnapshot {
  return { entities: {}, tasks: {} };
}

export function snapshotFromDataset(entities: EntityResource[], tasks: TaskResource[]): AtlasSnapshot {
  return {
    entities: Object.fromEntries(entities.map((entity) => [entity.entity_id, entity])),
    tasks: Object.fromEntries(tasks.map((task) => [task.task_id, task]))
  };
}

/**
 * Apply one feed/recovery/local-delete event to the snapshot. Returns the same
 * reference when nothing relevant changed so React can skip re-renders.
 */
export function applyWatchEvent(snapshot: AtlasSnapshot, event: AtlasWatchEvent): AtlasSnapshot {
  if (event.resource_type !== "entity" && event.resource_type !== "task") {
    return snapshot;
  }

  if (event.event === "create" || event.event === "update" || event.event === "recovered") {
    const resource = "resource" in event ? event.resource : undefined;
    if (!resource) return snapshot;
    if (event.resource_type === "entity") {
      if (snapshot.entities[event.id]?.metadata.version >= resource.metadata.version) return snapshot;
      return { ...snapshot, entities: { ...snapshot.entities, [event.id]: resource as EntityResource } };
    }
    if (snapshot.tasks[event.id]?.metadata.version >= resource.metadata.version) return snapshot;
    return { ...snapshot, tasks: { ...snapshot.tasks, [event.id]: resource as TaskResource } };
  }

  if (event.event === "delete" || event.event === "local_delete") {
    if (event.resource_type === "entity") {
      const current = snapshot.entities[event.id];
      if (!current) return snapshot;
      if (event.event === "delete" && !isFreshDelete(current.metadata.version, event.version)) return snapshot;
      const entities = { ...snapshot.entities };
      delete entities[event.id];
      return { ...snapshot, entities };
    }
    const current = snapshot.tasks[event.id];
    if (!current) return snapshot;
    if (event.event === "delete" && !isFreshDelete(current.metadata.version, event.version)) return snapshot;
    const tasks = { ...snapshot.tasks };
    delete tasks[event.id];
    return { ...snapshot, tasks };
  }

  return snapshot;
}

function isFreshDelete(currentVersion: number, eventVersion: number): boolean {
  return Number.isFinite(eventVersion) && eventVersion > currentVersion;
}
