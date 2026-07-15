import {
  ATLAS_PROTOCOL_REVISION,
  type EntityComponents,
  type EntityCreateRequest,
  type EntityResource,
  type EntityUpdateRequest,
  type FeedEvent,
  type JSONValue,
  type ObjectCreateRequest,
  type ObjectDetailResource,
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
import { InvalidCursorError, json, jsonOrNotFound, pageValues, protocolError, readBody } from "./http.js";
import { readValidatedBody, requestValidators } from "./request-validation.js";
export { entity, metadata, object, task, taskFromCreateRequest } from "./fixtures.js";

export class FakeCore {
  revision = ATLAS_PROTOCOL_REVISION;
  version = 0;
  entities = new Map<string, EntityResource>();
  tasks = new Map<string, TaskResource>();
  objects = new Map<string, ObjectResource>();
  objectExtras = new Map<string, Record<string, unknown>>();
  deletions: FeedEvent[] = [];
  events: FeedEvent[] = [];
  sockets = new Set<FakeWebSocket>();
  feedConnections = 0;
  requests: string[] = [];
  requestHeaders: Array<{ path: string; ifMatch?: string | null; apiKey?: string | null }> = [];
  feedAuthFrames: Array<{ apiKey?: string }> = [];
  expectedFeedApiKey: string | undefined;
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
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const ifMatch = headers.get("If-Match");
    const apiKey = headers.get("X-API-Key");
    this.requests.push(parsed.pathname + parsed.search);
    this.requestHeaders.push({ path: parsed.pathname + parsed.search, ifMatch, apiKey });
    if (path === "/protocol/revision" && method === "GET") return json({ protocol_revision: this.revision });
    if (path === "/queries/full" && method === "GET") {
      try {
        const entityPage = pageValues([...this.entities.values()], this.fullLimitPerType, parsed.searchParams.get("entity_cursor"));
        const taskPage = pageValues([...this.tasks.values()], this.fullLimitPerType, parsed.searchParams.get("task_cursor"));
        const objectPage = pageValues(
          [...this.objects.values()].map((object) => this.objectDetail(object)),
          this.fullLimitPerType,
          parsed.searchParams.get("object_cursor")
        );
        return json({
          entities: entityPage.items,
          tasks: taskPage.items,
          objects: objectPage.items,
          version: this.version,
          has_more_entities: entityPage.hasMore,
          has_more_tasks: taskPage.hasMore,
          has_more_objects: objectPage.hasMore,
          next_entity_cursor: entityPage.nextCursor,
          next_task_cursor: taskPage.nextCursor,
          next_object_cursor: objectPage.nextCursor
        });
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          return protocolError(error.message, "VALIDATION_ERROR", 400);
        }
        throw error;
      }
    }
    if (path === "/queries/changed-since" && method === "GET") {
      if (this.failChangedSince) {
        return protocolError("changed-since unavailable", "INTERNAL_SERVER_ERROR", 500);
      }
      const rawSince = parsed.searchParams.get("since_version");
      const since = rawSince === null ? 0 : Number(rawSince);
      if (!Number.isInteger(since) || since < 0 || String(since) !== rawSince) {
        return protocolError("Invalid since_version parameter", "VALIDATION_ERROR", 400);
      }
      const changed = this.events.filter((event) => event.version > since);
      try {
        const entityPage = pageValues(
          changed.filter(isEntityUpsert).map((event) => event.resource),
          this.changedSinceLimitPerType,
          parsed.searchParams.get("entity_cursor")
        );
        const taskPage = pageValues(
          changed.filter(isTaskUpsert).map((event) => event.resource),
          this.changedSinceLimitPerType,
          parsed.searchParams.get("task_cursor")
        );
        const objectPage = pageValues(
          changed.filter(isObjectUpsert).map((event) => this.objectDetail(event.resource)),
          this.changedSinceLimitPerType,
          parsed.searchParams.get("object_cursor")
        );
        const deletedEntityPage = pageValues(
          changed.filter(isDelete("entity")).map(deleted),
          this.changedSinceLimitPerType,
          parsed.searchParams.get("deleted_entity_cursor")
        );
        const deletedTaskPage = pageValues(
          changed.filter(isDelete("task")).map(deleted),
          this.changedSinceLimitPerType,
          parsed.searchParams.get("deleted_task_cursor")
        );
        const deletedObjectPage = pageValues(
          changed.filter(isDelete("object")).map(deleted),
          this.changedSinceLimitPerType,
          parsed.searchParams.get("deleted_object_cursor")
        );
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
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          return protocolError(error.message, "VALIDATION_ERROR", 400);
        }
        throw error;
      }
    }
    if (path.startsWith("/entities/") && path.endsWith("/checkin") && method === "POST") {
      return this.checkInEntityResponse(decodeURIComponent(path.split("/")[2]), parsed, init, ifMatch);
    }
    if (path.startsWith("/entities/") && method === "GET") {
      return jsonOrNotFound(this.entities.get(decodeURIComponent(path.split("/")[2])), "entity not found");
    }
    if (path === "/entities" && method === "POST") {
      const body = await readValidatedBody<EntityCreateRequest>(init, requestValidators.entityCreate);
      if (body instanceof Response) return body;
      if (this.entities.has(body.entity_id)) {
        return protocolError("entity already exists", "ENTITY_ALREADY_EXISTS", 409);
      }
      return json(this.createEntity(body), 201);
    }
    if (path.startsWith("/entities/") && method === "PATCH") {
      const id = decodeURIComponent(path.split("/")[2]);
      if (!this.entities.has(id)) {
        return protocolError("entity not found", "ENTITY_NOT_FOUND", 404);
      }
      if (ifMatch === '"v0"') {
        return protocolError("precondition failed", "PRECONDITION_FAILED", 412);
      }
      const body = await readValidatedBody<EntityUpdateRequest>(init, requestValidators.entityUpdate);
      if (body instanceof Response) return body;
      return json(this.updateEntity(id, body));
    }
    if (path.startsWith("/entities/") && method === "DELETE") {
      return this.deleteEntityResponse(decodeURIComponent(path.split("/")[2]));
    }
    if (path.startsWith("/tasks/") && method === "GET") {
      return jsonOrNotFound(this.tasks.get(decodeURIComponent(path.split("/")[2])), "task not found");
    }
    if (path === "/tasks" && method === "POST") {
      const body = await readValidatedBody<TaskCreateRequest>(init, requestValidators.taskCreate);
      if (body instanceof Response) return body;
      if (this.tasks.has(body.task_id)) {
        return protocolError("task already exists", "TASK_ALREADY_EXISTS", 409);
      }
      return json(this.createTask(body), 201);
    }
    if (path.startsWith("/tasks/") && method === "POST") {
      const [, , rawID, action] = path.split("/");
      return this.taskLifecycleResponse(decodeURIComponent(rawID), action, init, ifMatch);
    }
    if (path.startsWith("/tasks/") && method === "PATCH") {
      const id = decodeURIComponent(path.split("/")[2]);
      if (!this.tasks.has(id)) {
        return protocolError("task not found", "TASK_NOT_FOUND", 404);
      }
      if (ifMatch === '"v0"') {
        return protocolError("precondition failed", "PRECONDITION_FAILED", 412);
      }
      const body = await readValidatedBody<TaskUpdateRequest>(init, requestValidators.taskUpdate);
      if (body instanceof Response) return body;
      return json(this.updateTask(id, body));
    }
    if (path.startsWith("/tasks/") && method === "DELETE") {
      return this.deleteTaskResponse(decodeURIComponent(path.split("/")[2]));
    }
    if (path.startsWith("/objects/") && path.endsWith("/download") && method === "GET") {
      const id = decodeURIComponent(path.split("/")[2]);
      if (!this.objects.has(id)) {
        return protocolError("object not found", "OBJECT_NOT_FOUND", 404);
      }
      this.objectDownloadCount++;
      this.onObjectDownload?.(id);
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (path.startsWith("/objects/") && method === "GET") {
      return jsonOrNotFound(this.objectResponse(decodeURIComponent(path.split("/")[2])), "object not found");
    }
    if (path === "/objects" && method === "POST") {
      const body = await readValidatedBody<ObjectCreateRequest>(init, requestValidators.objectCreate);
      if (body instanceof Response) return body;
      if (this.objects.has(body.object_id)) {
        return protocolError("object already exists", "OBJECT_ALREADY_EXISTS", 409);
      }
      return json(this.createObject(body), 201);
    }
    if (path.startsWith("/objects/") && method === "PATCH") {
      const id = decodeURIComponent(path.split("/")[2]);
      if (!this.objects.has(id)) {
        return protocolError("object not found", "OBJECT_NOT_FOUND", 404);
      }
      if (ifMatch === '"v0"') {
        return protocolError("precondition failed", "PRECONDITION_FAILED", 412);
      }
      const body = await readValidatedBody<ObjectUpdateRequest>(init, requestValidators.objectUpdate);
      if (body instanceof Response) return body;
      return json(this.updateObject(id, body));
    }
    if (path.startsWith("/objects/") && method === "DELETE") {
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
    this.entities.set(value.entity_id, value);
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

  private async taskLifecycleResponse(id: string, action: string, init: RequestInit | undefined, ifMatch: string | null): Promise<Response> {
    if (!this.tasks.has(id)) {
      return protocolError("task not found", "TASK_NOT_FOUND", 404);
    }
    if (ifMatch === '"v0"') {
      return protocolError("precondition failed", "PRECONDITION_FAILED", 412);
    }
    if (action === "acknowledge") {
      return json(this.updateTask(id, { status: "acknowledged" }));
    }
    if (action === "complete") {
      const body = await readRecord(init);
      if (body instanceof Response) return body;
      if (body.result !== undefined && !isRecord(body.result)) {
        return protocolError("Invalid JSON body", "INVALID_JSON", 400);
      }
      return json(
        this.updateTask(id, { status: "completed", ...(body.result === undefined ? {} : { extra: { result: body.result as Record<string, JSONValue> } }) })
      );
    }
    if (action === "fail") {
      const body = await readRecord(init);
      if (body instanceof Response) return body;
      if (body.error !== undefined && !isRecord(body.error)) {
        return protocolError("Invalid JSON body", "INVALID_JSON", 400);
      }
      return json(
        this.updateTask(id, { status: "failed", ...(body.error === undefined ? {} : { extra: { error: body.error as Record<string, JSONValue> } }) })
      );
    }
    if (action === "status") {
      const body = await readRecord(init);
      if (body instanceof Response) return body;
      if (
        !isNonEmptyString(body.status) ||
        (body.progress !== undefined && !isFiniteNumber(body.progress)) ||
        (body.message !== undefined && typeof body.message !== "string")
      ) {
        return protocolError("Invalid JSON body", "INVALID_JSON", 400);
      }
      const components: TaskUpdateRequest["components"] = {};
      if (body.progress !== undefined) components.progress = { percent: clampPercent(body.progress) };
      if (body.message !== undefined) components.status_message = body.message;
      return json(
        this.updateTask(id, {
          status: body.status,
          ...(Object.keys(components).length === 0 ? {} : { components }),
          remove_extra_keys: ["progress", "status_message", "message"]
        })
      );
    }
    return protocolError("not found", "VALIDATION_ERROR", 404);
  }

  private async checkInEntityResponse(id: string, parsed: URL, init: RequestInit | undefined, ifMatch: string | null): Promise<Response> {
    if (!this.entities.has(id)) {
      return protocolError("entity not found", "ENTITY_NOT_FOUND", 404);
    }
    if (ifMatch === '"v0"') {
      return protocolError("precondition failed", "PRECONDITION_FAILED", 412);
    }
    const limit = Number(parsed.searchParams.get("limit") ?? "10");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      return protocolError("limit must be between 1 and 20", "VALIDATION_ERROR", 400);
    }
    const body = await readRecord(init);
    if (body instanceof Response) return body;
    if (!isCheckInBody(body)) {
      return protocolError("Invalid JSON body", "INVALID_JSON", 400);
    }

    const now = metadata(0).updated_at;
    const components: EntityComponents = { ...(body.components ?? {}) };
    if (body.status !== undefined) {
      components.status = { value: body.status, last_update: now };
    }
    const telemetry: Record<string, number | string> = {};
    for (const key of ["latitude", "longitude", "altitude_m", "speed_m_s", "heading_deg"] as const) {
      if (body[key] !== undefined) telemetry[key] = body[key];
    }
    if (Object.keys(telemetry).length > 0) {
      telemetry.last_update = now;
      components.telemetry = telemetry;
    }
    components.heartbeat = { last_seen: now };
    const updatedEntity = this.updateEntity(id, { components });

    const statusFilter = (parsed.searchParams.get("status_filter") || "pending,acknowledged")
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean);
    const since = parsed.searchParams.get("since");
    const sinceMs = since ? Date.parse(since) : undefined;
    if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
      return protocolError("Invalid since timestamp format (use RFC3339)", "VALIDATION_ERROR", 400);
    }
    const filteredTasks = [...this.tasks.values()].filter(
      (value) => value.entity_id === id && statusFilter.includes(value.status) && (sinceMs === undefined || Date.parse(value.metadata.updated_at) >= sinceMs)
    );
    const taskPage = pageValues(filteredTasks, limit, parsed.searchParams.get("task_cursor"));
    const tasks = parsed.searchParams.get("fields") === "minimal" ? taskPage.items.map(minimalTask) : taskPage.items;
    return json({
      entity: updatedEntity,
      tasks,
      task_count: tasks.length,
      task_limit: limit,
      has_more_tasks: taskPage.hasMore,
      next_task_cursor: taskPage.nextCursor
    });
  }

  upsertObject(object: ObjectResource): ObjectResource {
    const version = this.nextVersion();
    const value = { ...object, metadata: metadata(version) };
    this.objects.set(value.object_id, value);
    this.record({ event: "update", resource_type: "object", id: value.object_id, version, resource: value });
    return value;
  }

  createObject(request: ObjectCreateRequest): ObjectDetailResource {
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
    this.objects.set(value.object_id, value);
    this.applyObjectExtra(value.object_id, request.extra);
    this.record({ event: "create", resource_type: "object", id: value.object_id, version, resource: value });
    return this.objectResponse(value.object_id)!;
  }

  updateObject(id: string, patch: ObjectUpdateRequest): ObjectDetailResource {
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
    this.entities.delete(id);
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
    this.tasks.delete(id);
    this.record(event);
    return event;
  }

  deleteObject(id: string): FeedEvent | undefined {
    if (!this.objects.has(id)) {
      return undefined;
    }
    const version = this.nextVersion();
    const event: FeedEvent = { event: "delete", resource_type: "object", id, version };
    this.objects.delete(id);
    this.objectExtras.delete(id);
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
    this.tasks.set(value.task_id, value);
    this.record({ event: eventName, resource_type: "task", id: value.task_id, version, resource: value });
    return value;
  }

  private objectResponse(id: string): ObjectDetailResource | undefined {
    const object = this.objects.get(id);
    return object && this.objectDetail(object);
  }

  private objectDetail(object: ObjectResource): ObjectDetailResource {
    const extra = this.objectExtras.get(object.object_id);
    if (!extra || Object.keys(extra).length === 0) {
      return object;
    }
    return { ...object, extra: { ...extra } };
  }

  private applyObjectExtra(id: string, incoming: ObjectCreateRequest["extra"] | ObjectUpdateRequest["extra"]): void {
    if (incoming === undefined) {
      return;
    }
    const extra = { ...(this.objectExtras.get(id) ?? {}) };
    for (const [key, value] of Object.entries(incoming)) {
      if (!promotedObjectExtraKeys.has(key)) {
        extra[key] = value;
      }
    }
    if (Object.keys(extra).length > 0) {
      this.objectExtras.set(id, extra);
    } else {
      this.objectExtras.delete(id);
    }
  }
}

