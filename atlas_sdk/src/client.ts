import {
  ATLAS_PROTOCOL_REVISION,
  type EntityResource,
  type FeedEvent,
  type FeedHandshakeMessage,
  type FeedSubscribeMessage,
  type FeedUnsubscribeMessage,
  type ObjectResource,
  type ResourceType,
  type TaskDeleteEvent,
  type TaskResource
} from "./protocol.js";

const WS_CLOSED = 3;

type FetchLike = typeof fetch;

type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  removeEventListener?(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  off?(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  removeListener?(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

type FeedConnection = {
  socket: WebSocketLike;
  controller: AbortController;
};

export type AtlasSubscription =
  | { filter: "all" }
  | { filter: "id"; resource_type: ResourceType; id: string }
  | { filter: "type"; resource_type: ResourceType }
  | { filter: "tasks_for_entity"; entity_id: string };

export type ReadOptions = {
  fresh?: boolean;
};

export type SyncStatus = {
  running: boolean;
  healthy: boolean;
  degraded: boolean;
  lastVersion: number;
  subscriptions: AtlasSubscription[];
};

export type AtlasClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: FetchLike;
  WebSocket?: WebSocketCtor;
  sync?: false | "all" | "selective";
  pollIntervalMs?: number;
  objectContentCacheEntries?: number;
  feedHandshakeTimeoutMs?: number;
};

type ChangedSinceResponse = {
  entities: EntityResource[];
  tasks: TaskResource[];
  objects: ObjectResource[];
  deleted_entities?: DeletedResource[];
  deleted_tasks?: DeletedResource[];
  deleted_objects?: DeletedResource[];
  has_more_entities?: boolean;
  has_more_tasks?: boolean;
  has_more_objects?: boolean;
  has_more_deleted_entities?: boolean;
  has_more_deleted_tasks?: boolean;
  has_more_deleted_objects?: boolean;
  next_entity_cursor?: string;
  next_task_cursor?: string;
  next_object_cursor?: string;
  next_deleted_entity_cursor?: string;
  next_deleted_task_cursor?: string;
  next_deleted_object_cursor?: string;
  version: number;
};

type FullDatasetResponse = {
  entities: EntityResource[];
  tasks: TaskResource[];
  objects: ObjectResource[];
  has_more_entities?: boolean;
  has_more_tasks?: boolean;
  has_more_objects?: boolean;
  next_entity_cursor?: string;
  next_task_cursor?: string;
  next_object_cursor?: string;
};

type DeletedResource = {
  id: string;
  type: ResourceType;
  version: number;
  entity_id?: string | null;
};

type ResourceValue = EntityResource | TaskResource | ObjectResource;

export type AtlasRecoveredWatchEvent = {
  event: "recovered";
  resource_type: ResourceType;
  id: string;
  version: number;
  resource: ResourceValue;
};

export type AtlasLocalDeleteWatchEvent = {
  event: "local_delete";
  resource_type: ResourceType;
  id: string;
  previous_version?: number;
};

export type AtlasWatchEvent = FeedEvent | AtlasRecoveredWatchEvent | AtlasLocalDeleteWatchEvent;

type FullDatasetCursors = {
  entity_cursor?: string;
  task_cursor?: string;
  object_cursor?: string;
};

type ChangedSinceCursors = FullDatasetCursors & {
  deleted_entity_cursor?: string;
  deleted_task_cursor?: string;
  deleted_object_cursor?: string;
};

type WatchCallback<T> = (value: T | undefined, event: AtlasWatchEvent) => void;

type CacheEntry<T> = {
  value?: T;
  version: number;
  deleted: boolean;
};

export class ConflictError extends Error {
  readonly status: number;
  readonly response: unknown;

  constructor(message: string, status: number, response: unknown) {
    super(message);
    this.name = "ConflictError";
    this.status = status;
    this.response = response;
  }
}

export class ProtocolMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`Atlas protocol revision mismatch: SDK ${expected}, Core ${actual}`);
    this.name = "ProtocolMismatchError";
  }
}

