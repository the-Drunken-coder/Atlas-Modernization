import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { type EntityKind, entityDisplayName, entityKind, isSelectableKind } from "./entities.js";
import type { AtlasSnapshot } from "./store.js";
import { sortTasksByRecency } from "./tasks.js";

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

/** All Tasks assigned to the Asset, most recent first. */
export function tasksForAsset(snapshot: AtlasSnapshot, assetId: string): TaskResource[] {
  return sortTasksByRecency(Object.values(snapshot.tasks).filter((task) => task.asset_id === assetId));
}

export function currentTask(snapshot: AtlasSnapshot, entity: EntityResource): TaskResource | undefined {
  return tasksForAsset(snapshot, entity.entity_id).find((task) => task.status === "in_progress");
}

export function queuedTasks(snapshot: AtlasSnapshot, entity: EntityResource): TaskResource[] {
  return tasksForAsset(snapshot, entity.entity_id).filter(
    (task) => task.status === "pending" || task.status === "acknowledged"
  );
}
