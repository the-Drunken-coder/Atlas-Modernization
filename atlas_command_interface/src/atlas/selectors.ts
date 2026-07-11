import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { entityCurrentTaskId, entityDisplayName, entityKind, entityQueuedTaskIds, isSelectableKind, type EntityKind } from "./entities.js";
import { sortTasksByRecency } from "./tasks.js";
import type { AtlasSnapshot } from "./store.js";

export function getEntity(snapshot: AtlasSnapshot, id: string | undefined): EntityResource | undefined {
  return id ? snapshot.entities[id] : undefined;
}

export function getTask(snapshot: AtlasSnapshot, id: string | undefined): TaskResource | undefined {
  return id ? snapshot.tasks[id] : undefined;
}

/** Selectable entities (asset/track/geofeature) sorted by display name. */
export function listEntities(snapshot: AtlasSnapshot): EntityResource[] {
  return Object.values(snapshot.entities)
    .filter(isSelectableKind)
    .sort((a, b) => entityDisplayName(a).localeCompare(entityDisplayName(b)));
}

export function entitiesByKind(snapshot: AtlasSnapshot, kind: EntityKind): EntityResource[] {
  return listEntities(snapshot).filter((entity) => entityKind(entity) === kind);
}

export function countsByKind(snapshot: AtlasSnapshot): Record<EntityKind, number> {
  const counts: Record<EntityKind, number> = { asset: 0, track: 0, geofeature: 0 };
  for (const entity of Object.values(snapshot.entities)) {
    const kind = entityKind(entity);
    if (kind !== "other") counts[kind] += 1;
  }
  return counts;
}

/** All tasks targeting the entity, most recent first. */
export function tasksForEntity(snapshot: AtlasSnapshot, entityId: string): TaskResource[] {
  return sortTasksByRecency(Object.values(snapshot.tasks).filter((task) => task.entity_id === entityId));
}

export function currentTask(snapshot: AtlasSnapshot, entity: EntityResource): TaskResource | undefined {
  return getTask(snapshot, entityCurrentTaskId(entity));
}

export function queuedTasks(snapshot: AtlasSnapshot, entity: EntityResource): TaskResource[] {
  return entityQueuedTaskIds(entity)
    .map((id) => snapshot.tasks[id])
    .filter((task): task is TaskResource => task !== undefined);
}
