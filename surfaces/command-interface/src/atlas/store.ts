import type { SyncSnapshot } from "@the-drunken-coder/atlas-sdk";

// A flat, immutable snapshot of the resources the console cares about. Object
// Object resources are tracked separately from the entity/task map projection.
export type AtlasSnapshot = Pick<SyncSnapshot, "entities" | "tasks">;

export function emptySnapshot(): AtlasSnapshot {
  return { entities: {}, tasks: {} };
}
