import {
  type EntityResource,
  isObjectDetailResource,
  type ObjectDetailResource,
  type ObjectResource,
  type ResourceType,
  type TaskResource
} from "./protocol.js";
import { resourceCacheKey, resourceID } from "./subscriptions.js";
import type { CacheEntry, DeletableResourceType, ResourceOf, ResourceValue, SyncSnapshot } from "./types.js";

export type CacheResourceOptions = {
  detail?: boolean;
  advanceCursor?: boolean;
  generation?: number;
  version?: number;
  replaceSameVersion?: boolean;
};

type SnapshotRecords = {
  [TType in ResourceType]: SnapshotRecord<ResourceOf<TType>>;
};

type LocalDeleteOperation = {
  readonly type: DeletableResourceType;
  readonly id: string;
  readonly observedEntry: CacheEntry<ResourceOf<DeletableResourceType>> | undefined;
  remoteDeleteSeen: boolean;
};

class SnapshotRecord<T> {
  private readonly entries = new Map<string, T>();
  private value: Readonly<Record<string, T>> = Object.freeze({});
  private dirty = false;

  set(id: string, value: T): void {
    this.entries.set(id, value);
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
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("objectContentCacheEntries must be a positive safe integer");
    }
    this.maxEntries = maxEntries;
  }

  get(key: string): ArrayBuffer | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    return value.slice(0);
  }

  set(key: string, value: ArrayBuffer): void {
    this.entries.delete(key);
    this.entries.set(key, value.slice(0));
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
  private readonly localDeleteOperations = new Set<LocalDeleteOperation>();
  // Point reads capture this generation before the request and only project the response if it is still current.
  private readonly generations = new Map<string, number>();
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

  objectDetail(id: string): ObjectDetailResource | undefined {
    const entry = this.entries.object.get(id);
    return entry?.detail && entry.value && !entry.deleted && isObjectDetailResource(entry.value)
      ? entry.value
      : undefined;
  }

  snapshot(): SyncSnapshot {
    if (this.snapshotDirty) {
      this.snapshotValue = snapshotFromRecords(this.snapshotRecords);
      this.snapshotDirty = false;
    }
    return this.snapshotValue;
  }

  replaceHydratedResources(resources: {
    entities: readonly EntityResource[];
    tasks: readonly TaskResource[];
    objects: readonly ObjectDetailResource[];
  }): void {
    this.entries.entity.clear();
    this.entries.task.clear();
    this.entries.object.clear();
    this.snapshotRecords.entity.clear();
    this.snapshotRecords.task.clear();
    this.snapshotRecords.object.clear();
    this.snapshotDirty = true;
    this.pendingDeletes.clear();
    this.locallyNotifiedDeletes.clear();
    this.localDeleteOperations.clear();
    this.lastVersion = 0;
    for (const entity of resources.entities)
      this.cacheResource("entity", entity.entity_id, entity, { advanceCursor: false });
    for (const task of resources.tasks) this.cacheResource("task", task.task_id, task, { advanceCursor: false });
    for (const object of resources.objects)
      this.cacheResource("object", object.object_id, object, { detail: true, advanceCursor: false });
  }

  cacheResource<TType extends ResourceType>(
    type: TType,
    id: string,
    value: ResourceOf<TType>,
    options?: CacheResourceOptions
  ): boolean {
    const actualID = resourceID(type, value);
    if (actualID !== id) {
      throw new TypeError(`Atlas ${type} resource id ${actualID} does not match cache id ${id}`);
    }
    if (options?.generation !== undefined) {
      if (this.generation(type, id) !== options.generation) return false;
      // A point read that starts after a local delete has begun must not make
      // the deleted resource visible again before that delete finishes. A
      // different instance is allowed through so a concurrent recreation is
      // preserved by finishLocalDelete.
      if (
        [...this.localDeleteOperations].some(
          (operation) =>
            operation.type === type &&
            operation.id === id &&
            (operation.observedEntry === undefined || sameResourceInstance(operation.observedEntry.value, value))
        )
      ) {
        return false;
      }
    }
    const version = options?.version ?? embeddedResourceVersion(type, value);
    const existing = this.entries[type].get(id);
    const isDetailUpgrade =
      type === "object" && options?.detail === true && existing?.version === version && existing.detail !== true;
    if (existing && existing.version > version) {
      return false;
    }
    if (existing && existing.version === version && !isDetailUpgrade && options?.replaceSameVersion !== true) {
      return false;
    }
    const immutableValue = immutableClone(value);
    const key = resourceCacheKey(type, id);
    this.updateSnapshot(type, id, immutableValue);
    this.pendingDeletes.delete(key);
    this.locallyNotifiedDeletes.delete(key);
    this.entries[type].set(id, {
      value: immutableValue,
      version,
      deleted: false,
      detail: type === "object" && options?.detail === true
    });
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

  generation(type: ResourceType, id: string): number {
    return this.generations.get(resourceCacheKey(type, id)) ?? 0;
  }

  markRemoteDelete(type: ResourceType, id: string, version: number): void {
    this.bumpGeneration(type, id);
    for (const operation of this.localDeleteOperations) {
      if (operation.type === type && operation.id === id) operation.remoteDeleteSeen = true;
    }
    this.entries[type].set(id, { version, deleted: true });
    this.removeFromSnapshot(type, id);
  }

  markLocalDelete(type: DeletableResourceType, id: string): number {
    const previousEntry = this.entries[type].get(id);
    const previousVersion = previousEntry?.version ?? 0;
    this.markRemoteDelete(type, id, previousVersion);
    const key = resourceCacheKey(type, id);
    this.pendingDeletes.add(key);
    this.locallyNotifiedDeletes.add(key);
    return previousVersion;
  }

  beginLocalDelete(type: DeletableResourceType, id: string): LocalDeleteOperation {
    this.bumpGeneration(type, id);
    const operation = { type, id, observedEntry: this.entries[type].get(id), remoteDeleteSeen: false };
    this.localDeleteOperations.add(operation);
    return operation;
  }

  finishLocalDelete(operation: LocalDeleteOperation): number | undefined {
    if (!this.localDeleteOperations.delete(operation)) return undefined;
    const currentEntry = this.entries[operation.type].get(operation.id);
    this.bumpGeneration(operation.type, operation.id);
    if (
      currentEntry !== operation.observedEntry &&
      (operation.remoteDeleteSeen || !sameResourceInstance(operation.observedEntry?.value, currentEntry?.value))
    ) {
      return undefined;
    }
    return this.markLocalDelete(operation.type, operation.id);
  }

  cancelLocalDelete(operation: LocalDeleteOperation): void {
    this.localDeleteOperations.delete(operation);
  }

  private bumpGeneration(type: ResourceType, id: string): void {
    const key = resourceCacheKey(type, id);
    this.generations.set(key, this.generation(type, id) + 1);
  }

  private updateSnapshot<TType extends ResourceType>(type: TType, id: string, value: ResourceOf<TType>): void {
    this.snapshotRecords[type].set(id, value);
    this.snapshotDirty = true;
  }

  private removeFromSnapshot<TType extends ResourceType>(type: TType, id: string): void {
    if (this.snapshotRecords[type].remove(id)) this.snapshotDirty = true;
  }
}

function sameResourceInstance(
  observed: ResourceOf<DeletableResourceType> | undefined,
  current: ResourceValue | undefined
): boolean {
  // Core keeps metadata.created_at stable across updates and changes it when an ID is reused.
  if (!observed || !current || !("metadata" in current)) return false;
  return observed.metadata.created_at === current.metadata.created_at;
}

function embeddedResourceVersion<TType extends ResourceType>(type: TType, value: ResourceOf<TType>): number {
  if (type === "task" || !("metadata" in value)) return 0;
  return value.metadata.version;
}

function snapshotFromRecords(records: SnapshotRecords): SyncSnapshot {
  return Object.freeze({
    entities: records.entity.snapshot(),
    tasks: records.task.snapshot(),
    objects: records.object.snapshot()
  });
}

function immutableClone<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const root: object = Array.isArray(value) ? [] : {};
  const clones = new Map<object, object>([[value, root]]);
  const work: Array<{ source: object; target: object }> = [{ source: value, target: root }];
  while (work.length > 0) {
    const { source, target } = work.pop()!;
    for (const [key, child] of Object.entries(source)) {
      if (typeof child === "function" || typeof child === "symbol") {
        throw new TypeError("Atlas cache values must be structured-cloneable");
      }
      if (typeof child !== "object" || child === null) {
        Object.defineProperty(target, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true
        });
        continue;
      }
      if (
        !Array.isArray(child) &&
        Object.getPrototypeOf(child) !== Object.prototype &&
        Object.getPrototypeOf(child) !== null
      ) {
        throw new TypeError("Atlas cache values must contain only plain objects and arrays");
      }
      let clonedChild = clones.get(child);
      if (!clonedChild) {
        clonedChild = Array.isArray(child) ? [] : {};
        clones.set(child, clonedChild);
        work.push({ source: child, target: clonedChild });
      }
      Object.defineProperty(target, key, {
        value: clonedChild,
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
  }
  return deepFreeze(root as T);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const seen = new WeakSet<object>();
  const work: object[] = [value];
  while (work.length > 0) {
    const current = work.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null) work.push(child);
    }
    Object.freeze(current);
  }
  return value;
}