class ObjectContentCache {
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

export class AtlasClient {
  readonly entities = {
    get: (id: string, options?: ReadOptions) => this.readEntity(id, options),
    create: (entity: EntityResource) => this.writeResource<EntityResource>("POST", "/entities", entity, "entity"),
    update: (id: string, patch: Partial<EntityResource>, options?: { ifMatchVersion?: number }) =>
      this.writeResource<EntityResource>("PATCH", `/entities/${encodeURIComponent(id)}`, patch, "entity", options?.ifMatchVersion),
    delete: (id: string) => this.deleteResource("entity", id, `/entities/${encodeURIComponent(id)}`),
    watch: (id: string, callback: WatchCallback<EntityResource>) => this.watch({ filter: "id", resource_type: "entity", id }, callback)
  };

  readonly tasks = {
    get: (id: string, options?: ReadOptions) => this.readTask(id, options),
    create: (task: TaskResource) => this.writeResource<TaskResource>("POST", "/tasks", task, "task"),
    update: (id: string, patch: Partial<TaskResource>, options?: { ifMatchVersion?: number }) =>
      this.writeResource<TaskResource>("PATCH", `/tasks/${encodeURIComponent(id)}`, patch, "task", options?.ifMatchVersion),
    delete: (id: string) => this.deleteResource("task", id, `/tasks/${encodeURIComponent(id)}`),
    watch: (id: string, callback: WatchCallback<TaskResource>) => this.watch({ filter: "id", resource_type: "task", id }, callback)
  };

  readonly objects = {
    get: (id: string, options?: ReadOptions) => this.readObject(id, options),
    create: (object: ObjectResource) => this.writeResource<ObjectResource>("POST", "/objects", object, "object"),
    update: (id: string, patch: Partial<ObjectResource>, options?: { ifMatchVersion?: number }) =>
      this.writeResource<ObjectResource>("PATCH", `/objects/${encodeURIComponent(id)}`, patch, "object", options?.ifMatchVersion),
    delete: (id: string) => this.deleteResource("object", id, `/objects/${encodeURIComponent(id)}`),
    content: (id: string) => this.objectContent(id),
    watch: (id: string, callback: WatchCallback<ObjectResource>) => this.watch({ filter: "id", resource_type: "object", id }, callback)
  };

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;
  private readonly WebSocketImpl?: WebSocketCtor;
  private readonly pollIntervalMs: number;
  private readonly feedHandshakeTimeoutMs: number;
  private readonly objectContents: ObjectContentCache;
  private readonly cache = {
    entity: new Map<string, CacheEntry<EntityResource>>(),
    task: new Map<string, CacheEntry<TaskResource>>(),
    object: new Map<string, CacheEntry<ObjectResource>>()
  };
  private readonly subscriptions: AtlasSubscription[] = [];
  private readonly watchers = new Map<string, Set<WatchCallback<any>>>();
  private readonly pendingDeletes = new Set<string>();
  private readonly locallyNotifiedDeletes = new Set<string>();
  private syncRunning = false;
  private healthy = false;
  private degraded = false;
  private lastVersion = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private socket: WebSocketLike | undefined;
  private feedConnection: FeedConnection | undefined;

  constructor(options: AtlasClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.WebSocketImpl = options.WebSocket ?? (globalThis as any).WebSocket;
    this.pollIntervalMs = options.pollIntervalMs ?? 120_000;
    this.feedHandshakeTimeoutMs = options.feedHandshakeTimeoutMs ?? 5_000;
    this.objectContents = new ObjectContentCache(options.objectContentCacheEntries ?? 64);
    if (!this.fetchImpl) {
      throw new Error("AtlasClient requires a fetch implementation");
    }
    if (options.sync === "all") {
      this.subscriptions.push({ filter: "all" });
    }
  }

  async handshake(): Promise<void> {
    const response = await this.http<{ protocol_revision: string }>("GET", "/protocol/revision");
    this.assertRevision(response.protocol_revision);
  }

