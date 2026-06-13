import {
  ATLAS_PROTOCOL_REVISION,
  type AtlasSubscription,
  type EntityCreateRequest,
  type EntityResource,
  type EntityUpdateRequest,
  type ErrorCode,
  type ErrorResponse,
  type FeedEvent,
  type ObjectCreateRequest,
  type ObjectResource,
  type ObjectUpdateRequest,
  type TaskCreateRequest,
  type TaskResource,
  type TaskUpdateRequest
} from "../src";

type Listener = (event: any) => void;

export class FakeCore {
  revision = ATLAS_PROTOCOL_REVISION;
  version = 0;
  entities = new Map<string, EntityResource>();
  tasks = new Map<string, TaskResource>();
  objects = new Map<string, ObjectResource>();
  deletions: FeedEvent[] = [];
  events: FeedEvent[] = [];
  sockets = new Set<FakeWebSocket>();
  feedConnections = 0;
  requests: string[] = [];
  fullLimitPerType = 0;
  changedSinceLimitPerType = 0;
  private readonly recordedVersions = new Set<number>();
  rejectFeedAuth = false;
  failChangedSince = false;
  objectDownloadCount = 0;
  onObjectDownload: ((id: string) => void) | undefined;

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    this.requests.push(parsed.pathname + parsed.search);
    if (path === "/protocol/revision") return json({ protocol_revision: this.revision });
    if (path === "/queries/full") {
      const entityPage = pageValues([...this.entities.values()], this.fullLimitPerType, parsed.searchParams.get("entity_cursor"));
      const taskPage = pageValues([...this.tasks.values()], this.fullLimitPerType, parsed.searchParams.get("task_cursor"));
      const objectPage = pageValues([...this.objects.values()], this.fullLimitPerType, parsed.searchParams.get("object_cursor"));
      return json({
        entities: entityPage.items,
        tasks: taskPage.items,
        objects: objectPage.items,
        has_more_entities: entityPage.hasMore,
        has_more_tasks: taskPage.hasMore,
        has_more_objects: objectPage.hasMore,
        next_entity_cursor: entityPage.nextCursor,
        next_task_cursor: taskPage.nextCursor,
        next_object_cursor: objectPage.nextCursor
      });
    }
    if (path === "/queries/changed-since") {
      if (this.failChangedSince) {
        return protocolError("changed-since unavailable", "INTERNAL_SERVER_ERROR", 500);
      }
      const since = Number(parsed.searchParams.get("since_version") ?? 0);
      const changed = this.events.filter((event) => event.version > since);
      const entityPage = pageValues(changed.filter(isEntityUpsert).map((event) => event.resource), this.changedSinceLimitPerType, parsed.searchParams.get("entity_cursor"));
      const taskPage = pageValues(changed.filter(isTaskUpsert).map((event) => event.resource), this.changedSinceLimitPerType, parsed.searchParams.get("task_cursor"));
      const objectPage = pageValues(changed.filter(isObjectUpsert).map((event) => event.resource), this.changedSinceLimitPerType, parsed.searchParams.get("object_cursor"));
      const deletedEntityPage = pageValues(changed.filter(isDelete("entity")).map(deleted), this.changedSinceLimitPerType, parsed.searchParams.get("deleted_entity_cursor"));
      const deletedTaskPage = pageValues(changed.filter(isDelete("task")).map(deleted), this.changedSinceLimitPerType, parsed.searchParams.get("deleted_task_cursor"));
      const deletedObjectPage = pageValues(changed.filter(isDelete("object")).map(deleted), this.changedSinceLimitPerType, parsed.searchParams.get("deleted_object_cursor"));
      return json({
        entities: entityPage.items,
        tasks: taskPage.items,
        objects: objectPage.items,
        deleted_entities: deletedEntityPage.items,
        deleted_tasks: deletedTaskPage.items,
        deleted_objects: deletedObjectPage.items,
        has_more_entities: entityPage.hasMore,
        has_more_tasks: taskPage.hasMore,
        has_more_objects: objectPage.hasMore,
        has_more_deleted_entities: deletedEntityPage.hasMore,
        has_more_deleted_tasks: deletedTaskPage.hasMore,
        has_more_deleted_objects: deletedObjectPage.hasMore,
        next_entity_cursor: entityPage.nextCursor,
        next_task_cursor: taskPage.nextCursor,
        next_object_cursor: objectPage.nextCursor,
        next_deleted_entity_cursor: deletedEntityPage.nextCursor,
        next_deleted_task_cursor: deletedTaskPage.nextCursor,
        next_deleted_object_cursor: deletedObjectPage.nextCursor,
        version: this.version
      });
    }
    if (path.startsWith("/entities/") && init?.method === "GET") {
      return jsonOrNotFound(this.entities.get(decodeURIComponent(path.split("/")[2])), "entity not found");
    }
    if (path === "/entities" && init?.method === "POST") {
      const body = await readStrictBody<EntityCreateRequest>(init, entityCreateKeys);
      if (body instanceof Response) return body;
      return json(this.createEntity(body), 201);
    }
    if (path.startsWith("/entities/") && init?.method === "PATCH") {
      const id = decodeURIComponent(path.split("/")[2]);
      if (!this.entities.has(id)) {
        return protocolError("entity not found", "ENTITY_NOT_FOUND", 404);
      }
      if (init.headers instanceof Headers && init.headers.get("If-Match") === '"v0"') {
        return protocolError("precondition failed", "PRECONDITION_FAILED", 412);
      }
      const body = await readStrictBody<EntityUpdateRequest>(init, entityUpdateKeys);
      if (body instanceof Response) return body;
      return json(this.updateEntity(id, body));
    }
    if (path.startsWith("/entities/") && init?.method === "DELETE") {
      return this.deleteEntityResponse(decodeURIComponent(path.split("/")[2]));
    }
    if (path.startsWith("/tasks/") && init?.method === "GET") {
      return jsonOrNotFound(this.tasks.get(decodeURIComponent(path.split("/")[2])), "task not found");
    }
    if (path === "/tasks" && init?.method === "POST") {
      const body = await readStrictBody<TaskCreateRequest>(init, taskCreateKeys);
      if (body instanceof Response) return body;
      return json(this.createTask(body), 201);
    }
    if (path.startsWith("/tasks/") && init?.method === "PATCH") {
      const id = decodeURIComponent(path.split("/")[2]);
      if (!this.tasks.has(id)) {
        return protocolError("task not found", "TASK_NOT_FOUND", 404);
      }
      if (init.headers instanceof Headers && init.headers.get("If-Match") === '"v0"') {
        return protocolError("precondition failed", "PRECONDITION_FAILED", 412);
      }
      const body = await readStrictBody<TaskUpdateRequest>(init, taskUpdateKeys);
      if (body instanceof Response) return body;
      return json(this.updateTask(id, body));
    }
    if (path.startsWith("/tasks/") && init?.method === "DELETE") {
      return this.deleteTaskResponse(decodeURIComponent(path.split("/")[2]));
    }
    if (path.startsWith("/objects/") && path.endsWith("/download")) {
      const id = decodeURIComponent(path.split("/")[2]);
      this.objectDownloadCount++;
      this.onObjectDownload?.(id);
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (path.startsWith("/objects/") && init?.method === "GET") {
      return jsonOrNotFound(this.objects.get(decodeURIComponent(path.split("/")[2])), "object not found");
    }
    if (path === "/objects" && init?.method === "POST") {
      const body = await readStrictBody<ObjectCreateRequest>(init, objectCreateKeys);
      if (body instanceof Response) return body;
      return json(this.createObject(body), 201);
    }
    if (path.startsWith("/objects/") && init?.method === "PATCH") {
      const id = decodeURIComponent(path.split("/")[2]);
      if (!this.objects.has(id)) {
        return protocolError("object not found", "OBJECT_NOT_FOUND", 404);
      }
      if (init.headers instanceof Headers && init.headers.get("If-Match") === '"v0"') {
        return protocolError("precondition failed", "PRECONDITION_FAILED", 412);
      }
      const body = await readStrictBody<ObjectUpdateRequest>(init, objectUpdateKeys);
      if (body instanceof Response) return body;
      return json(this.updateObject(id, body));
    }
    if (path.startsWith("/objects/") && init?.method === "DELETE") {
      return this.deleteObjectResponse(decodeURIComponent(path.split("/")[2]));
    }
    return protocolError("not found", "VALIDATION_ERROR", 404);
  };

