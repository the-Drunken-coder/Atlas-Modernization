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
import { FeedConnectionManager } from "./feed-connection.js";
import { HttpTransport } from "./http.js";
import { SyncEngine } from "./sync-engine.js";
import type {
  AtlasSubscription,
  ChangedSinceQueryOptions,
  ChangedSinceResponse,
  EntityCheckInBody,
  EntityCheckInMethod,
  EntityCheckInOptions,
  EntityCheckInResponse,
  EntityCheckInMinimalTask,
  FetchLike,
  FullDatasetQueryOptions,
  FullDatasetResponse,
  ReadOptions,
  SyncSnapshot,
  SyncStatus,
  TaskCompleteOptions,
  TaskFailOptions,
  TaskLifecycleOptions,
  TaskStatus,
  TaskStatusOptions,
  WatchCallback,
  WebSocketCtor
} from "./types.js";

export type {
  AtlasLocalDeleteWatchEvent,
  AtlasRecoveredWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
  ChangedSinceQueryOptions,
  ChangedSinceResponse,
  EntityCheckInFields,
  EntityCheckInMethod,
  EntityCheckInMinimalTask,
  EntityCheckInOptions,
  EntityCheckInResponse,
  EntityCheckInTelemetry,
  FullDatasetQueryOptions,
  FullDatasetResponse,
  ReadOptions,
  SyncSnapshot,
  SyncStatus,
  TaskCompleteOptions,
  TaskFailOptions,
  TaskLifecycleOptions,
  TaskStatus,
  TaskStatusOptions
} from "./types.js";
export { AtlasAPIError, ConflictError } from "./http.js";
export { ProtocolMismatchError } from "./feed-connection.js";

export type AtlasClientOptions = {
  baseUrl: string;
  apiKey?: string;
  credentials?: RequestCredentials;
  fetch?: FetchLike;
  WebSocket?: WebSocketCtor;
  sync?: false | "all";
  pollIntervalMs?: number;
  objectContentCacheEntries?: number;
  requestTimeoutMs?: number;
  feedHandshakeTimeoutMs?: number;
};

