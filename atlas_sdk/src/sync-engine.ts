import type { EntityResource, FeedEvent, ObjectResource, ObjectResponse, ResourceType, TaskResource } from "./protocol.js";
import { ResourceCache, type CacheResourceOptions } from "./cache.js";
import { assertRevision, FeedConnectionManager } from "./feed-connection.js";
import type { HttpTransport, ResponseValidator } from "./http.js";
import {
  covers,
  localDeleteEvent,
  matchesSubscription,
  parseSubscriptionKey,
  resourceCacheKey,
  resourceID,
  resourceUpsertEvent,
  subscriptionKey
} from "./subscriptions.js";
import type {
  AtlasRecoveredWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
  ChangedSinceCursors,
  ChangedSinceResponse,
  EntityCheckInBody,
  EntityCheckInResponse,
  FullDatasetCursors,
  FullDatasetResponse,
  ReadOptions,
  ResourceOf,
  ResourceValue,
  SyncSnapshot,
  SyncStatus,
  WatchCallback
} from "./types.js";
import { changedSinceToEvents } from "./types.js";
import {
  changedSinceResponseValidator,
  entityCheckInResponseValidator,
  isEntityResource,
  isFullDatasetResponse,
  isObjectResponse,
  isProtocolRevisionResponse,
  isTaskResource
} from "./validation.js";

const DEFAULT_RECONNECT_DELAY_MS = 1_000;

export class SyncEngine {
  private readonly transport: HttpTransport;
  private readonly feed: FeedConnectionManager;
  private readonly cache: ResourceCache;
  private readonly pollIntervalMs: number;
  private readonly subscriptions: AtlasSubscription[] = [];
  private readonly watchers = new Map<string, Set<WatchCallback<ResourceValue>>>();
  private syncRunning = false;
  private healthy = false;
  private degraded = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnecting = false;
  private reconnectAfterRecovery = false;
  private startSyncPromise: Promise<void> | undefined;
  private lifecycleGeneration = 0;

  constructor(options: {
    transport: HttpTransport;
    feed: FeedConnectionManager;
    cache: ResourceCache;
    pollIntervalMs: number;
    initialSync?: false | "all";
  }) {
    this.transport = options.transport;
    this.feed = options.feed;
    this.cache = options.cache;
    this.pollIntervalMs = options.pollIntervalMs;
    if (options.initialSync === "all") {
      this.subscriptions.push({ filter: "all" });
    }
  }

  async handshake(): Promise<void> {
    const response = await this.transport.json("GET", "/protocol/revision", isProtocolRevisionResponse);
    assertRevision(response.protocol_revision);
  }

