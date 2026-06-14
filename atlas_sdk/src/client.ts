import type {
  EntityCreateRequest,
  EntityResource,
  EntityUpdateRequest,
  ObjectCreateRequest,
  ObjectResponse,
  ObjectResource,
  ObjectUpdateRequest,
  TaskCreateRequest,
  TaskResource,
  TaskUpdateRequest
} from "./protocol.js";
import { ObjectContentCache, ResourceCache } from "./cache.js";
import { FeedConnectionManager, ProtocolMismatchError } from "./feed-connection.js";
import { AtlasAPIError, ConflictError, HttpTransport } from "./http.js";
import { SyncEngine } from "./sync-engine.js";
import type {
  AtlasLocalDeleteWatchEvent,
  AtlasRecoveredWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
  FetchLike,
  ReadOptions,
  SyncStatus,
  WatchCallback,
  WebSocketCtor
} from "./types.js";

export type {
  AtlasLocalDeleteWatchEvent,
  AtlasRecoveredWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
  ReadOptions,
  SyncStatus
} from "./types.js";
export { AtlasAPIError, ConflictError } from "./http.js";
export { ProtocolMismatchError } from "./feed-connection.js";

export type AtlasClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: FetchLike;
  WebSocket?: WebSocketCtor;
  sync?: false | "all" | "selective";
  pollIntervalMs?: number;
  objectContentCacheEntries?: number;
  requestTimeoutMs?: number;
  feedHandshakeTimeoutMs?: number;
};

export class AtlasClient {
  readonly entities = {
    get: (id: string, options?: ReadOptions) => this.engine.readEntity(id, options),
    create: (entity: EntityCreateRequest) => this.engine.writeResource<EntityResource>("POST", "/entities", entity, "entity"),
    update: (id: string, patch: EntityUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource<EntityResource>("PATCH", `/entities/${encodeURIComponent(id)}`, patch, "entity", options?.ifMatchVersion),
    delete: (id: string) => this.engine.deleteResource("entity", id, `/entities/${encodeURIComponent(id)}`),
    watch: (id: string, callback: WatchCallback<EntityResource>) => this.engine.watch({ filter: "id", resource_type: "entity", id }, callback)
  };

  readonly tasks = {
    get: (id: string, options?: ReadOptions) => this.engine.readTask(id, options),
    create: (task: TaskCreateRequest) => this.engine.writeResource<TaskResource>("POST", "/tasks", task, "task"),
    update: (id: string, patch: TaskUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource<TaskResource>("PATCH", `/tasks/${encodeURIComponent(id)}`, patch, "task", options?.ifMatchVersion),
    delete: (id: string) => this.engine.deleteResource("task", id, `/tasks/${encodeURIComponent(id)}`),
    watch: (id: string, callback: WatchCallback<TaskResource>) => this.engine.watch({ filter: "id", resource_type: "task", id }, callback)
  };

  readonly objects = {
    get: (id: string, options?: ReadOptions) => this.engine.readObject(id, options),
    create: (object: ObjectCreateRequest) => this.engine.writeResource<ObjectResponse>("POST", "/objects", object, "object"),
    update: (id: string, patch: ObjectUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource<ObjectResponse>("PATCH", `/objects/${encodeURIComponent(id)}`, patch, "object", options?.ifMatchVersion),
    delete: (id: string) => this.engine.deleteResource("object", id, `/objects/${encodeURIComponent(id)}`),
    content: (id: string) => this.objectContent(id),
    watch: (id: string, callback: WatchCallback<ObjectResource>) => this.engine.watch({ filter: "id", resource_type: "object", id }, callback)
  };

  sync = {
    start: async () => {
      await this.engine.start();
    },
    stop: () => this.engine.stop(),
    status: (): SyncStatus => this.engine.status()
  };

  private readonly transport: HttpTransport;
  private readonly objectContents: ObjectContentCache;
  private readonly engine: SyncEngine;

  constructor(options: AtlasClientOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("AtlasClient requires a fetch implementation");
    }
    this.transport = new HttpTransport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      fetchImpl,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000
    });
    const feed = new FeedConnectionManager({
      baseUrl: this.transport.baseUrl,
      apiKey: options.apiKey,
      WebSocketImpl: options.WebSocket ?? (globalThis as any).WebSocket,
      feedHandshakeTimeoutMs: options.feedHandshakeTimeoutMs ?? 5_000
    });
    this.objectContents = new ObjectContentCache(options.objectContentCacheEntries ?? 64);
    this.engine = new SyncEngine({
      transport: this.transport,
      feed,
      cache: new ResourceCache(),
      pollIntervalMs: options.pollIntervalMs ?? 120_000,
      initialSync: options.sync
    });
  }

  async handshake(): Promise<void> {
    await this.engine.handshake();
  }

  async subscribe(filter: AtlasSubscription): Promise<void> {
    await this.engine.subscribe(filter);
  }

  async unsubscribe(filter: AtlasSubscription): Promise<void> {
    await this.engine.unsubscribe(filter);
  }

  watch<T extends EntityResource | TaskResource | ObjectResource>(filter: AtlasSubscription, callback: WatchCallback<T>): () => void {
    return this.engine.watch(filter, callback);
  }

  async connectFeed(): Promise<void> {
    await this.engine.connectFeed();
  }

  async changedSince(): Promise<void> {
    await this.engine.changedSince();
  }

  async connectAndRecoverFeed(): Promise<void> {
    await this.engine.connectAndRecoverFeed();
  }

  private async objectContent(id: string): Promise<ArrayBuffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const object = await this.objects.get(id, { fresh: true });
      const key = `${id}@${object.metadata.version}`;
      const cached = this.objectContents.get(key);
      if (cached) {
        return cached;
      }
      const response = await this.transport.raw("GET", `/objects/${encodeURIComponent(id)}/download`);
      const data = await response.arrayBuffer();
      const after = await this.objects.get(id, { fresh: true });
      if (after.metadata.version === object.metadata.version) {
        this.objectContents.set(key, data);
        return data;
      }
    }
    throw new Error(`Atlas object ${id} changed while downloading content; retry`);
  }
}
