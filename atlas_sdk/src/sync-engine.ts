import { type CacheResourceOptions, ResourceCache } from "./cache.js";
import { sanitizeErrorMessage } from "./error-sanitizer.js";
import { assertRevision, FeedConnectionManager } from "./feed-connection.js";
import { AtlasAPIError, type HttpTransport, type ResponseValidator } from "./http.js";
import type { EntityResource, FeedEvent, ObjectDetailResource, ResourceType, TaskResource } from "./protocol.js";
import {
  assertResourceMatchesSubscription,
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
import { isTimerDelayInRange, MAX_TIMER_DELAY_MS } from "./timer.js";
import type {
  AtlasSubscription,
  AtlasWatchEvent,
  EntityCheckInBody,
  EntityCheckInResponse,
  FullDatasetCursors,
  FullDatasetResponse,
  ReadOptions,
  ResourceForSubscription,
  ResourceOf,
  ResourceValue,
  SyncSnapshot,
  SyncSnapshotCallback,
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

type ActiveHydration = {
  generation: number;
  operation?: number;
  promise: Promise<number | undefined>;
};

/**
 * Internal identity of the engine's last failure. Reconnect and recovery
 * decisions branch on these codes, never on the display text: the strings in
 * `SYNC_ERROR_MESSAGES` are presentation only and are safe to reword.
 */
type SyncErrorCode =
  | "initial-sync-failed"
  | "feed-connection-failed"
  | "feed-event-failed"
  | "feed-connection-closed"
  | "recovery-request-failed";

const SYNC_ERROR_MESSAGES: Record<SyncErrorCode, string> = {
  "initial-sync-failed": "Atlas Core initial synchronization failed",
  "feed-connection-failed": "Atlas Core feed connection failed",
  "feed-event-failed": "Atlas Core feed event failed",
  "feed-connection-closed": "Atlas Core feed connection closed",
  "recovery-request-failed": "Atlas Core recovery request failed"
};

const FEED_ERROR_CODES = new Set<SyncErrorCode>([
  "feed-connection-failed",
  "feed-event-failed",
  "feed-connection-closed"
]);

function isFeedErrorCode(code: SyncErrorCode | undefined): boolean {
  return code !== undefined && FEED_ERROR_CODES.has(code);
}

/**
 * One engine health state. `SyncStatus` still reports this as the separate
 * `healthy`/`degraded` booleans it always has; keeping a single field here
 * stops the two from drifting out of sync at the ~10 sites that set them.
 */
type SyncHealth = "idle" | "healthy" | "degraded";

export class SyncEngine {
  private readonly transport: HttpTransport;
  private readonly feed: FeedConnectionManager;
  private readonly cache: ResourceCache;
  private readonly pollIntervalMs: number;
  private readonly lifecycle = new SyncLifecycle();
  private readonly recovery = new RecoveryCoordinator();
  private readonly recoveryRunner: RecoveryRunner;
  private readonly reconnectTimer = new ReconnectTimer();
  private readonly subscriptions: AtlasSubscription[] = [];
  private readonly watchers = new Map<string, Set<WatchCallback<ResourceValue>>>();
  private readonly snapshotWatchers = new Set<SyncSnapshotCallback>();
  private activeHydration: ActiveHydration | undefined;
  private syncRunning = false;
  private health: SyncHealth = "idle";
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private reconnecting = false;
  private reconnectAfterRecovery = false;
  private lastErrorCode: SyncErrorCode | undefined;
  constructor(options: {
    transport: HttpTransport;
    feed: FeedConnectionManager;
    cache: ResourceCache;
    pollIntervalMs: number;
    initialSync?: false | "all";
  }) {
    if (!isTimerDelayInRange(options.pollIntervalMs, true)) {
      throw new Error(
        `Atlas polling interval must be zero or a positive finite number of milliseconds no greater than ${MAX_TIMER_DELAY_MS}`
      );
    }
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
    this.lastErrorCode = undefined;
    const promise = this.startSyncFromStopped(generation);
    this.lifecycle.setStartSyncPromise(promise);
    try {
      await promise;
    } catch (error) {
      if (this.isCurrent(generation) && !this.lastErrorCode) {
        this.lastErrorCode = "initial-sync-failed";
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
      healthy: this.health === "healthy",
      degraded: this.health === "degraded",
      ...(this.lastErrorCode ? { error: SYNC_ERROR_MESSAGES[this.lastErrorCode] } : {}),
      lastVersion: this.cache.lastVersion,
      subscriptions: [...this.subscriptions]
    };
  }

  snapshot(): SyncSnapshot {
    return this.cache.snapshot();
  }

  watchSnapshot(callback: SyncSnapshotCallback): () => void {
    const wrapped: SyncSnapshotCallback = (snapshot) => callback(snapshot);
    this.snapshotWatchers.add(wrapped);
    return () => this.snapshotWatchers.delete(wrapped);
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

  watch<TFilter extends AtlasSubscription>(
    filter: TFilter,
    callback: WatchCallback<ResourceForSubscription<TFilter>>
  ): () => void {
    const key = subscriptionKey(filter);
    let callbacks = this.watchers.get(key);
    if (!callbacks) {
      callbacks = new Set();
      this.watchers.set(key, callbacks);
    }
    const wrapped: WatchCallback<ResourceValue> = (resource, event) => {
      if (resource !== undefined) {
        assertResourceMatchesSubscription(filter, resource);
      }
      callback(resource, event);
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
    if (this.isCurrentFeedConnection(generation, attempt) && this.lastErrorCode === "feed-connection-failed") {
      this.lastErrorCode = undefined;
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
          if (this.lastErrorCode !== "recovery-request-failed") this.lastErrorCode = "feed-event-failed";
          if (!this.syncRunning) return;
          this.invalidateRecovery();
          this.health = "degraded";
          this.scheduleReconnect();
        },
        onClose: () => {
          if (!isCurrentAttempt()) return;
          this.beginFeedConnectionAttempt();
          if (!this.syncRunning) return;
          this.invalidateRecovery();
          this.lastErrorCode = "feed-connection-closed";
          this.health = "degraded";
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      if (!isCurrentAttempt()) throw error;
      this.lastErrorCode = "feed-connection-failed";
      if (this.syncRunning) {
        this.health = "degraded";
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  changedSince(): Promise<boolean> {
    return this.changedSinceForGeneration(this.lifecycleGeneration, this.cache.lastVersion);
  }

  private changedSinceForGeneration(generation: number, sinceVersion = this.cache.lastVersion): Promise<boolean> {
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
      if (this.syncRunning) this.health = "degraded";
      const result = await this.runRecoveryWithHydrationFallback(
        generation,
        sinceVersion,
        operation,
        isCurrentOperation
      );
      if (!isCurrentOperation() || result.superseded) return false;
      this.cache.lastVersion = Math.max(this.cache.lastVersion, result.snapshotVersion ?? sinceVersion);
      this.markSynchronized();
      if (this.lastErrorCode === "recovery-request-failed") this.lastErrorCode = undefined;
      return true;
    } catch (error) {
      if (isCurrentOperation()) {
        this.lastErrorCode = "recovery-request-failed";
        if (this.syncRunning) {
          this.health = "degraded";
          this.scheduleReconnect();
        }
      }
      throw error;
    }
  }

  private async runRecoveryWithHydrationFallback(
    generation: number,
    sinceVersion: number,
    operation: number,
    isCurrentOperation: () => boolean
  ): ReturnType<RecoveryRunner["run"]> {
    try {
      return await this.recoveryRunner.run(sinceVersion, isCurrentOperation, (event) => this.applyEvent(event));
    } catch (error) {
      if (!(error instanceof AtlasAPIError) || error.errorCode !== "CURSOR_EXPIRED") throw error;
      const hydratedVersion = await this.loadHydratedSnapshot(generation, isCurrentOperation, operation);
      if (!isCurrentOperation() || hydratedVersion === undefined) {
        return { snapshotVersion: hydratedVersion, superseded: true };
      }
      return this.recoveryRunner.run(hydratedVersion, isCurrentOperation, (event) => this.applyEvent(event));
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
    if (this.cache.cacheResource("entity", id, entity, { advanceCursor: false })) this.notifySnapshot();
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
    if (this.cache.cacheResource("task", id, task, { advanceCursor: false })) this.notifySnapshot();
    return task;
  }

  async readObject(id: string, options?: ReadOptions): Promise<ObjectDetailResource> {
    const cached = this.cache.objectDetail(id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "object", id }) && cached) {
      return cached;
    }
    const object = await this.transport.json("GET", `/objects/${encodeURIComponent(id)}`, isObjectDetailResource);
    assertExpectedResourceID("object", id, object);
    if (this.cache.cacheResource("object", id, object, { detail: true, advanceCursor: false })) this.notifySnapshot();
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
    this.notifySnapshot();
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
        this.health = "degraded";
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
          this.health = "degraded";
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
    this.lastErrorCode = undefined;
    this.feed.close();
    this.health = "idle";
  }

  private isCurrent(generation: number): boolean {
    return this.lifecycle.isCurrent(generation);
  }

  private get lifecycleGeneration(): number {
    return this.lifecycle.currentGeneration();
  }

  private get feedConnectionAttempt(): number {
    return this.lifecycle.currentFeedConnectionAttempt();
  }

  private get recoveryOperation(): number {
    return this.recovery.currentOperation();
  }

  private get activeRecoveryPromise(): Promise<boolean> | undefined {
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
    const snapshotVersion = await this.loadHydratedSnapshot(generation);
    if (snapshotVersion === undefined) return;
    const recovered = await this.changedSinceForGeneration(generation, snapshotVersion);
    if (this.isCurrent(generation) && !recovered) throw new Error("Atlas initial recovery was superseded");
  }

  private loadHydratedSnapshot(
    generation: number,
    isCurrentHydration = () => this.isCurrent(generation),
    operation?: number
  ): Promise<number | undefined> {
    const active = this.activeHydration;
    if (active?.generation === generation && (active.operation === undefined || active.operation === operation)) {
      return active.promise;
    }
    const promise = this.fetchAndInstallHydratedSnapshot(isCurrentHydration);
    const hydration = { generation, operation, promise };
    this.activeHydration = hydration;
    const clear = () => {
      if (this.activeHydration === hydration) this.activeHydration = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  private async fetchAndInstallHydratedSnapshot(isCurrentHydration: () => boolean): Promise<number | undefined> {
    let cursors: FullDatasetCursors = {};
    let snapshotVersion: number | undefined;
    const seenCursors = new Map<string, Set<string>>();
    const entities: EntityResource[] = [];
    const tasks: TaskResource[] = [];
    const objects: ObjectDetailResource[] = [];
    do {
      if (!isCurrentHydration()) return undefined;
      const response = await this.transport.json("GET", fullDatasetPath(cursors), isFullDatasetResponse);
      if (!isCurrentHydration()) return undefined;
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
    if (!isCurrentHydration()) return undefined;
    if (snapshotVersion === undefined) throw new Error("Atlas full-dataset response is missing a version watermark");
    this.cache.replaceHydratedResources({ entities, tasks, objects });
    this.cache.lastVersion = snapshotVersion;
    this.notifySnapshot();
    return snapshotVersion;
  }

  private async consumeFeedEvent(event: FeedEvent, generation: number, attempt: number): Promise<void> {
    await this.activeHydration?.promise;
    if (!this.isCurrentFeedConnection(generation, attempt)) return;
    if (event.version <= this.cache.lastVersion) return;
    if (event.version > this.cache.lastVersion + 1) {
      this.health = "degraded";
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
      if (recovered && this.isCurrentFeedConnection(generation, attempt) && isFeedErrorCode(this.lastErrorCode))
        this.lastErrorCode = undefined;
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
    this.health = "degraded";
    const generation = this.lifecycleGeneration;
    this.reconnectTimer.schedule(() => {
      const ownership: AutomaticReconnectOwnership = {};
      const reconnect = this.connectAndRecoverFeedForGeneration(generation, ownership);
      const attempt = this.feedConnectionAttempt;
      void reconnect.catch(() => {
        if (!this.isCurrentFeedConnection(generation, attempt)) return;
        if (ownership.recoveryOperation !== undefined && this.recoveryOperation !== ownership.recoveryOperation) return;
        this.health = "degraded";
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
    if (event.version <= this.cache.versionFor(event.resource_type, event.id)) {
      this.advanceCursor(event, advanceCursor);
      return;
    }
    if (pendingDelete && event.event === "delete") {
      this.cache.pendingDeletes.delete(key);
      this.cache.markRemoteDelete(event.resource_type, event.id, event.version);
      this.advanceCursor(event, advanceCursor);
      const alreadyNotified = this.cache.locallyNotifiedDeletes.delete(key);
      if (!alreadyNotified) {
        this.notify(event, undefined, previous);
        this.notifySnapshot();
      }
      return;
    }
    if (pendingDelete && event.event === "update") {
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
        this.notifySnapshot();
      }
      return;
    }
    this.cache.cacheResource(event.resource_type, event.id, event.resource, options);
    this.advanceCursor(event, advanceCursor);
    this.notify(event, this.cache.value(event.resource_type, event.id), previous);
    this.notifySnapshot();
  }

  private canServeFromCache(filter: AtlasSubscription): boolean {
    if (!this.syncRunning || this.startSyncPromise !== undefined || this.health !== "healthy") {
      return false;
    }
    return this.subscriptions.some((sub) => covers(sub, filter));
  }

  private markSynchronized(): void {
    const hasAutomaticUpdates = this.feed.connected || this.pollIntervalMs > 0;
    this.health = !this.syncRunning ? "idle" : hasAutomaticUpdates ? "healthy" : "degraded";
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

  private notifySnapshot(): void {
    if (this.snapshotWatchers.size === 0) return;
    const snapshot = this.cache.snapshot();
    for (const callback of this.snapshotWatchers) {
      try {
        callback(snapshot);
      } catch (error) {
        reportWatchCallbackError(error);
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
  console.error("Atlas watch callback failed", sanitizeErrorMessage(error));
}
