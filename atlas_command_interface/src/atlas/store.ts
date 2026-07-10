import type { SyncSnapshot } from "@the-drunken-coder/atlas-sdk";

// A flat, immutable snapshot of the resources the console cares about. Object
// resources (including the command catalog) are tracked separately.
export type AtlasSnapshot = Pick<SyncSnapshot, "entities" | "tasks">;

export function emptySnapshot(): AtlasSnapshot {
  return { entities: {}, tasks: {} };
}
