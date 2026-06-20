import type { EntityResource, ObjectResource, ResourceType, TaskResource } from "./protocol.js";
import type { CacheEntry, ResourceValue } from "./types.js";
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
  readonly entries = {
    entity: new Map<string, CacheEntry<EntityResource>>(),
    task: new Map<string, CacheEntry<TaskResource>>(),
    object: new Map<string, CacheEntry<ObjectResource>>()
  };
  readonly pendingDeletes = new Set<string>();
  readonly locallyNotifiedDeletes = new Set<string>();
  lastVersion = 0;

  entry<T extends ResourceValue>(type: ResourceType, id: string): CacheEntry<T> | undefined {
    return this.entries[type].get(id) as CacheEntry<T> | undefined;
  }

  value<T extends ResourceValue>(type: ResourceType, id: string): T | undefined {
    const entry = this.entry<T>(type, id);
    return entry && !entry.deleted ? entry.value : undefined;
  }

  values<T extends ResourceValue>(type: ResourceType): T[] {
    const values: T[] = [];
    for (const entry of this.entries[type].values()) {
      if (!entry.deleted && entry.value) {
        values.push(entry.value as T);
      }
    }
    return values;
  }

  cacheResource(type: ResourceType, id: string, value: ResourceValue, options?: CacheResourceOptions): boolean {
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
    this.entries[type].set(id, { value: value as any, version, deleted: false, detail: type === "object" && options?.detail === true });
    if (options?.advanceCursor !== false) {
      this.lastVersion = Math.max(this.lastVersion, version);
    }
    return true;
  }

  cacheWrittenResource(type: ResourceType, resource: ResourceValue): void {
    this.cacheResource(type, resourceID(type, resource), resource);
  }

  versionFor(type: ResourceType, id: string): number {
    return this.entries[type].get(id)?.version ?? 0;
  }

  markLocalDelete(type: ResourceType, id: string): { previousVersion: number; previous?: ResourceValue } {
    const previousEntry = this.entries[type].get(id);
    const previousVersion = previousEntry?.version ?? 0;
    const previous = previousEntry?.value;
    this.entries[type].set(id, { version: previousVersion, deleted: true });
    const key = resourceCacheKey(type, id);
    this.pendingDeletes.add(key);
    this.locallyNotifiedDeletes.add(key);
    return { previousVersion, previous };
  }
}