  attachWebSocketGlobal(): typeof FakeWebSocket {
    const owningCore = this;
    return class BoundFakeWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url, owningCore);
      }
    };
  }

  upsertEntity(entity: EntityResource): EntityResource {
    const version = this.nextVersion();
    const value = { ...entity, metadata: metadata(version) };
    this.entities.set(value.entity_id, value);
    this.record({ event: "update", resource_type: "entity", id: value.entity_id, version, resource: value });
    return value;
  }

  createEntity(request: EntityCreateRequest): EntityResource {
    const version = this.nextVersion();
    const value: EntityResource = {
      entity_id: request.entity_id,
      entity_type: request.entity_type,
      subtype: request.subtype ?? null,
      alias: request.alias ?? null,
      components: request.components ?? {},
      ...(request.extra === undefined ? {} : { extra: request.extra }),
      metadata: metadata(version)
    };
    this.record({ event: "create", resource_type: "entity", id: value.entity_id, version, resource: value });
    return value;
  }

  updateEntity(id: string, patch: EntityUpdateRequest): EntityResource {
    const current = this.entities.get(id);
    if (!current) {
      throw new Error(`fake core entity ${id} missing during update`);
    }
    return this.upsertEntity({
      ...current,
      ...(patch.entity_type === undefined ? {} : { entity_type: patch.entity_type }),
      ...(patch.subtype === undefined ? {} : { subtype: patch.subtype.trim() === "" ? null : patch.subtype }),
      ...(patch.alias === undefined ? {} : { alias: patch.alias.trim() === "" ? null : patch.alias }),
      components: patch.components === undefined ? current.components : { ...current.components, ...patch.components },
      ...(patch.extra === undefined ? {} : { extra: { ...(current.extra ?? {}), ...patch.extra } })
    });
  }

  upsertTask(task: TaskResource): TaskResource {
    const version = this.nextVersion();
    const value = { ...task, metadata: metadata(version) };
    this.tasks.set(value.task_id, value);
    this.record({ event: "update", resource_type: "task", id: value.task_id, version, resource: value });
    return value;
  }

  createTask(request: TaskCreateRequest): TaskResource {
    return this.recordTask(taskFromCreateRequest(request), "create");
  }

  updateTask(id: string, patch: TaskUpdateRequest): TaskResource {
    const current = this.tasks.get(id);
    if (!current) {
      throw new Error(`fake core task ${id} missing during update`);
    }
    const extra = { ...(current.extra ?? {}), ...(patch.extra ?? {}) };
    for (const key of patch.remove_extra_keys ?? []) {
      delete extra[key];
    }
    const next: TaskResource = {
      ...current,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.entity_id === undefined ? {} : { entity_id: patch.entity_id }),
      components: patch.components === undefined ? current.components : { ...current.components, ...patch.components }
    };
    if (Object.keys(extra).length > 0) {
      next.extra = extra;
    } else {
      delete next.extra;
    }
    return this.upsertTask(next);
  }

  upsertObject(object: ObjectResource): ObjectResource {
    const version = this.nextVersion();
    const value = { ...object, metadata: metadata(version) };
    this.objects.set(value.object_id, value);
    this.record({ event: "update", resource_type: "object", id: value.object_id, version, resource: value });
    return value;
  }

  createObject(request: ObjectCreateRequest): ObjectResource {
    const version = this.nextVersion();
    const value: ObjectResource = {
      object_id: request.object_id,
      path: request.path ?? null,
      content_type: request.content_type ?? null,
      type: request.type ?? null,
      size_bytes: request.size_bytes ?? null,
      usage_hints: request.usage_hints ?? [],
      ...(request.referenced_by === undefined ? {} : { referenced_by: request.referenced_by }),
      bucket: null,
      metadata: metadata(version)
    };
    this.record({ event: "create", resource_type: "object", id: value.object_id, version, resource: value });
    return value;
  }

  updateObject(id: string, patch: ObjectUpdateRequest): ObjectResource {
    const current = this.objects.get(id);
    if (!current) {
      throw new Error(`fake core object ${id} missing during update`);
    }
    return this.upsertObject({
      ...current,
      ...(patch.path === undefined ? {} : { path: patch.path }),
      ...(patch.content_type === undefined ? {} : { content_type: patch.content_type }),
      ...(patch.type === undefined ? {} : { type: patch.type }),
      ...(patch.size_bytes === undefined ? {} : { size_bytes: patch.size_bytes }),
      ...(patch.usage_hints === undefined ? {} : { usage_hints: patch.usage_hints }),
      ...(patch.referenced_by === undefined ? {} : { referenced_by: patch.referenced_by })
    });
  }

  deleteEntity(id: string): FeedEvent | undefined {
    if (!this.entities.has(id)) {
      return undefined;
    }
    const version = this.nextVersion();
    const event: FeedEvent = { event: "delete", resource_type: "entity", id, version };
    this.record(event);
    return event;
  }

  deleteTask(id: string): FeedEvent | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }
    const version = this.nextVersion();
    const event: FeedEvent = { event: "delete", resource_type: "task", id, version, entity_id: task.entity_id };
    this.record(event);
    return event;
  }

  deleteObject(id: string): FeedEvent | undefined {
    if (!this.objects.has(id)) {
      return undefined;
    }
    const version = this.nextVersion();
    const event: FeedEvent = { event: "delete", resource_type: "object", id, version };
    this.record(event);
    return event;
  }

  private deleteEntityResponse(id: string): Response {
    return this.deleteEntity(id) ? new Response(null, { status: 204 }) : protocolError("entity not found", "ENTITY_NOT_FOUND", 404);
  }

  private deleteTaskResponse(id: string): Response {
    return this.deleteTask(id) ? new Response(null, { status: 204 }) : protocolError("task not found", "TASK_NOT_FOUND", 404);
  }

  private deleteObjectResponse(id: string): Response {
    return this.deleteObject(id) ? new Response(null, { status: 204 }) : protocolError("object not found", "OBJECT_NOT_FOUND", 404);
  }

  emit(event: FeedEvent, options?: { dropForSockets?: boolean; beforeTaskEntityId?: string | null; record?: boolean }): void {
    if (options?.record !== false) {
      this.record(event);
    }
    if (options?.dropForSockets) return;
    for (const socket of this.sockets) {
      if (socket.subscribedTo(event, options?.beforeTaskEntityId)) {
        socket.receive(event);
      }
    }
  }

  private record(event: FeedEvent): void {
    if (this.recordedVersions.has(event.version)) {
      throw new Error(`duplicate fake core event version ${event.version} for ${event.resource_type}/${event.id}`);
    }
    this.recordedVersions.add(event.version);
    this.version = Math.max(this.version, event.version);
    this.events.push(event);
    if (event.event === "delete") {
      this.deletions.push(event);
      if (event.resource_type === "entity") this.entities.delete(event.id);
      if (event.resource_type === "task") this.tasks.delete(event.id);
      if (event.resource_type === "object") this.objects.delete(event.id);
      return;
    }
    if (event.resource_type === "entity") this.entities.set(event.id, event.resource as EntityResource);
    if (event.resource_type === "task") this.tasks.set(event.id, event.resource as TaskResource);
    if (event.resource_type === "object") this.objects.set(event.id, event.resource as ObjectResource);
  }

  private nextVersion(): number {
    this.version += 1;
    return this.version;
  }

  private recordTask(task: TaskResource, eventName: "create" | "update"): TaskResource {
    const version = this.nextVersion();
    const value = { ...task, metadata: metadata(version) };
    this.record({ event: eventName, resource_type: "task", id: value.task_id, version, resource: value });
    return value;
  }
}