  async start(): Promise<void> {
    if (this.syncRunning) {
      return;
    }
    if (this.startSyncPromise) {
      return this.startSyncPromise;
    }
    const generation = ++this.lifecycleGeneration;
    const promise = this.startSyncFromStopped(generation);
    this.startSyncPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startSyncPromise === promise) {
        this.startSyncPromise = undefined;
      }
    }
  }

  stop(): void {
    this.lifecycleGeneration++;
    this.startSyncPromise = undefined;
    this.stopSideEffects();
  }

  status(): SyncStatus {
    return {
      running: this.syncRunning,
      healthy: this.healthy,
      degraded: this.degraded,
      lastVersion: this.cache.lastVersion,
      subscriptions: [...this.subscriptions]
    };
  }

  snapshot(): SyncSnapshot {
    return this.cache.snapshot();
  }

  async subscribe(filter: AtlasSubscription): Promise<void> {
    if (!this.subscriptions.some((existing) => subscriptionKey(existing) === subscriptionKey(filter))) {
      this.subscriptions.push(filter);
    }
    this.feed.sendSubscription("subscribe", filter);
  }

  async unsubscribe(filter: AtlasSubscription): Promise<void> {
    const key = subscriptionKey(filter);
    const index = this.subscriptions.findIndex((existing) => subscriptionKey(existing) === key);
    if (index >= 0) {
      this.subscriptions.splice(index, 1);
    }
    this.feed.sendSubscription("unsubscribe", filter);
  }

  watch<T extends ResourceValue>(filter: AtlasSubscription, callback: WatchCallback<T>): () => void {
    const key = subscriptionKey(filter);
    let callbacks = this.watchers.get(key);
    if (!callbacks) {
      callbacks = new Set();
      this.watchers.set(key, callbacks);
    }
    const wrapped: WatchCallback<ResourceValue> = (resource, event) => {
      callback(resource as T | undefined, event);
    };
    callbacks.add(wrapped);
    return () => {
      callbacks.delete(wrapped);
      if (callbacks.size === 0 && this.watchers.get(key) === callbacks) {
        this.watchers.delete(key);
      }
    };
  }

  async connectFeed(): Promise<void> {
    try {
      await this.feed.connect({
        subscriptions: this.subscriptions,
        onEvent: (event) => this.consumeFeedEvent(event),
        onEventError: () => {
          this.degraded = true;
          this.healthy = false;
          this.scheduleReconnect();
        },
        onClose: () => {
          if (!this.syncRunning) {
            return;
          }
          this.healthy = false;
          this.degraded = true;
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      if (this.syncRunning) {
        this.healthy = false;
        this.degraded = true;
        this.scheduleReconnect();
      }
      throw error;
    }
    this.healthy = true;
    this.degraded = false;
  }

  async changedSince(generation = this.lifecycleGeneration, sinceVersion = this.cache.lastVersion): Promise<void> {
    try {
      if (!this.isCurrent(generation)) return;
      let snapshotVersion: number | undefined;
      let cursors: ChangedSinceCursors = {};
      const recoveredEvents: AtlasWatchEvent[] = [];
      const seenCursors = new Map<string, Set<string>>();
      do {
        if (!this.isCurrent(generation)) return;
        const response = await this.transport.json("GET", changedSincePath(sinceVersion, cursors), changedSinceResponseValidator(sinceVersion));
        if (!this.isCurrent(generation)) return;
        if (snapshotVersion !== undefined && response.version !== snapshotVersion) {
          throw new TypeError("Atlas changed-since pagination changed response version");
        }
        snapshotVersion = response.version;
        recoveredEvents.push(...changedSinceToEvents(response));
        cursors = nextChangedSinceCursors(response);
        assertPaginationProgress("changed-since", cursors, seenCursors);
      } while (hasMoreChangedSince(cursors));
      for (const event of recoveredEvents.sort((a, b) => watchEventVersion(a) - watchEventVersion(b))) {
        if (!this.isCurrent(generation)) return;
        if (event.event === "recovered") {
          this.applyRecoveredEvent(event);
        } else if (event.event !== "local_delete") {
          this.applyEvent(event);
        }
      }
      if (!this.isCurrent(generation)) return;
      this.cache.lastVersion = Math.max(this.cache.lastVersion, snapshotVersion ?? sinceVersion);
      this.markSynchronized();
    } catch (error) {
      if (this.isCurrent(generation) && this.syncRunning) {
        this.degraded = true;
        this.healthy = false;
      }
      throw error;
    }
  }

  async connectAndRecoverFeed(): Promise<void> {
    await this.connectAndRecoverFeedForGeneration(this.lifecycleGeneration);
  }

  async readEntity(id: string, options?: ReadOptions): Promise<EntityResource> {
    const cached = this.cache.entry("entity", id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "entity", id }) && cached?.value && !cached.deleted) {
      return cached.value;
    }
    const entity = await this.transport.json("GET", `/entities/${encodeURIComponent(id)}`, isEntityResource);
    assertExpectedResourceID("entity", id, entity);
    this.cache.cacheResource("entity", id, entity, { advanceCursor: false });
    return entity;
  }

  async readTask(id: string, options?: ReadOptions): Promise<TaskResource> {
    const cached = this.cache.entry("task", id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "task", id }) && cached?.value && !cached.deleted) {
      return cached.value;
    }
    const task = await this.transport.json("GET", `/tasks/${encodeURIComponent(id)}`, isTaskResource);
    assertExpectedResourceID("task", id, task);
    this.cache.cacheResource("task", id, task, { advanceCursor: false });
    return task;
  }

  async readObject(id: string, options?: ReadOptions): Promise<ObjectResponse> {
    const cached = this.cache.entry("object", id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "object", id }) && cached?.value && !cached.deleted && cached.detail) {
      return cached.value;
    }
    const object = await this.transport.json("GET", `/objects/${encodeURIComponent(id)}`, isObjectResponse);
    assertExpectedResourceID("object", id, object);
    this.cache.cacheResource("object", id, object, { detail: true, advanceCursor: false });
    return object;
  }

  async writeResource<TType extends ResourceType, TResource extends ResourceOf<TType> = ResourceOf<TType>>(
    method: string,
    path: string,
    body: unknown,
    type: TType,
    expectedID: string | undefined,
    validate: ResponseValidator<TResource>,
    ifMatchVersion?: number,
    eventName?: "create" | "update",
    signal?: AbortSignal
  ): Promise<TResource> {
    const resource = await this.transport.json(method, path, validate, body, ifMatchVersion, signal);
    const id = resourceID(type, resource);
    if (expectedID !== undefined && id !== expectedID) {
      throw new TypeError(`Atlas ${type} response id ${id} does not match requested id ${expectedID}`);
    }
    const event = eventName ?? (method === "POST" ? "create" : "update");
    this.applyEvent(resourceUpsertEvent(type, event, id, resource.metadata.version, resource), { detail: type === "object", advanceCursor: false });
    return resource;
  }

  async checkInEntity(id: string, path: string, body: EntityCheckInBody, fields: "full" | "minimal", ifMatchVersion?: number): Promise<EntityCheckInResponse> {
    const response = await this.transport.json("POST", path, entityCheckInResponseValidator(id, fields), body, ifMatchVersion);
    this.applyEvent(
      { event: "update", resource_type: "entity", id: response.entity.entity_id, version: response.entity.metadata.version, resource: response.entity },
      { advanceCursor: false }
    );
    for (const task of response.tasks) {
      if (isTaskResource(task)) {
        this.applyEvent({ event: "update", resource_type: "task", id: task.task_id, version: task.metadata.version, resource: task }, { advanceCursor: false });
      }
    }
    return response;
  }

  async deleteResource(type: ResourceType, id: string, path: string): Promise<void> {
    await this.transport.empty("DELETE", path);
    const { previousVersion, previous } = this.cache.markLocalDelete(type, id);
    this.notify(localDeleteEvent(type, id, previousVersion), undefined, previous);
  }

  private async startSyncFromStopped(generation: number): Promise<void> {
    await this.handshake();
    if (!this.isCurrent(generation)) return;
    await this.hydrate(generation);
    if (!this.isCurrent(generation)) return;
    this.syncRunning = true;
    this.markSynchronized();
    if (this.feed.available) {
      try {
        await this.connectAndRecoverFeedForGeneration(generation);
      } catch {
        if (!this.isCurrent(generation)) return;
        this.degraded = true;
        this.healthy = false;
        this.scheduleReconnect();
      }
    }
    if (!this.isCurrent(generation)) return;
    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        const pollGeneration = generation;
        void this.changedSince(pollGeneration).catch(() => {
          if (!this.isCurrent(pollGeneration)) return;
          this.degraded = true;
          this.healthy = false;
        });
      }, this.pollIntervalMs);
    }
  }

  private stopSideEffects(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.clearReconnectTimer();
    this.syncRunning = false;
    this.feed.close();
    this.healthy = false;
    this.degraded = false;
  }

  private isCurrent(generation: number): boolean {
    return this.lifecycleGeneration === generation;
  }

  private async hydrate(generation: number): Promise<void> {
    let cursors: FullDatasetCursors = {};
    let snapshotVersion: number | undefined;
    const seenCursors = new Map<string, Set<string>>();
    const entities: EntityResource[] = [];
    const tasks: TaskResource[] = [];
    const objects: ObjectResource[] = [];
    do {
      if (!this.isCurrent(generation)) return;
      const response = await this.transport.json("GET", fullDatasetPath(cursors), isFullDatasetResponse);
      if (!this.isCurrent(generation)) return;
      const responseVersion = requireFullDatasetVersion(response.version);
      if (snapshotVersion !== undefined && responseVersion !== snapshotVersion) {
        throw new Error(`Atlas full-dataset pagination changed version watermark from ${snapshotVersion} to ${responseVersion}`);
      }
      snapshotVersion = responseVersion;
      entities.push(...(response.entities ?? []));
      tasks.push(...(response.tasks ?? []));
      objects.push(...(response.objects ?? []));
      cursors = nextFullDatasetCursors(response);
      assertPaginationProgress("full-dataset", cursors, seenCursors);
    } while (hasMoreFullDataset(cursors));
    if (!this.isCurrent(generation)) return;
    if (snapshotVersion === undefined) throw new Error("Atlas full-dataset response is missing a version watermark");
    this.cache.replaceHydratedResources({ entities, tasks, objects });
    await this.changedSince(generation, snapshotVersion);
  }

  private async consumeFeedEvent(event: FeedEvent): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (event.version > this.cache.lastVersion + 1) {
      this.degraded = true;
      await this.changedSince(generation);
      if (!this.isCurrent(generation)) return;
    }
    this.applyEvent(event);
  }

  private async connectAndRecoverFeedForGeneration(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) {
      return;
    }
    if (this.reconnecting) {
      this.reconnectAfterRecovery = true;
      return;
    }
    this.reconnecting = true;
    this.reconnectAfterRecovery = false;
    this.clearReconnectTimer();
    try {
      await this.connectFeed();
      if (!this.isCurrent(generation)) return;
      await this.changedSince(generation);
    } finally {
      this.reconnecting = false;
      if (this.reconnectAfterRecovery && this.isCurrent(generation)) {
        this.reconnectAfterRecovery = false;
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.syncRunning || !this.feed.available || this.reconnectTimer) {
      return;
    }
    if (this.reconnecting) {
      this.reconnectAfterRecovery = true;
      return;
    }
    this.healthy = false;
    this.degraded = true;
    const generation = this.lifecycleGeneration;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectAndRecoverFeedForGeneration(generation).catch(() => {
        if (!this.isCurrent(generation)) return;
        this.degraded = true;
        this.healthy = false;
        this.scheduleReconnect();
      });
    }, DEFAULT_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private applyEvent(event: FeedEvent, options?: CacheResourceOptions): void {
    const advanceCursor = options?.advanceCursor !== false;
    const key = resourceCacheKey(event.resource_type, event.id);
    const current = this.cache.entry(event.resource_type, event.id);
    const pendingDelete = this.cache.pendingDeletes.has(key);
    const previous = current?.value;
    if (pendingDelete && event.event === "delete") {
      this.cache.pendingDeletes.delete(key);
      this.cache.markRemoteDelete(event.resource_type, event.id, event.version);
      this.advanceCursor(event, advanceCursor);
      const alreadyNotified = this.cache.locallyNotifiedDeletes.delete(key);
      if (!alreadyNotified) {
        this.notify(event, undefined, previous);
      }
      return;
    }
    if ((pendingDelete || current?.deleted) && event.event === "update") {
      this.advanceCursor(event, advanceCursor);
      return;
    }
    if (event.version <= this.cache.versionFor(event.resource_type, event.id)) {
      this.advanceCursor(event, advanceCursor);
      return;
    }
    if (event.event === "delete") {
      this.cache.pendingDeletes.delete(key);
      this.cache.markRemoteDelete(event.resource_type, event.id, event.version);
      this.advanceCursor(event, advanceCursor);
      const alreadyNotified = this.cache.locallyNotifiedDeletes.delete(key);
      if (!alreadyNotified) {
        this.notify(event, undefined, previous);
      }
      return;
    }
    this.cache.cacheResource(event.resource_type, event.id, event.resource, options);
    this.advanceCursor(event, advanceCursor);
    this.notify(event, this.cache.value(event.resource_type, event.id), previous);
  }

  private applyRecoveredEvent(event: AtlasRecoveredWatchEvent): void {
    const key = resourceCacheKey(event.resource_type, event.id);
    const current = this.cache.entry(event.resource_type, event.id);
    const previous = current?.value;
    if (this.cache.pendingDeletes.has(key)) {
      this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
      return;
    }
    if (event.version <= this.cache.versionFor(event.resource_type, event.id)) {
      this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
      return;
    }
    this.cache.pendingDeletes.delete(key);
    this.cache.locallyNotifiedDeletes.delete(key);
    this.cache.cacheResource(event.resource_type, event.id, event.resource);
    this.notify(event, this.cache.value(event.resource_type, event.id), previous);
  }

  private canServeFromCache(filter: AtlasSubscription): boolean {
    if (!this.syncRunning || this.startSyncPromise || !this.healthy || this.degraded) {
      return false;
    }
    return this.subscriptions.some((sub) => covers(sub, filter));
  }

  private markSynchronized(): void {
    const hasAutomaticUpdates = this.feed.connected || this.pollIntervalMs > 0;
    this.healthy = this.syncRunning && hasAutomaticUpdates;
    this.degraded = this.syncRunning && !hasAutomaticUpdates;
  }

  private advanceCursor(event: FeedEvent, enabled: boolean): void {
    if (enabled) {
      this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
    }
  }

  private notify(event: AtlasWatchEvent, resource: ResourceValue | undefined, previous: ResourceValue | undefined): void {
    for (const [key, callbacks] of this.watchers) {
      if (!matchesSubscription(parseSubscriptionKey(key), event, previous)) {
        continue;
      }
      for (const callback of callbacks) {
        try {
          callback(resource, event);
        } catch (error) {
          reportWatchCallbackError(error);
        }
      }
    }
  }
}

