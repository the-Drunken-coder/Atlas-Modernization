import type { SyncSnapshot } from "@the-drunken-coder/atlas-sdk";

// A flat, immutable snapshot of the resources the console cares about. Object
// Object resources are tracked separately from the entity/task map projection.
export type AtlasSnapshot = Pick<SyncSnapshot, "entities" | "tasks"> & {
  // The SDK feed reports runtime-manifest changes separately from ordinary
  // Entity updates. Values are the corresponding global feed versions.
  runtimeManifestVersions?: Readonly<Record<string, number>>;
};

export function emptySnapshot(): AtlasSnapshot {
  return { entities: {}, tasks: {} };
}