  sync = {
    start: async () => {
      await this.startSync();
    },
    stop: () => this.stopSync(),
    status: (): SyncStatus => ({
      running: this.syncRunning,
      healthy: this.healthy,
      degraded: this.degraded,
      lastVersion: this.lastVersion,
      subscriptions: [...this.subscriptions]
    })
  };

  async subscribe(filter: AtlasSubscription): Promise<void> {
    if (!this.subscriptions.some((existing) => subscriptionKey(existing) === subscriptionKey(filter))) {
      this.subscriptions.push(filter);
    }
    this.socket?.send(JSON.stringify(subscriptionMessage("subscribe", filter)));
  }

  async unsubscribe(filter: AtlasSubscription): Promise<void> {
    const key = subscriptionKey(filter);
    const index = this.subscriptions.findIndex((existing) => subscriptionKey(existing) === key);
    if (index >= 0) {
      this.subscriptions.splice(index, 1);
    }
    this.socket?.send(JSON.stringify(subscriptionMessage("unsubscribe", filter)));
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
    if (!this.WebSocketImpl) {
      throw new Error("AtlasClient requires a WebSocket implementation");
    }
    const socket = new this.WebSocketImpl(feedUrl(this.baseUrl));
    const previousConnection = this.feedConnection;
    previousConnection?.controller.abort();
    if (previousConnection && previousConnection.socket.readyState !== WS_CLOSED) {
      previousConnection.socket.close();
    }
    // Close any orphaned this.socket that drifted away from previousConnection?.socket and is not already CLOSED.
    if (this.socket && this.socket !== previousConnection?.socket && this.socket.readyState !== WS_CLOSED) {
      this.socket.close();
    }
    this.socket = undefined;
    const connection: FeedConnection = { socket, controller: new AbortController() };
    this.feedConnection = connection;
    const ensureCurrent = () => {
      if (this.feedConnection !== connection || connection.controller.signal.aborted) {
        throw new Error("feed connection was replaced");
      }
    };
    const startupCleanups: Array<() => void> = [];
    const onStartup = (type: "open" | "message" | "close" | "error", listener: (event: any) => void) => {
      socket.addEventListener(type, listener);
      startupCleanups.push(() => removeSocketListener(socket, type, listener));
    };
    const onAbort = (listener: () => void) => {
      connection.controller.signal.addEventListener("abort", listener, { once: true });
      startupCleanups.push(() => connection.controller.signal.removeEventListener("abort", listener));
    };
    const cleanupStartup = () => {
      for (const cleanup of startupCleanups.splice(0)) {
        cleanup();
      }
    };
    const hello = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("feed protocol hello timed out"))),
        this.feedHandshakeTimeoutMs
      );
      const onMessage = (message: any) => {
        if (settled) {
          return;
        }
        try {
          const data = JSON.parse(String(message.data)) as FeedHandshakeMessage;
          if (data.type !== "hello") {
            finish(() => reject(new Error("feed did not send protocol hello")));
            return;
          }
          this.assertRevision(data.protocol_revision);
          finish(resolve);
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const onClose = () => finish(() => reject(new Error("feed websocket closed before protocol hello")));
      const onError = () => finish(() => reject(new Error("feed websocket failed before protocol hello")));
      const abortHello = () => finish(() => reject(new Error("feed connection was replaced")));
      onStartup("message", onMessage);
      onStartup("close", onClose);
      onStartup("error", onError);
      onAbort(abortHello);
    });
    void hello.catch(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(
          () => finish(() => reject(new Error("feed websocket open timed out"))),
          this.feedHandshakeTimeoutMs
        );
        const onOpen = () => finish(resolve);
        const onClose = () => finish(() => reject(new Error("feed websocket closed before opening")));
        const onError = () => finish(() => reject(new Error("feed websocket failed to open")));
        const abortOpen = () => finish(() => reject(new Error("feed connection was replaced")));
        onStartup("open", onOpen);
        onStartup("close", onClose);
        onStartup("error", onError);
        onAbort(abortOpen);
      });
      ensureCurrent();
      if (this.apiKey) {
        socket.send(JSON.stringify({ action: "auth", api_key: this.apiKey }));
      }
      await hello;
      ensureCurrent();
      cleanupStartup();
    } catch (error) {
      cleanupStartup();
      if (this.feedConnection === connection) {
        this.feedConnection = undefined;
      }
      socket.close();
      throw error;
    }

    ensureCurrent();
    this.socket = socket;
    this.healthy = true;
    this.degraded = false;
    for (const filter of this.subscriptions) {
      socket.send(JSON.stringify(subscriptionMessage("subscribe", filter)));
    }
    socket.addEventListener("message", (message: any) => {
      if (this.feedConnection !== connection || this.socket !== socket) {
        return;
      }
      try {
        const data = JSON.parse(String(message.data));
        if (data.type === "hello") {
          return;
        }
        void this.consumeFeedEvent(data as FeedEvent).catch(() => {
          this.degraded = true;
          this.healthy = false;
        });
      } catch {
        this.degraded = true;
        this.healthy = false;
      }
    });
    socket.addEventListener("close", () => {
      if (this.feedConnection !== connection) {
        return;
      }
      this.feedConnection = undefined;
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.healthy = false;
      this.degraded = true;
    });
  }

  async changedSince(): Promise<void> {
    const sinceVersion = this.lastVersion;
    let highWaterVersion = sinceVersion;
    let cursors: ChangedSinceCursors = {};
    const recoveredEvents: AtlasWatchEvent[] = [];
    do {
      const response = await this.http<ChangedSinceResponse>("GET", changedSincePath(sinceVersion, cursors));
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
    this.lastVersion = Math.max(this.lastVersion, highWaterVersion);
    this.degraded = false;
    this.healthy = this.syncRunning;
  }

  private async startSync(): Promise<void> {
    if (this.syncRunning) {
      return;
    }
    await this.handshake();
    await this.hydrate();
    this.syncRunning = true;
    this.healthy = true;
    this.degraded = false;
    if (this.WebSocketImpl) {
      try {
        await this.connectFeed();
      } catch {
        this.degraded = true;
        this.healthy = false;
      }
    }
    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        void this.changedSince().catch(() => {
          this.degraded = true;
          this.healthy = false;
        });
      }, this.pollIntervalMs);
    }
  }

  private stopSync(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const connection = this.feedConnection;
    this.feedConnection = undefined;
    connection?.controller.abort();
    const socket = this.socket ?? connection?.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WS_CLOSED) {
      socket.close();
    }
    this.syncRunning = false;
    this.healthy = false;
    this.degraded = false;
  }

  private async hydrate(): Promise<void> {
    let cursors: FullDatasetCursors = {};
    do {
      const response = await this.http<FullDatasetResponse>("GET", fullDatasetPath(cursors));
      for (const entity of response.entities ?? []) this.cacheResource("entity", entity.entity_id, entity);
      for (const task of response.tasks ?? []) this.cacheResource("task", task.task_id, task);
      for (const object of response.objects ?? []) this.cacheResource("object", object.object_id, object);
      cursors = nextFullDatasetCursors(response);
    } while (hasMoreFullDataset(cursors));
  }

  private async consumeFeedEvent(event: FeedEvent): Promise<void> {
    if (this.subscriptions.some((sub) => sub.filter === "all") && event.version > this.lastVersion + 1) {
      this.degraded = true;
      await this.changedSince();
    }
    this.applyEvent(event);
  }

  private applyEvent(event: FeedEvent): void {
    const key = resourceCacheKey(event.resource_type, event.id);
    const current = this.cache[event.resource_type].get(event.id);
    const pendingDelete = this.pendingDeletes.has(key);
    const previous = current?.value;
    if (pendingDelete && event.event === "delete") {
      this.pendingDeletes.delete(key);
      this.cache[event.resource_type].set(event.id, { version: event.version, deleted: true });
      this.lastVersion = Math.max(this.lastVersion, event.version);
      const alreadyNotified = this.locallyNotifiedDeletes.delete(key);
      if (!alreadyNotified) {
        this.notify(event, undefined, previous);
      }
      return;
    }
    if ((pendingDelete || current?.deleted) && event.event === "update") {
      this.lastVersion = Math.max(this.lastVersion, event.version);
      return;
    }
    if (event.version <= this.versionFor(event.resource_type, event.id)) {
      this.lastVersion = Math.max(this.lastVersion, event.version);
      return;
    }
    if (event.event === "delete") {
      this.pendingDeletes.delete(key);
      this.cache[event.resource_type].set(event.id, { version: event.version, deleted: true });
      this.lastVersion = Math.max(this.lastVersion, event.version);
      const alreadyNotified = this.locallyNotifiedDeletes.delete(key);
      if (!alreadyNotified) {
        this.notify(event, undefined, previous);
      }
      return;
    }
    const resource = event.resource as EntityResource | TaskResource | ObjectResource;
    this.cacheResource(event.resource_type, event.id, resource);
    this.lastVersion = Math.max(this.lastVersion, event.version);
    this.notify(event, resource, previous);
  }

  private applyRecoveredEvent(event: AtlasRecoveredWatchEvent): void {
    const key = resourceCacheKey(event.resource_type, event.id);
    const current = this.cache[event.resource_type].get(event.id);
    const previous = current?.value;
    if (this.pendingDeletes.has(key)) {
      this.lastVersion = Math.max(this.lastVersion, event.version);
      return;
    }
    if (event.version <= this.versionFor(event.resource_type, event.id)) {
      this.lastVersion = Math.max(this.lastVersion, event.version);
      return;
    }
    this.pendingDeletes.delete(key);
    this.locallyNotifiedDeletes.delete(key);
    this.cache[event.resource_type].set(event.id, { value: event.resource as any, version: event.version, deleted: false });
    this.lastVersion = Math.max(this.lastVersion, event.version);
    this.notify(event, event.resource, previous);
  }

  private cacheResource(type: ResourceType, id: string, value: EntityResource | TaskResource | ObjectResource): void {
    const version = value.metadata.version;
    const existing = this.cache[type].get(id);
    if (existing && existing.version >= version) {
      return;
    }
    this.pendingDeletes.delete(resourceCacheKey(type, id));
    this.locallyNotifiedDeletes.delete(resourceCacheKey(type, id));
    this.cache[type].set(id, { value: value as any, version, deleted: false });
    this.lastVersion = Math.max(this.lastVersion, version);
  }

  private versionFor(type: ResourceType, id: string): number {
    return this.cache[type].get(id)?.version ?? 0;
  }

  private async readEntity(id: string, options?: ReadOptions): Promise<EntityResource> {
    const cached = this.cache.entity.get(id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "entity", id }) && cached?.value && !cached.deleted) {
      return cached.value;
    }
    const entity = await this.http<EntityResource>("GET", `/entities/${encodeURIComponent(id)}`);
    this.cacheResource("entity", entity.entity_id, entity);
    return entity;
  }

  private async readTask(id: string, options?: ReadOptions): Promise<TaskResource> {
    const cached = this.cache.task.get(id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "task", id }) && cached?.value && !cached.deleted) {
      return cached.value;
    }
    const task = await this.http<TaskResource>("GET", `/tasks/${encodeURIComponent(id)}`);
    this.cacheResource("task", task.task_id, task);
    return task;
  }

  private async readObject(id: string, options?: ReadOptions): Promise<ObjectResource> {
    const cached = this.cache.object.get(id);
    if (!options?.fresh && this.canServeFromCache({ filter: "id", resource_type: "object", id }) && cached?.value && !cached.deleted) {
      return cached.value;
    }
    const object = await this.http<ObjectResource>("GET", `/objects/${encodeURIComponent(id)}`);
    this.cacheResource("object", object.object_id, object);
    return object;
  }

  private canServeFromCache(filter: AtlasSubscription): boolean {
    if (!this.syncRunning || !this.healthy || this.degraded) {
      return false;
    }
    return this.subscriptions.some((sub) => covers(sub, filter));
  }

  private async writeResource<T extends EntityResource | TaskResource | ObjectResource>(
    method: string,
    path: string,
    body: unknown,
    type: ResourceType,
    ifMatchVersion?: number
  ): Promise<T> {
    const resource = await this.http<T>(method, path, body, ifMatchVersion);
    const id = resourceID(type, resource);
    this.applyEvent({ event: method === "POST" ? "create" : "update", resource_type: type, id, version: resource.metadata.version, resource } as FeedEvent);
    return resource;
  }

  private async deleteResource(type: ResourceType, id: string, path: string): Promise<void> {
    await this.http<void>("DELETE", path);
    const previousVersion = this.cache[type].get(id)?.version ?? 0;
    const previous = this.cache[type].get(id)?.value;
    this.cache[type].set(id, { version: previousVersion, deleted: true });
    this.pendingDeletes.add(resourceCacheKey(type, id));
    this.locallyNotifiedDeletes.add(resourceCacheKey(type, id));
    this.notify(localDeleteEvent(type, id, previousVersion), undefined, previous);
  }

  private async objectContent(id: string): Promise<ArrayBuffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const object = await this.objects.get(id, { fresh: true });
      const key = `${id}@${object.metadata.version}`;
      const cached = this.objectContents.get(key);
      if (cached) {
        return cached;
      }
      const response = await this.raw("GET", `/objects/${encodeURIComponent(id)}/download`);
      const data = await response.arrayBuffer();
      const after = await this.objects.get(id, { fresh: true });
      if (after.metadata.version === object.metadata.version) {
        this.objectContents.set(key, data);
        return data;
      }
    }
    throw new Error(`Atlas object ${id} changed while downloading content; retry`);
  }

  private notify(
    event: AtlasWatchEvent,
    resource: EntityResource | TaskResource | ObjectResource | undefined,
    previous: EntityResource | TaskResource | ObjectResource | undefined
  ): void {
    for (const [key, callbacks] of this.watchers) {
      if (!matchesSubscription(parseSubscriptionKey(key), event, previous)) {
        continue;
      }
      for (const callback of callbacks) {
        callback(resource, event);
      }
    }
  }

  private assertRevision(actual: string): void {
    if (actual !== ATLAS_PROTOCOL_REVISION) {
      throw new ProtocolMismatchError(ATLAS_PROTOCOL_REVISION, actual);
    }
  }

  private async http<T>(method: string, path: string, body?: unknown, ifMatchVersion?: number): Promise<T> {
    const response = await this.raw(method, path, body, ifMatchVersion);
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async raw(method: string, path: string, body?: unknown, ifMatchVersion?: number): Promise<Response> {
    const headers = new Headers();
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("X-API-Key", this.apiKey);
    if (ifMatchVersion !== undefined) headers.set("If-Match", `"v${ifMatchVersion}"`);
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 409 || response.status === 412) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      throw new ConflictError(`Atlas write conflict (${response.status})`, response.status, payload);
    }
    if (!response.ok) {
      throw new Error(`Atlas request failed: ${response.status}`);
    }
    return response;
  }
}

