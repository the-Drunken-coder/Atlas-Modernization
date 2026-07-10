import type {
  EntityComponents,
  EntityResource,
  FeedEvent,
  JSONValue,
  ObjectResource,
  ResourceType,
  TaskDeleteEvent,
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

export type AtlasSubscription =
  | { filter: "all" }
  | { filter: "id"; resource_type: ResourceType; id: string }
  | { filter: "type"; resource_type: ResourceType }
  | { filter: "tasks_for_entity"; entity_id: string };

export type ReadOptions = {
  fresh?: boolean;
};

export type TaskStatus = "pending" | "acknowledged" | "completed" | "failed" | "cancelled";

export type TaskLifecycleOptions = {
  ifMatchVersion?: number;
};

export type TaskCompleteOptions = TaskLifecycleOptions & {
  result?: Record<string, JSONValue>;
};

export type TaskFailOptions = TaskLifecycleOptions & {
  error?: Record<string, JSONValue>;
};

export type TaskStatusOptions = TaskLifecycleOptions & {
  progress?: number;
  message?: string;
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
  statusFilter?: readonly TaskStatus[];
  limit?: number;
  taskCursor?: string;
  since?: string | Date;
  ifMatchVersion?: number;
};

export type EntityCheckInOptions<TFields extends EntityCheckInFields = EntityCheckInFields> = EntityCheckInBaseOptions &
  (TFields extends "minimal" ? { fields: "minimal" } : { fields?: TFields });

export type EntityCheckInBody = {
  status?: string;
  latitude?: number;
  longitude?: number;
  altitude_m?: number;
  speed_m_s?: number;
  heading_deg?: number;
  components?: EntityComponents;
};

export type EntityCheckInMinimalTask = {
  task_id: string;
  status: string;
  entity_id?: string;
  command_id?: string;
  parameters?: Record<string, JSONValue>;
};

export type EntityCheckInResponse<TTask extends TaskResource | EntityCheckInMinimalTask = TaskResource | EntityCheckInMinimalTask> = {
  entity: EntityResource;
  tasks: TTask[];
  task_count: number;
  task_limit: number;
  has_more_tasks: boolean;
  next_task_cursor?: string;
};

export type EntityCheckInMethod = {
  (id: string, options: EntityCheckInOptions<"minimal">): Promise<EntityCheckInResponse<EntityCheckInMinimalTask>>;
  (id: string, options?: EntityCheckInOptions<"full">): Promise<EntityCheckInResponse<TaskResource>>;
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
  limitPerType?: number;
  entityCursor?: string;
  taskCursor?: string;
  objectCursor?: string;
  deletedEntityCursor?: string;
  deletedTaskCursor?: string;
  deletedObjectCursor?: string;
};

export type SyncStatus = {
  running: boolean;
  healthy: boolean;
  degraded: boolean;
  lastVersion: number;
  subscriptions: AtlasSubscription[];
};

export type SyncSnapshot = {
  readonly entities: Readonly<Record<string, EntityResource>>;
  readonly tasks: Readonly<Record<string, TaskResource>>;
  readonly objects: Readonly<Record<string, ObjectResource>>;
};

export type ChangedSinceResponse = {
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

export type FullDatasetResponse = {
  entities: EntityResource[];
  tasks: TaskResource[];
  objects: ObjectResource[];
  version: number;
  has_more_entities?: boolean;
  has_more_tasks?: boolean;
  has_more_objects?: boolean;
  next_entity_cursor?: string;
  next_task_cursor?: string;
  next_object_cursor?: string;
};

export type DeletedResource = {
  id: string;
  type: ResourceType;
  version: number;
  entity_id?: string | null;
};

export type ResourceByType = {
  entity: EntityResource;
  task: TaskResource;
  object: ObjectResource;
};

export type ResourceValue = ResourceByType[ResourceType];
export type ResourceOf<TType extends ResourceType> = ResourceByType[TType];

export type AtlasRecoveredWatchEvent = {
  [TType in ResourceType]: {
    event: "recovered";
    resource_type: TType;
    id: string;
    version: number;
    resource: ResourceOf<TType>;
  };
}[ResourceType];

export type AtlasLocalDeleteWatchEvent = {
  [TType in ResourceType]: {
    event: "local_delete";
    resource_type: TType;
    id: string;
    previous_version?: number;
  };
}[ResourceType];

export type AtlasWatchEvent = FeedEvent | AtlasRecoveredWatchEvent | AtlasLocalDeleteWatchEvent;

type ChangedSinceWatchEvent = FeedEvent | AtlasRecoveredWatchEvent;

export type FullDatasetCursors = {
  entity_cursor?: string;
  task_cursor?: string;
  object_cursor?: string;
};

export type ChangedSinceCursors = FullDatasetCursors & {
  deleted_entity_cursor?: string;
  deleted_task_cursor?: string;
  deleted_object_cursor?: string;
};

export type WatchCallback<T extends ResourceValue = ResourceValue> = (value: T | undefined, event: AtlasWatchEvent) => void;

export type CacheEntry<T> = {
  value?: T;
  version: number;
  deleted: boolean;
  detail?: boolean;
};

export function changedSinceToEvents(response: ChangedSinceResponse): AtlasWatchEvent[] {
  const events: ChangedSinceWatchEvent[] = [
    ...(response.entities ?? []).map(
      (entity): ChangedSinceWatchEvent => ({ event: "recovered", resource_type: "entity", id: entity.entity_id, version: entity.metadata.version, resource: entity })
    ),
    ...(response.tasks ?? []).map(
      (task): ChangedSinceWatchEvent => ({ event: "recovered", resource_type: "task", id: task.task_id, version: task.metadata.version, resource: task })
    ),
    ...(response.objects ?? []).map(
      (object): ChangedSinceWatchEvent => ({ event: "recovered", resource_type: "object", id: object.object_id, version: object.metadata.version, resource: object })
    ),
    ...(response.deleted_entities ?? []).map((item): ChangedSinceWatchEvent => ({ event: "delete", resource_type: "entity", id: item.id, version: item.version })),
    ...(response.deleted_tasks ?? []).map((item): TaskDeleteEvent => ({
      event: "delete",
      resource_type: "task",
      id: item.id,
      version: item.version,
      entity_id: item.entity_id
    })),
    ...(response.deleted_objects ?? []).map((item): ChangedSinceWatchEvent => ({ event: "delete", resource_type: "object", id: item.id, version: item.version }))
  ];
  return events.sort((left, right) => left.version - right.version);
}