function watchEventVersion(event: AtlasWatchEvent): number {
  return "version" in event ? event.version : 0;
}

function fullDatasetPath(cursors: FullDatasetCursors): string {
  return pathWithQuery("/queries/full", cursors);
}

function changedSincePath(sinceVersion: number, cursors: ChangedSinceCursors): string {
  return pathWithQuery("/queries/changed-since", { since_version: String(sinceVersion), ...cursors });
}

function nextFullDatasetCursors(response: FullDatasetResponse): FullDatasetCursors {
  const cursors: FullDatasetCursors = {};
  if (response.has_more_entities) cursors.entity_cursor = requireCursor(response.next_entity_cursor, "next_entity_cursor");
  if (response.has_more_tasks) cursors.task_cursor = requireCursor(response.next_task_cursor, "next_task_cursor");
  if (response.has_more_objects) cursors.object_cursor = requireCursor(response.next_object_cursor, "next_object_cursor");
  return cursors;
}

function nextChangedSinceCursors(response: ChangedSinceResponse): ChangedSinceCursors {
  const cursors: ChangedSinceCursors = {};
  if (response.has_more_entities) cursors.entity_cursor = requireCursor(response.next_entity_cursor, "next_entity_cursor");
  if (response.has_more_tasks) cursors.task_cursor = requireCursor(response.next_task_cursor, "next_task_cursor");
  if (response.has_more_objects) cursors.object_cursor = requireCursor(response.next_object_cursor, "next_object_cursor");
  if (response.has_more_deleted_entities) cursors.deleted_entity_cursor = requireCursor(response.next_deleted_entity_cursor, "next_deleted_entity_cursor");
  if (response.has_more_deleted_tasks) cursors.deleted_task_cursor = requireCursor(response.next_deleted_task_cursor, "next_deleted_task_cursor");
  if (response.has_more_deleted_objects) cursors.deleted_object_cursor = requireCursor(response.next_deleted_object_cursor, "next_deleted_object_cursor");
  return cursors;
}