const promotedObjectExtraKeys = new Set(["path", "content_type", "type", "size_bytes", "usage_hints", "bucket", "referenced_by", "version"]);

async function readRecord(init: RequestInit | undefined): Promise<Record<string, unknown> | Response> {
  let value: unknown;
  try {
    value = await readBody<unknown>(init ?? {});
  } catch {
    return protocolError("Invalid JSON body", "INVALID_JSON", 400);
  }
  if (!isRecord(value)) {
    return protocolError("Invalid JSON body", "INVALID_JSON", 400);
  }
  return value;
}

function isCheckInBody(value: Record<string, unknown>): value is {
  status?: string;
  latitude?: number;
  longitude?: number;
  altitude_m?: number;
  speed_m_s?: number;
  heading_deg?: number;
  components?: EntityComponents;
} {
  const allowed = new Set(["status", "latitude", "longitude", "altitude_m", "speed_m_s", "heading_deg", "components"]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    (value.status === undefined || isNonEmptyString(value.status)) &&
    (value.latitude === undefined || isFiniteNumber(value.latitude)) &&
    (value.longitude === undefined || isFiniteNumber(value.longitude)) &&
    (value.altitude_m === undefined || isFiniteNumber(value.altitude_m)) &&
    (value.speed_m_s === undefined || isFiniteNumber(value.speed_m_s)) &&
    (value.heading_deg === undefined || isFiniteNumber(value.heading_deg)) &&
    (value.components === undefined || isRecord(value.components))
  );
}

function minimalTask(value: TaskResource): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    task_id: value.task_id,
    status: value.status
  };
  if (value.entity_id !== null) entry.entity_id = value.entity_id;
  const command = value.components.command;
  const commandID = firstNonEmptyString((value.components as Record<string, unknown>).command_id, command?.id, command?.type, command);
  const parameters = firstRecord(value.components.parameters, value.components.target, command?.parameters, command?.target);
  if (commandID) entry.command_id = commandID;
  if (parameters) entry.parameters = parameters;
  return entry;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function firstRecord(...values: unknown[]): Record<string, JSONValue> | undefined {
  for (const value of values) {
    if (isRecord(value)) {
      return value as Record<string, JSONValue>;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
