import type { EntityResource, FeedEvent, ObjectResource, ResourceType, TaskResource } from "./protocol.js";
import { ResourceCache } from "./cache.js";
import { assertRevision, FeedConnectionManager } from "./feed-connection.js";
import type { HttpTransport } from "./http.js";
import {
  covers,
  localDeleteEvent,
  matchesSubscription,
  parseSubscriptionKey,
  resourceCacheKey,
  resourceID,
  subscriptionKey
} from "./subscriptions.js";
import type {
  AtlasRecoveredWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
  ChangedSinceCursors,
  ChangedSinceResponse,
  FullDatasetCursors,
  FullDatasetResponse,
  ReadOptions,
  ResourceValue,
  SyncStatus,
  WatchCallback
} from "./types.js";
import { changedSinceToEvents } from "./types.js";

const DEFAULT_RECONNECT_DELAY_MS = 1_000;

export class SyncEngine {
  private readonly transport: HttpTransport;
  private readonly feed: FeedConnectionManager;
  private readonly cache: ResourceCache;
  private readonly pollIntervalMs: number;
  private readonly subscriptions: AtlasSubscription[] = [];
  private readonly watchers = new Map<string, Set<WatchCallback<any>>>();
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
    initialSync?: false | "all" | "selective";
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
    const response = await this.transport.json<{ protocol_revision: string }>("GET", "/protocol/revision");
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

  watch<T extends EntityResource | TaskResource | ObjectResource>(filter: AtlasSubscription, callback: WatchCallback<T>): () => void {
    const key = subscriptionKey(filter);
    let callbacks = this.watchers.get(key);
    if (!callbacks) {
      callbacks = new Set();
      this.watchers.set(key, callbacks);
    }
    callbacks.add(callback as WatchCallback<any>);
    return () => callbacks?.delete(callback as WatchCallback<any>);
  }

