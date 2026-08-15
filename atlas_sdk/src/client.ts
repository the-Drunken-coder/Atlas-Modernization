import { ObjectContentCache, ResourceCache } from "./cache.js";
import { FeedConnectionManager } from "./feed-connection.js";
import { HttpTransport } from "./http.js";
import type {
  CommandCatalog,
  EntityCheckInFullResponse,
  EntityCheckInMinimalResponse,
  EntityCheckInRequest,
  EntityCheckInResponse,
  EntityCreateRequest,
  EntityResource,
  EntityUpdateRequest,
  ObjectCreateRequest,
  ObjectResource,
  ObjectUpdateRequest,
  TaskCreateRequest,
  TaskResource,
  TaskUpdateRequest
} from "./protocol.js";
import { SyncEngine } from "./sync-engine.js";
import type {
  AtlasSubscription,
  ChangedSinceQueryOptions,
  EntityCheckInMethod,
  EntityCheckInOptions,
  FetchLike,
  FullDatasetQueryOptions,
  ReadOptions,
  ResourceForSubscription,
  SyncSnapshot,
  SyncSnapshotCallback,
  SyncStatus,
  TaskCompleteOptions,
  TaskFailOptions,
  TaskLifecycleOptions,
  TaskStatus,
  TaskStatusOptions,
  WatchCallback,
  WebSocketCtor
} from "./types.js";
import { pathWithQuery } from "./url.js";
import {
  changedSinceResponseValidator,
  isCommandCatalog,
  isEntityResource,
  isFullDatasetResponse,
  isObjectDetailResource,
  isTaskResource
} from "./validation.js";