function changedSinceToEvents(response: ChangedSinceResponse): AtlasWatchEvent[] {
  const events: AtlasWatchEvent[] = [];
  for (const entity of response.entities ?? []) {
    events.push({ event: "recovered", resource_type: "entity", id: entity.entity_id, version: entity.metadata.version, resource: entity });
  }
  for (const task of response.tasks ?? []) {
    events.push({ event: "recovered", resource_type: "task", id: task.task_id, version: task.metadata.version, resource: task });
  }
  for (const object of response.objects ?? []) {
    events.push({ event: "recovered", resource_type: "object", id: object.object_id, version: object.metadata.version, resource: object });
  }
  for (const item of response.deleted_entities ?? []) events.push({ event: "delete", resource_type: "entity", id: item.id, version: item.version });
  for (const item of response.deleted_tasks ?? []) {
    const event: TaskDeleteEvent = { event: "delete", resource_type: "task", id: item.id, version: item.version, entity_id: item.entity_id };
    events.push(event);
  }
  for (const item of response.deleted_objects ?? []) events.push({ event: "delete", resource_type: "object", id: item.id, version: item.version });
  return events;
}

function watchEventVersion(event: AtlasWatchEvent): number {
  return "version" in event ? event.version : 0;
}

function localDeleteEvent(type: ResourceType, id: string, previousVersion: number): AtlasLocalDeleteWatchEvent {
  const event: AtlasLocalDeleteWatchEvent = { event: "local_delete", resource_type: type, id };
  if (previousVersion > 0) {
    event.previous_version = previousVersion;
  }
  return event;
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

function subscriptionMessage(action: "subscribe" | "unsubscribe", filter: AtlasSubscription): FeedSubscribeMessage | FeedUnsubscribeMessage {
  return { action, ...filter } as FeedSubscribeMessage | FeedUnsubscribeMessage;
}

function subscriptionKey(filter: AtlasSubscription): string {
  switch (filter.filter) {
    case "all":
      return JSON.stringify(["all"]);
    case "id":
      return JSON.stringify(["id", filter.resource_type, filter.id]);
    case "type":
      return JSON.stringify(["type", filter.resource_type]);
    case "tasks_for_entity":
      return JSON.stringify(["tasks_for_entity", filter.entity_id]);
  }
}

function parseSubscriptionKey(key: string): AtlasSubscription {
  const [kind, resourceType, id] = JSON.parse(key) as string[];
  if (kind === "all") return { filter: "all" };
  if (kind === "id") return { filter: "id", resource_type: resourceType as ResourceType, id };
  if (kind === "type") return { filter: "type", resource_type: resourceType as ResourceType };
  return { filter: "tasks_for_entity", entity_id: resourceType };
}

function covers(covering: AtlasSubscription, wanted: AtlasSubscription): boolean {
  if (covering.filter === "all") return true;
  if (covering.filter === "type" && wanted.filter === "id") return covering.resource_type === wanted.resource_type;
  return subscriptionKey(covering) === subscriptionKey(wanted);
}

function matchesSubscription(filter: AtlasSubscription, event: AtlasWatchEvent, previous?: EntityResource | TaskResource | ObjectResource): boolean {
  switch (filter.filter) {
    case "all":
      return true;
    case "id":
      return event.resource_type === filter.resource_type && event.id === filter.id;
    case "type":
      return event.resource_type === filter.resource_type;
    case "tasks_for_entity":
      if (event.resource_type !== "task") {
        return false;
      }
      return (
        (event.event !== "delete" && event.event !== "local_delete" && (event.resource as TaskResource).entity_id === filter.entity_id) ||
        (event as FeedEvent & { entity_id?: string | null }).entity_id === filter.entity_id ||
        (event as FeedEvent & { previous_entity_id?: string | null }).previous_entity_id === filter.entity_id ||
        ((previous as TaskResource | undefined)?.entity_id ?? "") === filter.entity_id
      );
  }
}

function resourceID(type: ResourceType, resource: EntityResource | TaskResource | ObjectResource): string {
  if (type === "entity") return (resource as EntityResource).entity_id;
  if (type === "task") return (resource as TaskResource).task_id;
  return (resource as ObjectResource).object_id;
}

function resourceCacheKey(type: ResourceType, id: string): string {
  return JSON.stringify([type, id]);
}

function removeSocketListener(
  socket: WebSocketLike,
  type: "open" | "message" | "close" | "error",
  listener: (event: any) => void
): void {
  if (socket.removeEventListener) {
    socket.removeEventListener(type, listener);
    return;
  }
  if (socket.off) {
    socket.off(type, listener);
    return;
  }
  if (socket.removeListener) {
    socket.removeListener(type, listener);
    return;
  }
  if (shouldWarnForSocketCleanup()) {
    console.warn(`AtlasClient could not remove ${type} websocket startup listener`);
  }
}

function shouldWarnForSocketCleanup(): boolean {
  if (typeof process === "undefined") return true;
  return process.env?.NODE_ENV !== "production";
}

function feedUrl(baseUrl: string): string {
  return baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/feed";
}
