import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { ENTITY_KINDS, type EntityKind, entityDisplayName, entityKind, isSelectableKind } from "./entities.js";
import type { AtlasSnapshot } from "./store.js";
import { sortTasksByRecency, sortTasksByTaskingOrder } from "./tasks.js";

export function getEntity(snapshot: AtlasSnapshot, id: string | undefined): EntityResource | undefined {
  return id ? snapshot.entities[id] : undefined;
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
  const counts = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, 0])) as Record<EntityKind, number>;
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

export function activeTasks(snapshot: AtlasSnapshot, entity: EntityResource): TaskResource[] {
  return sortTasksByTaskingOrder(
    Object.values(snapshot.tasks).filter((task) => task.asset_id === entity.entity_id && task.status === "in_progress")
  );
}

export function queuedTasks(snapshot: AtlasSnapshot, entity: EntityResource): TaskResource[] {
  return sortTasksByTaskingOrder(
    Object.values(snapshot.tasks).filter(
      (task) => task.asset_id === entity.entity_id && (task.status === "pending" || task.status === "acknowledged")
    )
  );
}
