import type {
  EntityCheckInFullResponse,
  EntityCheckInMinimalResponse,
  EntityCheckInResponse,
  EntityComponents,
  EntityResource,
  FeedEvent,
  FeedSubscribeMessage,
  JSONValue,
  ObjectResource,
  ResourceType,
  TaskCancellation,
  TaskFailure,
  TaskResource
} from "./protocol.js";

export type FetchLike = typeof fetch;

export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener?(type: WebSocketEventType, listener: WebSocketListener): void;
  off?(type: WebSocketEventType, listener: WebSocketListener): void;
  removeListener?(type: WebSocketEventType, listener: WebSocketListener): void;
};

export type WebSocketCtor = new (url: string) => WebSocketLike;
export type WebSocketEventType = "open" | "message" | "close" | "error";
export type WebSocketEvent = { data?: unknown };
export type WebSocketListener = (event: WebSocketEvent) => void;

type WithoutAction<T extends { action: unknown }> = T extends unknown ? Omit<T, "action"> : never;

export type AtlasSubscription = WithoutAction<FeedSubscribeMessage>;

export type ReadOptions = {
  fresh?: boolean;
};

export type TaskCreateOptions = {
  idempotencyKey: string;
  signal?: AbortSignal;
};

export type RuntimeContextOptions = {
  runtimeId: string;
  signal?: AbortSignal;
};

export type TaskCompleteOptions = RuntimeContextOptions & {
  output?: JSONValue;
};

export type TaskFailOptions = RuntimeContextOptions & {
  failure: TaskFailure;
};

export type TaskCancelOptions = {
  cancellation: TaskCancellation;
  signal?: AbortSignal;
};

export type EntityCheckInFields = "full" | "minimal";

export type EntityCheckInTelemetry = {
  latitude?: number;
  longitude?: number;
  altitude_m?: number;
  speed_m_s?: number;
  heading_deg?: number;
};

type EntityCheckInBaseOptions = {
  status?: string;
  telemetry?: EntityCheckInTelemetry;
  components?: EntityComponents;
  ifMatchVersion?: number;
  signal?: AbortSignal;
};

export type EntityCheckInOptions<TFields extends EntityCheckInFields = EntityCheckInFields> = EntityCheckInBaseOptions &
  (TFields extends "minimal" ? { fields: "minimal" } : { fields?: TFields });

export type EntityCheckInMethod = {
  (id: string, options: EntityCheckInOptions<"minimal">): Promise<EntityCheckInMinimalResponse>;
  (id: string, options?: EntityCheckInOptions<"full">): Promise<EntityCheckInFullResponse>;
  (id: string, options?: EntityCheckInOptions): Promise<EntityCheckInResponse>;
};

export type FullDatasetQueryOptions = {
  entityLimit?: number;
  taskLimit?: number;
  objectLimit?: number;
  entityCursor?: string;
  taskCursor?: string;
  objectCursor?: string;
};

export type ChangedSinceQueryOptions = {
  limit?: number;
  cursor?: string;
};

export type SyncStatus = {
  running: boolean;
  healthy: boolean;
  degraded: boolean;
  error?: string;
  lastVersion: number;
  subscriptions: AtlasSubscription[];
};

export type SyncSnapshot = {
  readonly entities: Readonly<Record<string, EntityResource>>;
  readonly tasks: Readonly<Record<string, TaskResource>>;
  readonly objects: Readonly<Record<string, ObjectResource>>;
};

export type SyncSnapshotCallback = (snapshot: SyncSnapshot) => void;

export type ResourceByType = {
  entity: EntityResource;
  task: TaskResource;
  object: ObjectResource;
};

export type ResourceValue = ResourceByType[ResourceType];
export type ResourceOf<TType extends ResourceType> = ResourceByType[TType];
export type DeletableResourceType = Exclude<ResourceType, "task">;
export type ResourceForSubscription<TFilter extends AtlasSubscription> = TFilter extends { filter: "all" }
  ? ResourceValue
  : TFilter extends { filter: "tasks_for_asset" }
    ? TaskResource
    : TFilter extends { resource_type: infer TType extends ResourceType }
      ? ResourceOf<TType>
      : never;

export type AtlasLocalDeleteWatchEvent = {
  [TType in DeletableResourceType]: {
    event: "local_delete";
    resource_type: TType;
    id: string;
    previous_version?: number;
  };
}[DeletableResourceType];

export type AtlasWatchEvent = FeedEvent | AtlasLocalDeleteWatchEvent;

export type FullDatasetCursors = {
  entity_cursor?: string;
  task_cursor?: string;
  object_cursor?: string;
};

export type WatchCallback<T extends ResourceValue = ResourceValue> = (
  value: T | undefined,
  event: AtlasWatchEvent
) => void;

export type CacheEntry<T> = {
  value?: T;
  version: number;
  deleted: boolean;
  detail?: boolean;
};
