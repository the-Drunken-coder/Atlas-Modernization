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
  JSONValue,
  MapArea,
  ObjectCreateRequest,
  ObjectResource,
  ObjectUpdateRequest,
  PluginStatus,
  RuntimeReadyRequest,
  RuntimeRegistrationRequest,
  RuntimeStopRequest,
  RuntimeTaskDeliveryResponse,
  SpatialOperationResult,
  TaskCreateRequest,
  TaskProgressRequest,
  TaskResource
} from "./protocol.js";
import { isJSONValue, isMapArea, isPluginDiscoveryResponse, isSpatialOperationResult } from "./protocol.js";
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
  RuntimeContextOptions,
  SyncSnapshot,
  SyncSnapshotCallback,
  SyncStatus,
  TaskCancelOptions,
  TaskCompleteOptions,
  TaskCreateOptions,
  TaskFailOptions,
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
  isRuntimeTaskDeliveryResponse
} from "./validation.js";

export { ProtocolMismatchError } from "./feed-connection.js";
export { AtlasAPIError, AtlasTransportError, ConflictError, isAtlasAPIError, isAtlasTransportError } from "./http.js";
export type {
  ChangedSinceResponse,
  EntityCheckInFullResponse,
  EntityCheckInMinimalResponse,
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
  RuntimeContextOptions,
  SyncSnapshot,
  SyncSnapshotCallback,
  SyncStatus,
  TaskCancelOptions,
  TaskCompleteOptions,
  TaskCreateOptions,
  TaskFailOptions
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
    create: (entity: EntityCreateRequest, options?: { signal?: AbortSignal }) =>
      this.engine.writeResource(
        "POST",
        "/entities",
        entity,
        "entity",
        entity.entity_id,
        isEntityResource,
        undefined,
        undefined,
        options?.signal
      ),
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
    create: (task: TaskCreateRequest, options: TaskCreateOptions) =>
      this.engine.writeTask("POST", "/tasks", task, {
        requestHeaders: { "Idempotency-Key": normalizeOpaqueIdentifier("idempotencyKey", options.idempotencyKey) },
        signal: options.signal,
        eventName: "create"
      }),
    acknowledge: (id: string, options: RuntimeContextOptions) =>
      this.engine.writeTask(
        "POST",
        `/tasks/${encodeURIComponent(id)}/acknowledge`,
        {},
        { requestHeaders: runtimeHeaders(options.runtimeId), signal: options.signal, expectedID: id }
      ),
    start: (id: string, options: RuntimeContextOptions) =>
      this.engine.writeTask(
        "POST",
        `/tasks/${encodeURIComponent(id)}/start`,
        {},
        { requestHeaders: runtimeHeaders(options.runtimeId), signal: options.signal, expectedID: id }
      ),
    progress: (id: string, request: TaskProgressRequest, options: RuntimeContextOptions) =>
      this.engine.writeTask("POST", `/tasks/${encodeURIComponent(id)}/progress`, request, {
        requestHeaders: runtimeHeaders(options.runtimeId),
        signal: options.signal,
        expectedID: id
      }),
    complete: (id: string, options: TaskCompleteOptions) => {
      const request = options.output === undefined ? {} : { output: options.output };
      Object.setPrototypeOf(request, null);
      return this.engine.writeTask("POST", `/tasks/${encodeURIComponent(id)}/complete`, request, {
        requestHeaders: runtimeHeaders(options.runtimeId),
        signal: options.signal,
        expectedID: id
      });
    },
    fail: (id: string, options: TaskFailOptions) => {
      const failure = { code: options.failure.code, message: options.failure.message };
      Object.setPrototypeOf(failure, null);
      const request = { failure };
      Object.setPrototypeOf(request, null);
      return this.engine.writeTask("POST", `/tasks/${encodeURIComponent(id)}/fail`, request, {
        requestHeaders: runtimeHeaders(options.runtimeId),
        signal: options.signal,
        expectedID: id
      });
    },
    cancel: (id: string, options: TaskCancelOptions) =>
      this.engine.writeTask(
        "POST",
        `/tasks/${encodeURIComponent(id)}/cancel`,
        { cancellation: options.cancellation },
        { signal: options.signal, expectedID: id }
      ),
    watch: (id: string, callback: WatchCallback<TaskResource>) =>
      this.engine.watch({ filter: "id", resource_type: "task", id }, callback)
  };

  readonly runtime = {
    begin: (assetId: string, request: RuntimeRegistrationRequest, options?: { signal?: AbortSignal }) =>
      this.transport.empty(
        "POST",
        `/entities/${encodeURIComponent(assetId)}/runtime`,
        { ...request, runtime_id: normalizeOpaqueIdentifier("runtimeId", request.runtime_id) },
        undefined,
        options?.signal
      ),
    stop: (assetId: string, request: RuntimeStopRequest, options?: { signal?: AbortSignal }) =>
      this.transport.empty(
        "POST",
        `/entities/${encodeURIComponent(assetId)}/runtime/stop`,
        { ...request, runtime_id: normalizeOpaqueIdentifier("runtimeId", request.runtime_id) },
        undefined,
        options?.signal
      ),
    ready: (assetId: string, request: RuntimeReadyRequest, options?: { signal?: AbortSignal }) =>
      this.transport.empty(
        "POST",
        `/entities/${encodeURIComponent(assetId)}/runtime/ready`,
        { ...request, runtime_id: normalizeOpaqueIdentifier("runtimeId", request.runtime_id) },
        undefined,
        options?.signal
      ),
    tasks: (assetId: string, options: RuntimeContextOptions) =>
      this.transport.json(
        "GET",
        `/entities/${encodeURIComponent(assetId)}/runtime/tasks`,
        (value): value is RuntimeTaskDeliveryResponse =>
          isRuntimeTaskDeliveryResponse(value) && value.tasks.every((task) => task.asset_id === assetId),
        undefined,
        undefined,
        options.signal,
        runtimeHeaders(options.runtimeId)
      )
  };

  readonly objects = {
    get: (id: string, options?: ReadOptions) => this.engine.readObject(id, options),
    create: async (object: ObjectCreateRequest) =>
      this.engine.writeResource("POST", "/objects", object, "object", object.object_id, isObjectDetailResource),
    update: async (id: string, patch: ObjectUpdateRequest, options?: { ifMatchVersion?: number }) =>
      this.engine.writeResource(
        "PATCH",
        `/objects/${encodeURIComponent(id)}`,
        patch,
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

  readonly plugins = {
    list: (options?: { signal?: AbortSignal }): Promise<PluginStatus[]> =>
      this.transport.json("GET", "/plugins", isPluginDiscoveryResponse, undefined, undefined, options?.signal),
    invoke: (
      pluginId: string,
      operationId: string,
      input: JSONValue,
      options?: { signal?: AbortSignal }
    ): Promise<JSONValue> =>
      this.transport.json(
        "POST",
        `/plugins/${encodeURIComponent(pluginId)}/operations/${encodeURIComponent(operationId)}`,
        isJSONValue,
        input,
        undefined,
        options?.signal
      ),
    invokeSpatial: (
      pluginId: string,
      operationId: string,
      area: MapArea,
      options?: { signal?: AbortSignal }
    ): Promise<SpatialOperationResult> => {
      if (!isMapArea(area)) {
        throw new TypeError("Spatial Operation input must be a non-crossing map area no larger than 5 km²");
      }
      return this.transport.json(
        "POST",
        `/plugins/${encodeURIComponent(pluginId)}/operations/${encodeURIComponent(operationId)}`,
        isSpatialOperationResult,
        area,
        undefined,
        options?.signal
      );
    }
  };

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

  async handshake(options?: { signal?: AbortSignal }): Promise<void> {
    await this.engine.handshake(options?.signal);
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
      const data = await this.transport.arrayBuffer("GET", `/objects/${encodeURIComponent(id)}/download`);
      const after = await this.objects.get(id, { fresh: true });
      if (after.metadata.version === object.metadata.version) {
        this.objectContents.set(key, data);
        return data;
      }
    }
    throw new Error(`Atlas object ${id} changed while downloading content; retry`);
  }
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
  const fields = options?.fields === "minimal" ? "minimal" : undefined;
  const path = pathWithQuery(`/entities/${encodeURIComponent(id)}/checkin`, {
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

function createEntityCheckIn(engine: () => SyncEngine): EntityCheckInMethod {
  function checkIn(id: string, options: EntityCheckInOptions<"minimal">): Promise<EntityCheckInMinimalResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions<"full">): Promise<EntityCheckInFullResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse>;
  function checkIn(id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse> {
    const { path, body } = checkInRequest(id, options);
    return engine().checkInEntity(id, path, body, options?.fields ?? "full", options?.ifMatchVersion, options?.signal);
  }
  return checkIn;
}

function runtimeHeaders(runtimeId: string): HeadersInit {
  return { "Atlas-Runtime-ID": normalizeOpaqueIdentifier("runtimeId", runtimeId) };
}

function normalizeOpaqueIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must not be empty`);
  return normalized;
}
