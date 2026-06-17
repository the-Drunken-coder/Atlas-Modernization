import type {
  EntityResource,
  FeedEvent,
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

export type SyncStatus = {
  running: boolean;
  healthy: boolean;
  degraded: boolean;
  lastVersion: number;
  subscriptions: AtlasSubscription[];
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

export type ResourceValue = EntityResource | TaskResource | ObjectResource;

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

export type WatchCallback<T> = (value: T | undefined, event: AtlasWatchEvent) => void;

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
