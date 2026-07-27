import { type CacheResourceOptions, ResourceCache } from "./cache.js";
import { assertRevision, FeedConnectionManager } from "./feed-connection.js";
import type { HttpTransport, ResponseValidator } from "./http.js";
import { assertPaginationProgress, pathWithQuery, requireCursor } from "./pagination.js";
import type { EntityResource, FeedEvent, ObjectDetailResource, ResourceType, TaskResource } from "./protocol.js";
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
import { SyncLifecycle } from "./sync-engine-lifecycle.js";
import { ReconnectTimer } from "./sync-engine-reconnect.js";
import { RecoveryCoordinator, RecoveryRunner } from "./sync-engine-recovery.js";
import type {
  AtlasRecoveredWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
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
import {
  entityCheckInResponseValidator,
  isEntityResource,
  isFullDatasetResponse,
  isObjectDetailResource,
  isProtocolRevisionResponse,
  isTaskResource
} from "./validation.js";

type AutomaticReconnectOwnership = {
  recoveryOperation?: number;
};

export class SyncEngine {
  private readonly transport: HttpTransport;
  /** @internal Test seam via sync-engine-test-internals.ts; not part of the public API. */
  readonly feed: FeedConnectionManager;
  private readonly cache: ResourceCache;
  private readonly pollIntervalMs: number;
  private readonly lifecycle = new SyncLifecycle();
  private readonly recovery = new RecoveryCoordinator();
  private readonly recoveryRunner: RecoveryRunner;
  private readonly reconnectTimer = new ReconnectTimer();
  private readonly subscriptions: AtlasSubscription[] = [];
  private readonly watchers = new Map<string, Set<WatchCallback<ResourceValue>>>();
  /** @internal Test seam via sync-engine-test-internals.ts; not part of the public API. */
  syncRunning = false;
  private healthy = false;
  private degraded = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private reconnecting = false;
  private reconnectAfterRecovery = false;
  private lastError: string | undefined;
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
    this.recoveryRunner = new RecoveryRunner(this.transport);
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
    const pendingStart = this.lifecycle.getStartSyncPromise();
    if (pendingStart !== undefined) {
      return pendingStart;
    }
    const generation = this.lifecycle.beginStart();
    this.invalidateRecovery();
    this.clearReconnectTimer();
    this.reconnecting = false;
    this.reconnectAfterRecovery = false;
    this.lastError = undefined;
    const promise = this.startSyncFromStopped(generation);
    this.lifecycle.setStartSyncPromise(promise);
    try {
      await promise;
    } catch (error) {
      if (this.isCurrent(generation) && !this.lastError) {
        this.lastError = "Atlas Core initial synchronization failed";
      }
      throw error;
    } finally {
      this.lifecycle.clearStartSyncPromiseIf(promise);
    }
  }

  stop(): void {
    this.lifecycle.stop();
    this.stopSideEffects();
  }

  status(): SyncStatus {
    return {
      running: this.syncRunning,
      healthy: this.healthy,
      degraded: this.degraded,
      ...(this.lastError ? { error: this.lastError } : {}),
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
    const generation = this.lifecycleGeneration;
    const attempt = this.beginFeedConnectionAttempt();
    await this.connectFeedForGeneration(generation, attempt);
    if (this.isCurrentFeedConnection(generation, attempt) && this.lastError === "Atlas Core feed connection failed") {
      this.lastError = undefined;
    }
  }

  private async connectFeedForGeneration(generation: number, attempt: number): Promise<void> {
    const isCurrentAttempt = () => this.isCurrentFeedConnection(generation, attempt);
    try {
      await this.feed.connect({
        subscriptions: this.subscriptions,
        onEvent: (event) => {
          if (!isCurrentAttempt()) return;
          return this.consumeFeedEvent(event, generation, attempt);
        },
        onEventError: () => {
          if (!isCurrentAttempt()) return;
          this.beginFeedConnectionAttempt();
          if (this.lastError !== "Atlas Core recovery request failed") this.lastError = "Atlas Core feed event failed";
          if (!this.syncRunning) return;
          this.invalidateRecovery();
          this.degraded = true;
          this.healthy = false;
          this.scheduleReconnect();
        },
        onClose: () => {
          if (!isCurrentAttempt()) return;
          this.beginFeedConnectionAttempt();
          if (!this.syncRunning) return;
          this.invalidateRecovery();
          this.lastError = "Atlas Core feed connection closed";
          this.healthy = false;
          this.degraded = true;
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      if (!isCurrentAttempt()) throw error;
      this.lastError = "Atlas Core feed connection failed";
      if (this.syncRunning) {
        this.healthy = false;
        this.degraded = true;
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  changedSince(): Promise<boolean> {
    return this.changedSinceForGeneration(this.lifecycleGeneration, this.cache.lastVersion);
  }

  /** @internal Test seam via sync-engine-test-internals.ts; not part of the public API. */
  changedSinceForGeneration(generation: number, sinceVersion = this.cache.lastVersion): Promise<boolean> {
    return this.recovery.start(
      generation,
      sinceVersion,
      (currentGeneration) => this.isCurrent(currentGeneration),
      (operation) => this.recoverSince(generation, sinceVersion, operation)
    );
  }

  private async recoverSince(generation: number, sinceVersion: number, operation: number): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    const isCurrentOperation = () => this.isCurrent(generation) && this.recoveryOperation === operation;
    try {
      if (!isCurrentOperation()) return false;
      const result = await this.recoveryRunner.run(
        sinceVersion,
        isCurrentOperation,
        (event) => this.applyEvent(event),
        (event) => this.applyRecoveredEvent(event)
      );
      if (!isCurrentOperation() || result.superseded) return false;
      this.cache.lastVersion = Math.max(this.cache.lastVersion, result.snapshotVersion ?? sinceVersion);
      this.markSynchronized();
      if (this.lastError === "Atlas Core recovery request failed") this.lastError = undefined;
      return true;
    } catch (error) {
      if (isCurrentOperation()) {
        this.lastError = "Atlas Core recovery request failed";
        if (this.syncRunning) {
          this.degraded = true;
          this.healthy = false;
          this.scheduleReconnect();
        }
      }
      throw error;
    }
  }

  async connectAndRecoverFeed(): Promise<void> {
    await this.connectAndRecoverFeedForGeneration(this.lifecycleGeneration);
  }

  async readEntity(id: string, options?: ReadOptions): Promise<EntityResource> {
    const cached = this.cache.entry("entity", id);
    if (
      !options?.fresh &&
      this.canServeFromCache({ filter: "id", resource_type: "entity", id }) &&
      cached?.value &&
      !cached.deleted
    ) {
      return cached.value;
    }
    const entity = await this.transport.json("GET", `/entities/${encodeURIComponent(id)}`, isEntityResource);
    assertExpectedResourceID("entity", id, entity);
    this.cache.cacheResource("entity", id, entity, { advanceCursor: false });
    return entity;
  }

  async readTask(id: string, options?: ReadOptions): Promise<TaskResource> {
    const cached = this.cache.entry("task", id);
    if (
      !options?.fresh &&
      this.canServeFromCache({ filter: "id", resource_type: "task", id }) &&
      cached?.value &&
      !cached.deleted
    ) {
      return cached.value;
    }
    const task = await this.transport.json("GET", `/tasks/${encodeURIComponent(id)}`, isTaskResource);
    assertExpectedResourceID("task", id, task);
    this.cache.cacheResource("task", id, task, { advanceCursor: false });
    return task;
  }

  async readObject(id: string, options?: ReadOptions): Promise<ObjectDetailResource> {
    const cached = this.cache.objectDetail(id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "object", id }) && cached) {
      return cached;
    }
    const object = await this.transport.json("GET", `/objects/${encodeURIComponent(id)}`, isObjectDetailResource);
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
    this.applyEvent(resourceUpsertEvent(type, event, id, resource.metadata.version, resource), {
      detail: type === "object",
      advanceCursor: false
    });
    return resource;
  }

  async checkInEntity(
    id: string,
    path: string,
    body: EntityCheckInBody,
    fields: "full" | "minimal",
    ifMatchVersion?: number
  ): Promise<EntityCheckInResponse> {
    const response = await this.transport.json(
      "POST",
      path,
      entityCheckInResponseValidator(id, fields),
      body,
      ifMatchVersion
    );
    this.applyEvent(
      {
        event: "update",
        resource_type: "entity",
        id: response.entity.entity_id,
        version: response.entity.metadata.version,
        resource: response.entity
      },
      { advanceCursor: false }
    );
    for (const task of response.tasks) {
      if (isTaskResource(task)) {
        this.applyEvent(
          { event: "update", resource_type: "task", id: task.task_id, version: task.metadata.version, resource: task },
          { advanceCursor: false }
        );
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
        const recovery = this.activeRecoveryPromise ?? this.changedSinceForGeneration(pollGeneration);
        const pollOperation = this.recoveryOperation;
        void recovery.catch(() => {
          if (!this.isCurrent(pollGeneration) || this.recoveryOperation !== pollOperation) return;
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
    this.reconnecting = false;
    this.reconnectAfterRecovery = false;
    this.syncRunning = false;
    this.invalidateRecovery();
    this.lastError = undefined;
    this.feed.close();
    this.healthy = false;
    this.degraded = false;
  }

  private isCurrent(generation: number): boolean {
    return this.lifecycle.isCurrent(generation);
  }

  /** @internal Test seam via sync-engine-test-internals.ts; not part of the public API. */
  get lifecycleGeneration(): number {
    return this.lifecycle.currentGeneration();
  }

  private get feedConnectionAttempt(): number {
    return this.lifecycle.currentFeedConnectionAttempt();
  }

  private get recoveryOperation(): number {
    return this.recovery.currentOperation();
  }

  /** @internal Test seam via sync-engine-test-internals.ts; not part of the public API. */
  get activeRecoveryPromise(): Promise<boolean> | undefined {
    return this.recovery.activeRecoveryPromise();
  }

  private get startSyncPromise(): Promise<void> | undefined {
    return this.lifecycle.getStartSyncPromise();
  }

  private invalidateRecovery(): number {
    return this.recovery.invalidate();
  }

  private beginFeedConnectionAttempt(): number {
    return this.lifecycle.beginFeedConnectionAttempt();
  }

  private isCurrentFeedConnection(generation: number, attempt: number): boolean {
    return this.lifecycle.isCurrentFeedConnection(generation, attempt);
  }

  private async hydrate(generation: number): Promise<void> {
    let cursors: FullDatasetCursors = {};
    let snapshotVersion: number | undefined;
    const seenCursors = new Map<string, Set<string>>();
    const entities: EntityResource[] = [];
    const tasks: TaskResource[] = [];
    const objects: ObjectDetailResource[] = [];
    do {
      if (!this.isCurrent(generation)) return;
      const response = await this.transport.json("GET", fullDatasetPath(cursors), isFullDatasetResponse);
      if (!this.isCurrent(generation)) return;
      const responseVersion = requireFullDatasetVersion(response.version);
      if (snapshotVersion !== undefined && responseVersion !== snapshotVersion) {
        throw new Error(
          `Atlas full-dataset pagination changed version watermark from ${snapshotVersion} to ${responseVersion}`
        );
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
    const recovered = await this.changedSinceForGeneration(generation, snapshotVersion);
    if (this.isCurrent(generation) && !recovered) throw new Error("Atlas initial recovery was superseded");
  }

  private async consumeFeedEvent(event: FeedEvent, generation: number, attempt: number): Promise<void> {
    if (!this.isCurrentFeedConnection(generation, attempt)) return;
    if (event.version > this.cache.lastVersion + 1) {
      this.degraded = true;
      this.healthy = false;
      const recovered = await this.changedSinceForGeneration(generation);
      if (!recovered || !this.isCurrentFeedConnection(generation, attempt)) return;
    }
    if (!this.isCurrentFeedConnection(generation, attempt)) return;
    this.applyEvent(event);
  }

  private async connectAndRecoverFeedForGeneration(
    generation: number,
    automaticOwnership?: AutomaticReconnectOwnership
  ): Promise<void> {
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
    const attempt = this.beginFeedConnectionAttempt();
    try {
      try {
        await this.connectFeedForGeneration(generation, attempt);
      } catch (error) {
        if (this.isCurrentFeedConnection(generation, attempt)) this.invalidateRecovery();
        throw error;
      }
      if (!this.isCurrentFeedConnection(generation, attempt)) return;
      const recovery = this.changedSinceForGeneration(generation);
      if (automaticOwnership) automaticOwnership.recoveryOperation = this.recoveryOperation;
      const recovered = await recovery;
      if (
        recovered &&
        this.isCurrentFeedConnection(generation, attempt) &&
        this.lastError?.startsWith("Atlas Core feed ")
      )
        this.lastError = undefined;
    } finally {
      if (this.isCurrent(generation)) {
        this.reconnecting = false;
        if (this.reconnectAfterRecovery) {
          this.reconnectAfterRecovery = false;
          this.scheduleReconnect();
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.syncRunning || !this.feed.available || this.reconnectTimer.pending) {
      return;
    }
    if (this.reconnecting) {
      this.reconnectAfterRecovery = true;
      return;
    }
    this.healthy = false;
    this.degraded = true;
    const generation = this.lifecycleGeneration;
    this.reconnectTimer.schedule(() => {
      const ownership: AutomaticReconnectOwnership = {};
      const reconnect = this.connectAndRecoverFeedForGeneration(generation, ownership);
      const attempt = this.feedConnectionAttempt;
      void reconnect.catch(() => {
        if (!this.isCurrentFeedConnection(generation, attempt)) return;
        if (ownership.recoveryOperation !== undefined && this.recoveryOperation !== ownership.recoveryOperation) return;
        this.degraded = true;
        this.healthy = false;
        this.scheduleReconnect();
      });
    });
  }

  private clearReconnectTimer(): void {
    this.reconnectTimer.clear();
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
    this.cache.cacheResource(
      event.resource_type,
      event.id,
      event.resource,
      event.resource_type === "object" ? { detail: true } : undefined
    );
    this.notify(event, this.cache.value(event.resource_type, event.id), previous);
  }

  private canServeFromCache(filter: AtlasSubscription): boolean {
    if (!this.syncRunning || this.startSyncPromise !== undefined || !this.healthy || this.degraded) {
      return false;
    }
    return this.subscriptions.some((sub) => covers(sub, filter));
  }

  /** @internal Test seam via sync-engine-test-internals.ts; not part of the public API. */
  markSynchronized(): void {
    const hasAutomaticUpdates = this.feed.connected || this.pollIntervalMs > 0;
    this.healthy = this.syncRunning && hasAutomaticUpdates;
    this.degraded = this.syncRunning && !hasAutomaticUpdates;
  }

  private advanceCursor(event: FeedEvent, enabled: boolean): void {
    if (enabled) {
      this.cache.lastVersion = Math.max(this.cache.lastVersion, event.version);
    }
  }

  private notify(
    event: AtlasWatchEvent,
    resource: ResourceValue | undefined,
    previous: ResourceValue | undefined
  ): void {
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

function fullDatasetPath(cursors: FullDatasetCursors): string {
  return pathWithQuery("/queries/full", cursors);
}

function nextFullDatasetCursors(response: FullDatasetResponse): FullDatasetCursors {
  const cursors: FullDatasetCursors = {};
  if (response.has_more_entities)
    cursors.entity_cursor = requireCursor(response.next_entity_cursor, "next_entity_cursor");
  if (response.has_more_tasks) cursors.task_cursor = requireCursor(response.next_task_cursor, "next_task_cursor");
  if (response.has_more_objects)
    cursors.object_cursor = requireCursor(response.next_object_cursor, "next_object_cursor");
  return cursors;
}

function hasMoreFullDataset(cursors: FullDatasetCursors): boolean {
  return Object.keys(cursors).length > 0;
}

function assertExpectedResourceID<TType extends ResourceType>(
  type: TType,
  expectedID: string,
  resource: ResourceOf<TType>
): void {
  const actualID = resourceID(type, resource);
  if (actualID !== expectedID) {
    throw new TypeError(`Atlas ${type} response id ${actualID} does not match requested id ${expectedID}`);
  }
}

function requireFullDatasetVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Atlas full-dataset response version watermark must be a non-negative safe integer");
  }
  return version;
}

function reportWatchCallbackError(error: unknown): void {
  if (typeof console === "undefined" || typeof console.error !== "function") {
    return;
  }
  console.error("Atlas watch callback failed", error);
}