class FakeWebSocket {
  readyState = 0;
  private listeners = new Map<string, Set<Listener>>();
  private subscriptions: AtlasSubscription[] = [];

  constructor(readonly url: string, private readonly core: FakeCore) {
    this.core.feedConnections++;
    this.core.sockets.add(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch("open", {});
      setTimeout(() => this.receive({ type: "hello", protocol_revision: this.core.revision }), 0);
    });
  }

  send(data: string): void {
    const parsed = JSON.parse(data);
    if (parsed.action === "auth" && this.core.rejectFeedAuth) {
      this.close();
      return;
    }
    if (parsed.action === "subscribe") this.subscriptions.push(parsed);
    if (parsed.action === "unsubscribe") {
      const key = subscriptionKey(parsed);
      this.subscriptions = this.subscriptions.filter((subscription) => subscriptionKey(subscription) !== key);
    }
  }

  close(): void {
    this.readyState = 3;
    this.core.sockets.delete(this);
    this.dispatch("close", {});
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(value: unknown): void {
    if (this.readyState !== 1) {
      return;
    }
    this.dispatch("message", { data: JSON.stringify(value) });
  }

  subscribedTo(event: FeedEvent, beforeTaskEntityId?: string | null): boolean {
    return this.subscriptions.some((subscription) => subscriptionMatches(subscription, event, beforeTaskEntityId));
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function entity(id: string): EntityResource {
  return { entity_id: id, entity_type: "asset", subtype: null, alias: null, components: {}, metadata: metadata(0) };
}

export function task(id: string, entity_id: string | null): TaskResource {
  return { task_id: id, status: "pending", entity_id, components: {}, metadata: metadata(0) };
}

export function taskFromCreateRequest(request: TaskCreateRequest): TaskResource {
  return {
    task_id: request.task_id,
    status: request.status ?? "pending",
    entity_id: request.entity_id ?? null,
    components: request.components ?? {},
    ...(request.extra === undefined ? {} : { extra: request.extra }),
    metadata: metadata(0)
  };
}

export function object(id: string): ObjectResource {
  return {
    object_id: id,
    path: null,
    content_type: null,
    type: "image",
    size_bytes: null,
    usage_hints: [],
    bucket: null,
    metadata: metadata(0)
  };
}

export function metadata(version: number) {
  return { created_at: "2026-06-12T12:00:00Z", updated_at: "2026-06-12T12:00:00Z", version };
}

const entityCreateKeys = new Set(["entity_id", "entity_type", "subtype", "alias", "components", "published_at", "updated_at", "extra"]);
const entityUpdateKeys = new Set(["entity_type", "subtype", "alias", "components", "extra"]);
const taskCreateKeys = new Set(["task_id", "status", "entity_id", "components", "extra"]);
const taskUpdateKeys = new Set(["status", "entity_id", "components", "extra", "remove_extra_keys"]);
const objectCreateKeys = new Set(["object_id", "path", "size_bytes", "content_type", "type", "usage_hints", "referenced_by", "extra"]);
const objectUpdateKeys = new Set(["path", "size_bytes", "content_type", "type", "usage_hints", "referenced_by", "extra"]);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function jsonOrNotFound(value: unknown, message: string): Response {
  if (value === undefined) {
    if (message.startsWith("entity")) return protocolError(message, "ENTITY_NOT_FOUND", 404);
    if (message.startsWith("task")) return protocolError(message, "TASK_NOT_FOUND", 404);
    if (message.startsWith("object")) return protocolError(message, "OBJECT_NOT_FOUND", 404);
    return protocolError(message, "VALIDATION_ERROR", 404);
  }
  return json(value);
}

async function readStrictBody<T>(init: RequestInit, allowedKeys: Set<string>): Promise<T | Response> {
  const value = await readBody<unknown>(init);
  if (!isRecord(value)) {
    return protocolError("Invalid JSON body", "INVALID_JSON", 400);
  }
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    return protocolError(`Invalid JSON body: unknown field ${unknownKey}`, "INVALID_JSON", 400);
  }
  return value as T;
}

async function readBody<T>(init: RequestInit): Promise<T> {
  return JSON.parse(String(init.body ?? "{}")) as T;
}

function protocolError(message: string, error_code: ErrorCode, status: number): Response {
  return json({ success: false, message, error_code } satisfies ErrorResponse, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntityUpsert(event: FeedEvent): event is FeedEvent & { resource: EntityResource } {
  return event.event !== "delete" && event.resource_type === "entity";
}

function isTaskUpsert(event: FeedEvent): event is FeedEvent & { resource: TaskResource } {
  return event.event !== "delete" && event.resource_type === "task";
}

function isObjectUpsert(event: FeedEvent): event is FeedEvent & { resource: ObjectResource } {
  return event.event !== "delete" && event.resource_type === "object";
}

function isDelete(type: "entity" | "task" | "object") {
  return (event: FeedEvent) => event.event === "delete" && event.resource_type === type;
}

function deleted(event: FeedEvent) {
  const value: { id: string; type: string; version: number; entity_id?: string | null } = { id: event.id, type: event.resource_type, version: event.version };
  if ("entity_id" in event && event.entity_id != null) value.entity_id = event.entity_id;
  return value;
}

function pageValues<T>(items: T[], limit: number, rawCursor: string | null): { items: T[]; hasMore: boolean; nextCursor?: string } {
  if (limit <= 0) {
    return { items, hasMore: false };
  }
  const offset = rawCursor ? Number(rawCursor) : 0;
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < items.length;
  return {
    items: page,
    hasMore,
    nextCursor: hasMore ? String(nextOffset) : undefined
  };
}

function subscriptionKey(filter: AtlasSubscription): string {
  switch (filter.filter) {
    case "all":
      return "all";
    case "id":
      return `id:${filter.resource_type}:${filter.id}`;
    case "type":
      return `type:${filter.resource_type}`;
    case "tasks_for_entity":
      return `tasks_for_entity:${filter.entity_id}`;
  }
}

function subscriptionMatches(filter: AtlasSubscription, event: FeedEvent, beforeTaskEntityId?: string | null): boolean {
  switch (filter.filter) {
    case "all":
      return true;
    case "id":
      return event.resource_type === filter.resource_type && event.id === filter.id;
    case "type":
      return event.resource_type === filter.resource_type;
    case "tasks_for_entity":
      return (
        event.resource_type === "task" &&
        (beforeTaskEntityId === filter.entity_id ||
          (event as FeedEvent & { entity_id?: string | null }).entity_id === filter.entity_id ||
          (event as FeedEvent & { previous_entity_id?: string | null }).previous_entity_id === filter.entity_id ||
          (event.event !== "delete" && (event.resource as TaskResource).entity_id === filter.entity_id))
      );
  }
}
