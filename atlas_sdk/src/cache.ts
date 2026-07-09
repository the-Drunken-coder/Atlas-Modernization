import type { EntityResource, ObjectResource, ResourceType, TaskResource } from "./protocol.js";
import type { CacheEntry, ResourceOf, ResourceValue, SyncSnapshot } from "./types.js";
import { resourceCacheKey, resourceID } from "./subscriptions.js";

export type CacheResourceOptions = {
  detail?: boolean;
  advanceCursor?: boolean;
};

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
  lastVersion = 0;

  entry<TType extends ResourceType>(type: TType, id: string): CacheEntry<ResourceOf<TType>> | undefined {
    return this.entries[type].get(id);
  }

  value<TType extends ResourceType>(type: TType, id: string): ResourceOf<TType> | undefined {
    const entry = this.entry(type, id);
    return entry && !entry.deleted ? entry.value : undefined;
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

  snapshot(): SyncSnapshot {
    const entities: Record<string, EntityResource> = {};
    const tasks: Record<string, TaskResource> = {};
    const objects: Record<string, ObjectResource> = {};
    for (const [id, entry] of this.entries.entity) {
      if (!entry.deleted && entry.value) entities[id] = entry.value;
    }
    for (const [id, entry] of this.entries.task) {
      if (!entry.deleted && entry.value) tasks[id] = entry.value;
    }
    for (const [id, entry] of this.entries.object) {
      if (!entry.deleted && entry.value) objects[id] = entry.value;
    }
    return { entities, tasks, objects };
  }

  markRemoteDelete(type: ResourceType, id: string, version: number): void {
    this.entries[type].set(id, { version, deleted: true });
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
}
