import type { EntityResource, TaskResource } from "../../../atlas_sdk/src/index.js";

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