  async connectFeed(): Promise<void> {
    await this.feed.connect({
      subscriptions: this.subscriptions,
      onEvent: (event) => this.consumeFeedEvent(event),
      onEventError: () => {
        this.degraded = true;
        this.healthy = false;
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
    this.healthy = true;
    this.degraded = false;
  }

  async changedSince(): Promise<void> {
    const sinceVersion = this.cache.lastVersion;
    let highWaterVersion = sinceVersion;
    let cursors: ChangedSinceCursors = {};
    const recoveredEvents: AtlasWatchEvent[] = [];
    do {
      const response = await this.transport.json<ChangedSinceResponse>("GET", changedSincePath(sinceVersion, cursors));
      highWaterVersion = Math.max(highWaterVersion, response.version);
      recoveredEvents.push(...changedSinceToEvents(response));
      cursors = nextChangedSinceCursors(response);
    } while (hasMoreChangedSince(cursors));
    for (const event of recoveredEvents.sort((a, b) => watchEventVersion(a) - watchEventVersion(b))) {
      if (event.event === "recovered") {
        this.applyRecoveredEvent(event);
      } else if (event.event !== "local_delete") {
        this.applyEvent(event);
      }
    }
    this.cache.lastVersion = Math.max(this.cache.lastVersion, highWaterVersion);
    this.degraded = false;
    this.healthy = this.syncRunning;
  }

  async connectAndRecoverFeed(): Promise<void> {
    await this.connectAndRecoverFeedForGeneration(this.lifecycleGeneration);
  }

  async readEntity(id: string, options?: ReadOptions): Promise<EntityResource> {
    const cached = this.cache.entry<EntityResource>("entity", id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "entity", id }) && cached?.value && !cached.deleted) {
      return cached.value;
    }
    const entity = await this.transport.json<EntityResource>("GET", `/entities/${encodeURIComponent(id)}`);
    this.cache.cacheResource("entity", entity.entity_id, entity);
    return entity;
  }

  async readTask(id: string, options?: ReadOptions): Promise<TaskResource> {
    const cached = this.cache.entry<TaskResource>("task", id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "task", id }) && cached?.value && !cached.deleted) {
      return cached.value;
    }
    const task = await this.transport.json<TaskResource>("GET", `/tasks/${encodeURIComponent(id)}`);
    this.cache.cacheResource("task", task.task_id, task);
    return task;
  }

  async readObject(id: string, options?: ReadOptions): Promise<ObjectResource> {
    const cached = this.cache.entry<ObjectResource>("object", id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "object", id }) && cached?.value && !cached.deleted) {
      return cached.value;
    }
    const object = await this.transport.json<ObjectResource>("GET", `/objects/${encodeURIComponent(id)}`);
    this.cache.cacheResource("object", object.object_id, object);
    return object;
  }

  async writeResource<T extends EntityResource | TaskResource | ObjectResource>(
    method: string,
    path: string,
    body: unknown,
    type: ResourceType,
    ifMatchVersion?: number
  ): Promise<T> {
    const resource = await this.transport.json<T>(method, path, body, ifMatchVersion);
    const id = resourceID(type, resource);
    this.applyEvent({ event: method === "POST" ? "create" : "update", resource_type: type, id, version: resource.metadata.version, resource } as FeedEvent);
    return resource;
  }

  async deleteResource(type: ResourceType, id: string, path: string): Promise<void> {
    await this.transport.json<void>("DELETE", path);
    const { previousVersion, previous } = this.cache.markLocalDelete(type, id);
    this.notify(localDeleteEvent(type, id, previousVersion), undefined, previous);
  }

  private async startSyncFromStopped(generation: number): Promise<void> {
    await this.handshake();
    if (!this.isCurrent(generation)) return;
    await this.hydrate();
    if (!this.isCurrent(generation)) return;
    this.syncRunning = true;
    this.healthy = true;
    this.degraded = false;
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
        void this.changedSince().catch(() => {
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

  private async hydrate(): Promise<void> {
    let cursors: FullDatasetCursors = {};
    do {
      const response = await this.transport.json<FullDatasetResponse>("GET", fullDatasetPath(cursors));
      for (const entity of response.entities ?? []) this.cache.cacheResource("entity", entity.entity_id, entity);
      for (const task of response.tasks ?? []) this.cache.cacheResource("task", task.task_id, task);
      for (const object of response.objects ?? []) this.cache.cacheResource("object", object.object_id, object);
      cursors = nextFullDatasetCursors(response);
    } while (hasMoreFullDataset(cursors));
  }

  private async consumeFeedEvent(event: FeedEvent): Promise<void> {
    if (event.version > this.cache.lastVersion + 1) {
      this.degraded = true;
      await this.changedSince();
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
      await this.changedSince();
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

  private applyEvent(event: FeedEvent): void {
    const key = resourceCacheKey(event.resource_type, event.id);
    const current = this.cache.entries[event.resource_type].get(event.id);
    const pendingDelete = this.cache.pendingDeletes.has(key);
    const previous = current?.value;
    if (pendingDelete && event.event === "delete") {
      this.cache.pendingDeletes.delete(key);
      this.cache.entries[event.resource_type].set(event.id, { version: event.version, deleted: true });
      this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
      const alreadyNotified = this.cache.locallyNotifiedDeletes.delete(key);
      if (!alreadyNotified) {
        this.notify(event, undefined, previous);
      }
      return;
    }
    if ((pendingDelete || current?.deleted) && event.event === "update") {
      this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
      return;
    }
    if (event.version <= this.cache.versionFor(event.resource_type, event.id)) {
      this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
      return;
    }
    if (event.event === "delete") {
      this.cache.pendingDeletes.delete(key);
      this.cache.entries[event.resource_type].set(event.id, { version: event.version, deleted: true });
      this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
      const alreadyNotified = this.cache.locallyNotifiedDeletes.delete(key);
      if (!alreadyNotified) {
        this.notify(event, undefined, previous);
      }
      return;
    }
    const resource = event.resource as EntityResource | TaskResource | ObjectResource;
    this.cache.cacheResource(event.resource_type, event.id, resource);
    this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
    this.notify(event, resource, previous);
  }

  private applyRecoveredEvent(event: AtlasRecoveredWatchEvent): void {
    const key = resourceCacheKey(event.resource_type, event.id);
    const current = this.cache.entries[event.resource_type].get(event.id);
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
    this.cache.entries[event.resource_type].set(event.id, { value: event.resource as any, version: event.version, deleted: false });
    this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
    this.notify(event, event.resource, previous);
  }

  private canServeFromCache(filter: AtlasSubscription): boolean {
    if (!this.syncRunning || !this.healthy || this.degraded) {
      return false;
    }
    return this.subscriptions.some((sub) => covers(sub, filter));
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

function requireCursor(cursor: string | undefined, name: string): string {
  if (!cursor) {
    throw new Error(`Atlas response set ${name.replace(/^next_/, "has_more_")} without ${name}`);
  }
  return cursor;
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
