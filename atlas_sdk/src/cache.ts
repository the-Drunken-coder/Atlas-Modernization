import type { EntityResource, ObjectResource, ResourceType, TaskResource } from "./protocol.js";
import type { CacheEntry, ResourceOf, ResourceValue, SyncSnapshot } from "./types.js";
import { resourceCacheKey, resourceID } from "./subscriptions.js";

export type CacheResourceOptions = {
  detail?: boolean;
  advanceCursor?: boolean;
};

type SnapshotRecords = {
  [TType in ResourceType]: SnapshotRecord<ResourceOf<TType>>;
};

class SnapshotRecord<T> {
  private readonly entries = new Map<string, T>();
  private value: Readonly<Record<string, T>> = Object.freeze({});
  private dirty = false;

  set(id: string, value: T): void {
    this.entries.set(id, immutableClone(value));
    this.dirty = true;
  }

  remove(id: string): boolean {
    if (!this.entries.delete(id)) return false;
    this.dirty = true;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.dirty = true;
  }

  snapshot(): Readonly<Record<string, T>> {
    if (this.dirty) {
      this.value = Object.freeze(Object.fromEntries(this.entries));
      this.dirty = false;
    }
    return this.value;
  }
}

export class ObjectContentCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, ArrayBuffer>();

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: string): ArrayBuffer | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: ArrayBuffer): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
  }
}

export class ResourceCache {
  readonly entries: { [TType in ResourceType]: Map<string, CacheEntry<ResourceOf<TType>>> } = {
    entity: new Map<string, CacheEntry<EntityResource>>(),
    task: new Map<string, CacheEntry<TaskResource>>(),
    object: new Map<string, CacheEntry<ObjectResource>>()
  };
  readonly pendingDeletes = new Set<string>();
  readonly locallyNotifiedDeletes = new Set<string>();
  private readonly snapshotRecords: SnapshotRecords = {
    entity: new SnapshotRecord<EntityResource>(),
    task: new SnapshotRecord<TaskResource>(),
    object: new SnapshotRecord<ObjectResource>()
  };
  private snapshotValue = snapshotFromRecords(this.snapshotRecords);
  private snapshotDirty = false;
  lastVersion = 0;

  entry<TType extends ResourceType>(type: TType, id: string): CacheEntry<ResourceOf<TType>> | undefined {
    return this.entries[type].get(id);
  }

  value<TType extends ResourceType>(type: TType, id: string): ResourceOf<TType> | undefined {
    const entry = this.entry(type, id);
    return entry && !entry.deleted ? entry.value : undefined;
  }

  snapshot(): SyncSnapshot {
    if (this.snapshotDirty) {
      this.snapshotValue = snapshotFromRecords(this.snapshotRecords);
      this.snapshotDirty = false;
    }
    return this.snapshotValue;
  }

  replaceHydratedResources(
    resources: { entities: readonly EntityResource[]; tasks: readonly TaskResource[]; objects: readonly ObjectResource[] }
  ): void {
    this.entries.entity.clear();
    this.entries.task.clear();
    this.entries.object.clear();
    this.snapshotRecords.entity.clear();
    this.snapshotRecords.task.clear();
    this.snapshotRecords.object.clear();
    this.snapshotDirty = true;
    this.pendingDeletes.clear();
    this.locallyNotifiedDeletes.clear();
    this.lastVersion = 0;
    for (const entity of resources.entities) this.cacheResource("entity", entity.entity_id, entity, { advanceCursor: false });
    for (const task of resources.tasks) this.cacheResource("task", task.task_id, task, { advanceCursor: false });
    for (const object of resources.objects) this.cacheResource("object", object.object_id, object, { advanceCursor: false });
  }

  cacheResource<TType extends ResourceType>(type: TType, id: string, value: ResourceOf<TType>, options?: CacheResourceOptions): boolean {
    const actualID = resourceID(type, value);
    if (actualID !== id) {
      throw new TypeError(`Atlas ${type} resource id ${actualID} does not match cache id ${id}`);
    }
    const version = value.metadata.version;
    const existing = this.entries[type].get(id);
    const isDetailUpgrade = type === "object" && options?.detail === true && existing?.version === version && !existing.detail;
    if (existing && existing.version > version) {
      return false;
    }
    if (existing && existing.version === version && !isDetailUpgrade) {
      return false;
    }
    const key = resourceCacheKey(type, id);
    this.updateSnapshot(type, id, value);
    this.pendingDeletes.delete(key);
    this.locallyNotifiedDeletes.delete(key);
    this.entries[type].set(id, { value, version, deleted: false, detail: type === "object" && options?.detail === true });
    if (options?.advanceCursor !== false) {
      this.lastVersion = Math.max(this.lastVersion, version);
    }
    return true;
  }

  cacheWrittenResource<TType extends ResourceType>(type: TType, resource: ResourceOf<TType>): void {
    this.cacheResource(type, resourceID(type, resource), resource);
  }

  versionFor(type: ResourceType, id: string): number {
    return this.entries[type].get(id)?.version ?? 0;
  }

  markRemoteDelete(type: ResourceType, id: string, version: number): void {
    this.entries[type].set(id, { version, deleted: true });
    this.removeFromSnapshot(type, id);
  }

  markLocalDelete(type: ResourceType, id: string): { previousVersion: number; previous?: ResourceValue } {
    const previousEntry = this.entries[type].get(id);
    const previousVersion = previousEntry?.version ?? 0;
    const previous = previousEntry?.value;
    this.markRemoteDelete(type, id, previousVersion);
    const key = resourceCacheKey(type, id);
    this.pendingDeletes.add(key);
    this.locallyNotifiedDeletes.add(key);
    return { previousVersion, previous };
  }

  private updateSnapshot<TType extends ResourceType>(type: TType, id: string, value: ResourceOf<TType>): void {
    this.snapshotRecords[type].set(id, value);
    this.snapshotDirty = true;
  }

  private removeFromSnapshot<TType extends ResourceType>(type: TType, id: string): void {
    if (this.snapshotRecords[type].remove(id)) this.snapshotDirty = true;
  }
}

function snapshotFromRecords(records: SnapshotRecords): SyncSnapshot {
  return Object.freeze({ entities: records.entity.snapshot(), tasks: records.task.snapshot(), objects: records.object.snapshot() });
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