function hasMoreFullDataset(cursors: FullDatasetCursors): boolean {
  return Object.keys(cursors).length > 0;
}

function hasMoreChangedSince(cursors: ChangedSinceCursors): boolean {
  return Object.keys(cursors).length > 0;
}

function assertExpectedResourceID<TType extends ResourceType>(type: TType, expectedID: string, resource: ResourceOf<TType>): void {
  const actualID = resourceID(type, resource);
  if (actualID !== expectedID) {
    throw new TypeError(`Atlas ${type} response id ${actualID} does not match requested id ${expectedID}`);
  }
}

function assertPaginationProgress(label: string, cursors: object, seen: Map<string, Set<string>>): void {
  for (const [stream, cursor] of Object.entries(cursors)) {
    let values = seen.get(stream);
    if (!values) {
      values = new Set<string>();
      seen.set(stream, values);
    }
    if (values.has(cursor)) throw new Error(`Atlas ${label} pagination repeated ${stream}`);
    values.add(cursor);
  }
}

function requireCursor(cursor: string | undefined, name: string): string {
  if (!cursor) {
    throw new Error(`Atlas response set ${name.replace(/^next_/, "has_more_")} without ${name}`);
  }
  return cursor;
}

function requireFullDatasetVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Atlas full-dataset response version watermark must be a non-negative safe integer");
  }
  return version;
}

function pathWithQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, value);
    }
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function reportWatchCallbackError(error: unknown): void {
  if (typeof console === "undefined" || typeof console.error !== "function") {
    return;
  }
  console.error("Atlas watch callback failed", error);
}
