import type { SyncSnapshot } from "../../../atlas_sdk/src/index.js";

// A flat, immutable snapshot of the resources the console cares about. Object
// resources (including the command catalog) are tracked separately.
export type AtlasSnapshot = Pick<SyncSnapshot, "entities" | "tasks">;

export const emptySnapshot: AtlasSnapshot = { entities: {}, tasks: {} };