export { ProtocolMismatchError } from "./feed-connection.js";
export { AtlasAPIError, ConflictError } from "./http.js";
export type {
  ChangedSinceResponse,
  EntityCheckInFullResponse,
  EntityCheckInMinimalResponse,
  EntityCheckInMinimalTask,
  EntityCheckInRequest,
  EntityCheckInResponse,
  FullDatasetResponse,
  ProtocolRevisionResponse
} from "./protocol.js";
export type {
  AtlasLocalDeleteWatchEvent,
  AtlasSubscription,
  AtlasWatchEvent,
  ChangedSinceQueryOptions,
  EntityCheckInFields,
  EntityCheckInMethod,
  EntityCheckInOptions,
  EntityCheckInTelemetry,
  FullDatasetQueryOptions,
  ReadOptions,
  ResourceForSubscription,
  SyncSnapshot,
  SyncSnapshotCallback,
  SyncStatus,
  TaskCompleteOptions,
  TaskFailOptions,
  TaskLifecycleOptions,
  TaskStatus,
  TaskStatusOptions
} from "./types.js";

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
  private readonly checkInEntity = createEntityCheckIn(() => this.engine);

  readonly entities = {
    get: (id: string, options?: ReadOptions) => this.engine.readEntity(id, options),
    create: (entity: EntityCreateRequest) =>
      this.engine.writeResource("POST", "/entities", entity, "entity", entity.entity_id, isEntityResource),
    update: (id: string, patch: EntityUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource(
        "PATCH",
        `/entities/${encodeURIComponent(id)}`,
        patch,
        "entity",
        id,
        isEntityResource,
        options?.ifMatchVersion
      ),
    delete: (id: string) => this.engine.deleteResource("entity", id, `/entities/${encodeURIComponent(id)}`),
    checkIn: this.checkInEntity,
    watch: (id: string, callback: WatchCallback<EntityResource>) =>
      this.engine.watch({ filter: "id", resource_type: "entity", id }, callback)
  };

  readonly tasks = {
    get: (id: string, options?: ReadOptions) => this.engine.readTask(id, options),
    create: (task: TaskCreateRequest, options?: { signal?: AbortSignal }) =>
      this.engine.writeResource(
        "POST",
        "/tasks",
        task,
        "task",
        "task_id" in task ? task.task_id : undefined,
        isTaskResource,
        undefined,
        undefined,
        options?.signal
      ),
    update: (id: string, patch: TaskUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource(
        "PATCH",
        `/tasks/${encodeURIComponent(id)}`,
        patch,
        "task",
        id,
        isTaskResource,
        options?.ifMatchVersion
      ),
    delete: (id: string) => this.engine.deleteResource("task", id, `/tasks/${encodeURIComponent(id)}`),
    acknowledge: (id: string, options?: TaskLifecycleOptions) =>
      this.tasks.update(id, { status: "acknowledged" }, options),
    complete: (id: string, options?: TaskCompleteOptions) =>
      this.tasks.update(
        id,
        {
          status: "completed",
          ...(options?.result === undefined ? {} : { extra: { result: options.result } })
        },
        options
      ),
    fail: (id: string, options?: TaskFailOptions) =>
      this.tasks.update(
        id,
        {
          status: "failed",
          ...(options?.error === undefined ? {} : { extra: { error: options.error } })
        },
        options
      ),
    setStatus: (id: string, status: TaskStatus, options?: TaskStatusOptions) =>
      this.tasks.update(id, taskStatusPatch(status, options), options),
    cancel: (id: string, options?: TaskLifecycleOptions) => this.tasks.setStatus(id, "cancelled", options),
    watch: (id: string, callback: WatchCallback<TaskResource>) =>
      this.engine.watch({ filter: "id", resource_type: "task", id }, callback)
  };

  readonly objects = {
    get: (id: string, options?: ReadOptions) => this.engine.readObject(id, options),
    create: async (object: ObjectCreateRequest) =>
      this.engine.writeResource(
        "POST",
        "/objects",
        validatedObjectRequest(object),
        "object",
        object.object_id,
        isObjectDetailResource
      ),
    update: async (id: string, patch: ObjectUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource(
        "PATCH",
        `/objects/${encodeURIComponent(id)}`,
        validatedObjectRequest(patch),
        "object",
        id,
        isObjectDetailResource,
        options?.ifMatchVersion
      ),
    delete: (id: string) => this.engine.deleteResource("object", id, `/objects/${encodeURIComponent(id)}`),
    content: (id: string) => this.objectContent(id),
    watch: (id: string, callback: WatchCallback<ObjectResource>) =>
      this.engine.watch({ filter: "id", resource_type: "object", id }, callback)
  };

  readonly queries = {
    full: (options?: FullDatasetQueryOptions) =>
      this.transport.json("GET", fullDatasetQueryPath(options), isFullDatasetResponse),
    changedSince: async (sinceVersion: number, options?: ChangedSinceQueryOptions) =>
      this.transport.json(
        "GET",
        changedSinceQueryPath(sinceVersion, options),
        changedSinceResponseValidator(sinceVersion)
      )
  };

  readonly commandCatalog = (): Promise<CommandCatalog> =>
    this.transport.json("GET", "/command-catalog", isCommandCatalog);

  sync = {
    start: async () => {
      await this.engine.start();
    },
    stop: () => this.engine.stop(),
    snapshot: (): SyncSnapshot => this.engine.snapshot(),
    watchSnapshot: (callback: SyncSnapshotCallback) => this.engine.watchSnapshot(callback),
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

  watch<TFilter extends AtlasSubscription>(
    filter: TFilter,
    callback: WatchCallback<ResourceForSubscription<TFilter>>
  ): () => void {
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

type TaskStatusComponents = {
  progress?: { percent: number };
  status_message?: string;
};

function taskStatusPatch(status: TaskStatus, options?: TaskStatusOptions): TaskUpdateRequest {
  const components: TaskStatusComponents = {
    ...(options?.progress === undefined ? {} : { progress: { percent: options.progress } }),
    ...(options?.message === undefined ? {} : { status_message: options.message })
  };
  return {
    status,
    ...(Object.keys(components).length === 0 ? {} : { components })
  };
}

function checkInRequest(id: string, options?: EntityCheckInOptions): { path: string; body: EntityCheckInRequest } {
  const body: EntityCheckInRequest = {};
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
  const statusFilter =
    options?.statusFilter && options.statusFilter.length > 0 ? options.statusFilter.join(",") : undefined;
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
  if (!Number.isSafeInteger(sinceVersion) || sinceVersion < 0) {
    throw new TypeError("Atlas changed-since sinceVersion must be a non-negative safe integer");
  }
  return pathWithQuery("/queries/changed-since", {
    since_version: String(sinceVersion),
    limit: options?.limit === undefined ? undefined : String(options.limit),
    cursor: options?.cursor
  });
}

function encodeTimestamp(value: string | Date | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function createEntityCheckIn(engine: () => SyncEngine): EntityCheckInMethod {
  function checkIn(id: string, options: EntityCheckInOptions<"minimal">): Promise<EntityCheckInMinimalResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions<"full">): Promise<EntityCheckInFullResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse> {
    const { path, body } = checkInRequest(id, options);
    return engine().checkInEntity(id, path, body, options?.fields ?? "full", options?.ifMatchVersion);
  }
  return checkIn;
}

function validatedObjectRequest<T extends ObjectCreateRequest | ObjectUpdateRequest>(request: T): T {
  if (typeof request.size_bytes === "number" && !Number.isSafeInteger(request.size_bytes)) {
    throw new TypeError("Atlas object request size_bytes must be a safe integer");
  }
  return request;
}
