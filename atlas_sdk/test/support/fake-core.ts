import {
  ATLAS_PROTOCOL_REVISION,
  type EntityCreateRequest,
  type EntityResource,
  type EntityUpdateRequest,
  type FeedEvent,
  type ObjectCreateRequest,
  type ObjectResponse,
  type ObjectResource,
  type ObjectUpdateRequest,
  type TaskCreateRequest,
  type TaskResource,
  type TaskUpdateRequest
} from "../../src";
import type { WebSocketCtor } from "../../src/types.js";
import { deleted, isDelete, isEntityUpsert, isObjectUpsert, isTaskUpsert, recordLedgerEvent } from "./event-ledger.js";
import { FakeWebSocket } from "./fake-websocket.js";
import { metadata, taskFromCreateRequest } from "./fixtures.js";
import { json, jsonOrNotFound, pageValues, protocolError } from "./http.js";
import { readValidatedBody, requestValidators } from "./request-validation.js";
export { entity, metadata, object, task, taskFromCreateRequest } from "./fixtures.js";

export class FakeCore {
  revision = ATLAS_PROTOCOL_REVISION;
  version = 0;
  entities = new Map<string, EntityResource>();
  tasks = new Map<string, TaskResource>();
  objects = new Map<string, ObjectResource>();
  objectPayloads = new Map<string, Record<string, unknown>>();
  deletions: FeedEvent[] = [];
  events: FeedEvent[] = [];
  sockets = new Set<FakeWebSocket>();
  feedConnections = 0;
  requests: string[] = [];
  fullLimitPerType = 0;
  changedSinceLimitPerType = 0;
  readonly recordedVersions = new Set<number>();
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
      const rawSince = parsed.searchParams.get("since_version");
      const since = rawSince === null ? 0 : Number(rawSince);
      if (!Number.isInteger(since) || since < 0 || String(since) !== rawSince) {
        return protocolError("Invalid since_version parameter", "VALIDATION_ERROR", 400);
      }
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
      const body = await readValidatedBody<EntityCreateRequest>(init, requestValidators.entityCreate);
      if (body instanceof Response) return body;
      if (this.entities.has(body.entity_id)) {
        return protocolError("entity already exists", "ENTITY_ALREADY_EXISTS", 409);
      }
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
      const body = await readValidatedBody<EntityUpdateRequest>(init, requestValidators.entityUpdate);
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
      const body = await readValidatedBody<TaskCreateRequest>(init, requestValidators.taskCreate);
      if (body instanceof Response) return body;
      if (this.tasks.has(body.task_id)) {
        return protocolError("task already exists", "TASK_ALREADY_EXISTS", 409);
      }
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
      const body = await readValidatedBody<TaskUpdateRequest>(init, requestValidators.taskUpdate);
      if (body instanceof Response) return body;
      return json(this.updateTask(id, body));
    }
    if (path.startsWith("/tasks/") && init?.method === "DELETE") {
      return this.deleteTaskResponse(decodeURIComponent(path.split("/")[2]));
    }
    if (path.startsWith("/objects/") && path.endsWith("/download")) {
      const id = decodeURIComponent(path.split("/")[2]);
      if (!this.objects.has(id)) {
        return protocolError("object not found", "OBJECT_NOT_FOUND", 404);
      }
      this.objectDownloadCount++;
      this.onObjectDownload?.(id);
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (path.startsWith("/objects/") && init?.method === "GET") {
      return jsonOrNotFound(this.objectResponse(decodeURIComponent(path.split("/")[2])), "object not found");
    }
    if (path === "/objects" && init?.method === "POST") {
      const body = await readValidatedBody<ObjectCreateRequest>(init, requestValidators.objectCreate);
      if (body instanceof Response) return body;
      if (this.objects.has(body.object_id)) {
        return protocolError("object already exists", "OBJECT_ALREADY_EXISTS", 409);
      }
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
      const body = await readValidatedBody<ObjectUpdateRequest>(init, requestValidators.objectUpdate);
      if (body instanceof Response) return body;
      return json(this.updateObject(id, body));
    }
    if (path.startsWith("/objects/") && init?.method === "DELETE") {
      return this.deleteObjectResponse(decodeURIComponent(path.split("/")[2]));
    }
    return protocolError("not found", "VALIDATION_ERROR", 404);
  };

  attachWebSocketGlobal(): WebSocketCtor {
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
      ...(patch.subtype === undefined ? {} : { subtype: patch.subtype }),
      ...(patch.alias === undefined ? {} : { alias: patch.alias }),
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

  createObject(request: ObjectCreateRequest): ObjectResponse {
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
    this.applyObjectExtra(value.object_id, request.extra);
    this.record({ event: "create", resource_type: "object", id: value.object_id, version, resource: value });
    return this.objectResponse(value.object_id)!;
  }

  updateObject(id: string, patch: ObjectUpdateRequest): ObjectResponse {
    const current = this.objects.get(id);
    if (!current) {
      throw new Error(`fake core object ${id} missing during update`);
    }
    const value = this.upsertObject({
      ...current,
      ...(patch.path === undefined ? {} : { path: patch.path }),
      ...(patch.content_type === undefined ? {} : { content_type: patch.content_type }),
      ...(patch.type === undefined ? {} : { type: patch.type }),
      ...(patch.size_bytes === undefined ? {} : { size_bytes: patch.size_bytes }),
      ...(patch.usage_hints === undefined ? {} : { usage_hints: patch.usage_hints }),
      ...(patch.referenced_by === undefined ? {} : { referenced_by: patch.referenced_by })
    });
    this.applyObjectExtra(id, patch.extra);
    return this.objectResponse(value.object_id)!;
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
    recordLedgerEvent(this, event);
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

  private objectResponse(id: string): ObjectResponse | undefined {
    const object = this.objects.get(id);
    if (!object) {
      return undefined;
    }
    const payload = this.objectPayloads.get(id);
    if (!payload || Object.keys(payload).length === 0) {
      return object;
    }
    return { ...object, payload: { ...payload } };
  }

  private applyObjectExtra(id: string, extra: ObjectCreateRequest["extra"] | ObjectUpdateRequest["extra"]): void {
    if (extra === undefined) {
      return;
    }
    const payload = { ...(this.objectPayloads.get(id) ?? {}) };
    for (const [key, value] of Object.entries(extra)) {
      if (!promotedObjectPayloadKeys.has(key)) {
        payload[key] = value;
      }
    }
    if (Object.keys(payload).length > 0) {
      this.objectPayloads.set(id, payload);
    } else {
      this.objectPayloads.delete(id);
    }
  }
}

const promotedObjectPayloadKeys = new Set(["path", "content_type", "type", "size_bytes", "usage_hints", "bucket", "referenced_by", "version"]);
