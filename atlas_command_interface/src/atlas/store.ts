import type { EntityResource, TaskResource } from "../../../atlas_sdk/src/index.js";

// A flat, immutable snapshot of the resources the console cares about. Object
// resources (including the command catalog) are tracked separately.
export type AtlasSnapshot = {
  readonly entities: Readonly<Record<string, EntityResource>>;
  readonly tasks: Readonly<Record<string, TaskResource>>;
};

export const emptySnapshot: AtlasSnapshot = { entities: {}, tasks: {} };