export class AtlasClient {
  readonly entities = {
    get: (id: string, options?: ReadOptions) => this.engine.readEntity(id, options),
    create: (entity: EntityCreateRequest) => this.engine.writeResource("POST", "/entities", entity, "entity"),
    update: (id: string, patch: EntityUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource("PATCH", `/entities/${encodeURIComponent(id)}`, patch, "entity", options?.ifMatchVersion),
    delete: (id: string) => this.engine.deleteResource("entity", id, `/entities/${encodeURIComponent(id)}`),
    checkIn: ((id: string, options?: EntityCheckInOptions) => this.checkInEntity(id, options)) as EntityCheckInMethod,
    watch: (id: string, callback: WatchCallback<EntityResource>) => this.engine.watch({ filter: "id", resource_type: "entity", id }, callback)
  };

  readonly tasks = {
    get: (id: string, options?: ReadOptions) => this.engine.readTask(id, options),
    create: (task: TaskCreateRequest) => this.engine.writeResource("POST", "/tasks", task, "task"),
    update: (id: string, patch: TaskUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource("PATCH", `/tasks/${encodeURIComponent(id)}`, patch, "task", options?.ifMatchVersion),
    delete: (id: string) => this.engine.deleteResource("task", id, `/tasks/${encodeURIComponent(id)}`),
    acknowledge: (id: string, options?: TaskLifecycleOptions) =>
      this.engine.writeResource("POST", `/tasks/${encodeURIComponent(id)}/acknowledge`, {}, "task", options?.ifMatchVersion, "update"),
    complete: (id: string, options?: TaskCompleteOptions) =>
      this.engine.writeResource(
        "POST",
        `/tasks/${encodeURIComponent(id)}/complete`,
        options?.result === undefined ? {} : { result: options.result },
        "task",
        options?.ifMatchVersion,
        "update"
      ),
    fail: (id: string, options?: TaskFailOptions) =>
      this.engine.writeResource(
        "POST",
        `/tasks/${encodeURIComponent(id)}/fail`,
        options?.error === undefined ? {} : { error: options.error },
        "task",
        options?.ifMatchVersion,
        "update"
      ),
    setStatus: (id: string, status: TaskStatus, options?: TaskStatusOptions) =>
      this.engine.writeResource("POST", `/tasks/${encodeURIComponent(id)}/status`, taskStatusBody(status, options), "task", options?.ifMatchVersion, "update"),
    cancel: (id: string, options?: TaskLifecycleOptions) => this.tasks.setStatus(id, "cancelled", options),
    watch: (id: string, callback: WatchCallback<TaskResource>) => this.engine.watch({ filter: "id", resource_type: "task", id }, callback)
  };

  readonly objects = {
    get: (id: string, options?: ReadOptions) => this.engine.readObject(id, options),
    create: (object: ObjectCreateRequest) => this.engine.writeResource<"object", ObjectResponse>("POST", "/objects", object, "object"),
    update: (id: string, patch: ObjectUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource<"object", ObjectResponse>("PATCH", `/objects/${encodeURIComponent(id)}`, patch, "object", options?.ifMatchVersion),
    delete: (id: string) => this.engine.deleteResource("object", id, `/objects/${encodeURIComponent(id)}`),
    content: (id: string) => this.objectContent(id),
    watch: (id: string, callback: WatchCallback<ObjectResource>) => this.engine.watch({ filter: "id", resource_type: "object", id }, callback)
  };

  readonly queries = {
    full: (options?: FullDatasetQueryOptions) => this.transport.json<FullDatasetResponse>("GET", fullDatasetQueryPath(options)),
    changedSince: (sinceVersion: number, options?: ChangedSinceQueryOptions) =>
      this.transport.json<ChangedSinceResponse>("GET", changedSinceQueryPath(sinceVersion, options))
  };

  sync = {
    start: async () => {
      await this.engine.start();
    },
    stop: () => this.engine.stop(),
    snapshot: (): SyncSnapshot => this.engine.snapshot(),
    status: (): SyncStatus => this.engine.status()
  };

  private readonly transport: HttpTransport;
  private readonly objectContents: ObjectContentCache;
  private readonly engine: SyncEngine;

  constructor(options: AtlasClientOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) {
      throw new Error("AtlasClient requires a fetch implementation");
    }
    this.transport = new HttpTransport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      credentials: options.credentials,
      fetchImpl,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000
    });
    const feed = new FeedConnectionManager({
      baseUrl: this.transport.baseUrl,
      apiKey: options.apiKey,
      WebSocketImpl: options.WebSocket ?? globalThis.WebSocket,
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

  private async checkInEntity(id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse> {
    const { path, body } = checkInRequest(id, options);
    return this.engine.checkInEntity<EntityCheckInMinimalTask | TaskResource>(path, body, options?.ifMatchVersion);
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

function taskStatusBody(status: TaskStatus, options?: TaskStatusOptions): { status: TaskStatus; progress?: number; message?: string } {
  return {
    status,
    ...(options?.progress === undefined ? {} : { progress: options.progress }),
    ...(options?.message === undefined ? {} : { message: options.message })
  };
}

function checkInRequest(id: string, options?: EntityCheckInOptions): { path: string; body: EntityCheckInBody } {
  const body: EntityCheckInBody = {};
  if (options?.status !== undefined) body.status = options.status;
  if (options?.components !== undefined) body.components = options.components;
  if (options?.telemetry) {
    const { latitude, longitude, altitude_m, speed_m_s, heading_deg } = options.telemetry;
    if (latitude !== undefined) body.latitude = latitude;
    if (longitude !== undefined) body.longitude = longitude;
    if (altitude_m !== undefined) body.altitude_m = altitude_m;
    if (speed_m_s !== undefined) body.speed_m_s = speed_m_s;
    if (heading_deg !== undefined) body.heading_deg = heading_deg;
  }
  const statusFilter = options?.statusFilter && options.statusFilter.length > 0 ? options.statusFilter.join(",") : undefined;
  const fields = options?.fields === "minimal" ? "minimal" : undefined;
  const path = pathWithQuery(`/entities/${encodeURIComponent(id)}/checkin`, {
    status_filter: statusFilter,
    limit: options?.limit === undefined ? undefined : String(options.limit),
    task_cursor: options?.taskCursor,
    since: encodeTimestamp(options?.since),
    fields
  });
  return { path, body };
}

function fullDatasetQueryPath(options?: FullDatasetQueryOptions): string {
  return pathWithQuery("/queries/full", {
    entity_limit: options?.entityLimit === undefined ? undefined : String(options.entityLimit),
    task_limit: options?.taskLimit === undefined ? undefined : String(options.taskLimit),
    object_limit: options?.objectLimit === undefined ? undefined : String(options.objectLimit),
    entity_cursor: options?.entityCursor,
    task_cursor: options?.taskCursor,
    object_cursor: options?.objectCursor
  });
}

function changedSinceQueryPath(sinceVersion: number, options?: ChangedSinceQueryOptions): string {
  return pathWithQuery("/queries/changed-since", {
    since_version: String(sinceVersion),
    limit_per_type: options?.limitPerType === undefined ? undefined : String(options.limitPerType),
    entity_cursor: options?.entityCursor,
    task_cursor: options?.taskCursor,
    object_cursor: options?.objectCursor,
    deleted_entity_cursor: options?.deletedEntityCursor,
    deleted_task_cursor: options?.deletedTaskCursor,
    deleted_object_cursor: options?.deletedObjectCursor
  });
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

function encodeTimestamp(value: string | Date | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}
