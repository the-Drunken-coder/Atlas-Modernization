import {
  ATLAS_PROTOCOL_REVISION,
  type CommandCatalog,
  type EntityCheckInRequest,
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
import { recordLedgerEvent } from "./event-ledger.js";
import { FakeWebSocket } from "./fake-websocket.js";
import { metadata, taskFromCreateRequest } from "./fixtures.js";
import { InvalidCursorError, json, jsonOrNotFound, pageValues, protocolError } from "./http.js";
import { readValidatedBody, requestValidators } from "./request-validation.js";

export { entity, metadata, object, task, taskFromCreateRequest } from "./fixtures.js";

export class FakeCore {
  revision = ATLAS_PROTOCOL_REVISION;
  version = 0;
  entities = new Map<string, EntityResource>();
  tasks = new Map<string, TaskResource>();
  objects = new Map<string, ObjectResource>();
  objectExtras = new Map<string, Record<string, unknown>>();
  deleteEvents: FeedEvent[] = [];
  events: FeedEvent[] = [];
  sockets = new Set<FakeWebSocket>();
  feedConnections = 0;
  requests: string[] = [];
  requestHeaders: Array<{ path: string; ifMatch?: string | null; apiKey?: string | null }> = [];
  feedAuthFrames: Array<{ apiKey?: string }> = [];
  expectedFeedApiKey: string | undefined;
  fullLimitPerType = 0;
  changedSinceLimit = 0;
  minRetainedVersion = 0;
  readonly recordedVersions = new Set<number>();
  rejectFeedAuth = false;
  onFeedSubscriptionBarrier: ((activateAndAcknowledge: () => void) => void) | undefined;
  failChangedSince = false;
  objectDownloadCount = 0;
  onObjectDownload: ((id: string) => void) | undefined;
  readonly commandCatalog: CommandCatalog = {
    type: "command_catalog",
    name: "Atlas Command Catalog",
    description: "Fake Core catalog",
    commands: [
      {
        id: "hold_position",
        name: "Hold Position",
        description: "Hold here.",
        parameters_schema: {}
      }
    ]
  };

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const ifMatch = headers.get("If-Match");
    const apiKey = headers.get("X-API-Key");
    this.requests.push(parsed.pathname + parsed.search);
    this.requestHeaders.push({ path: parsed.pathname + parsed.search, ifMatch, apiKey });
    let segments: string[];
    try {
      segments = path.split("/").slice(1).map(decodeURIComponent);
    } catch {
      return protocolError("Invalid URL path", "VALIDATION_ERROR", 400);
    }
    if (path === "/protocol/revision" && method === "GET") return json({ protocol_revision: this.revision });
    if (path === "/command-catalog" && method === "GET") return json(this.commandCatalog);
    if (path === "/queries/full" || path === "/queries/changed-since") return this.queryResponse(parsed, method);
    if (segments[0] === "entities") {
      return this.entityResponse(parsed, segments, method, init, ifMatch);
    }
    if (segments[0] === "tasks") return this.taskResponse(segments, method, init, ifMatch);
    if (segments[0] === "objects") return this.objectRouteResponse(segments, method, init, ifMatch);
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

  private queryResponse(parsed: URL, method: string): Response {
    if (method !== "GET") return protocolError("not found", "VALIDATION_ERROR", 404);
    try {
      return parsed.pathname === "/queries/full"
        ? this.fullQueryResponse(parsed)
        : this.changedSinceQueryResponse(parsed);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return protocolError(error.message, "VALIDATION_ERROR", 400);
      }
      throw error;
    }
  }

  private fullQueryResponse(parsed: URL): Response {
    const entityPage = pageValues(
      [...this.entities.values()],
      this.fullLimitPerType,
      parsed.searchParams.get("entity_cursor")
    );
    const taskPage = pageValues(
      [...this.tasks.values()],
      this.fullLimitPerType,
      parsed.searchParams.get("task_cursor")
    );
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
  }

  private changedSinceQueryResponse(parsed: URL): Response {
    if (this.failChangedSince) {
      return protocolError("changed-since unavailable", "INTERNAL_SERVER_ERROR", 500);
    }
    const rawSince = parsed.searchParams.get("since_version");
    const since = rawSince === null ? 0 : Number(rawSince);
    if (!Number.isInteger(since) || since < 0 || String(since) !== rawSince) {
      return protocolError("Invalid since_version parameter", "VALIDATION_ERROR", 400);
    }
    if (since < this.minRetainedVersion) {
      return protocolError("Changed-since cursor has expired; perform a full hydration", "CURSOR_EXPIRED", 410);
    }
    const cursor = changedSinceCursor(parsed.searchParams.get("cursor"), since, this.version);
    const changed = this.events.filter((event) => event.version > since && event.version <= cursor.snapshotVersion);
    const page = pageValues(changed, this.changedSinceLimit, String(cursor.offset));
    return json({
      events: page.items,
      has_more: page.hasMore,
      next_cursor: page.hasMore
        ? encodeChangedSinceCursor(since, cursor.snapshotVersion, cursor.offset + page.items.length)
        : undefined,
      version: cursor.snapshotVersion
    });
  }

  private async entityResponse(
    parsed: URL,
    segments: string[],
    method: string,
    init: RequestInit | undefined,
    ifMatch: string | null
  ): Promise<Response> {
    if (segments.length === 1 && method === "POST") {
      const body = await readValidatedBody<EntityCreateRequest>(init, requestValidators.entityCreate);
      if (body instanceof Response) return body;
      if (this.entities.has(body.entity_id)) {
        return protocolError("entity already exists", "ENTITY_ALREADY_EXISTS", 409);
      }
      return json(this.createEntity(body), 201);
    }
    const [, id, action] = segments;
    if (!id) return protocolError("not found", "VALIDATION_ERROR", 404);
    if (segments.length === 3 && action === "checkin" && method === "POST") {
      return this.checkInEntityResponse(id, parsed, init, ifMatch);
    }
    if (segments.length !== 2) return protocolError("not found", "VALIDATION_ERROR", 404);
    if (method === "GET") return jsonOrNotFound(this.entities.get(id), "entity not found");
    if (method === "PATCH") {
      const current = this.entities.get(id);
      if (!current) return protocolError("entity not found", "ENTITY_NOT_FOUND", 404);
      const conflict = this.preconditionFailure(ifMatch, current.metadata.version);
      if (conflict) return conflict;
      const body = await readValidatedBody<EntityUpdateRequest>(init, requestValidators.entityUpdate);
      return body instanceof Response ? body : json(this.updateEntity(id, body));
    }
    if (method === "DELETE") return this.deleteEntityResponse(id);
    return protocolError("not found", "VALIDATION_ERROR", 404);
  }

  private async taskResponse(
    segments: string[],
    method: string,
    init: RequestInit | undefined,
    ifMatch: string | null
  ): Promise<Response> {
    if (segments.length === 1 && method === "POST") {
      const body = await readValidatedBody<TaskCreateRequest>(init, requestValidators.taskCreate);
      if (body instanceof Response) return body;
      if ("task_id" in body && this.tasks.has(body.task_id)) {
        return protocolError("task already exists", "TASK_ALREADY_EXISTS", 409);
      }
      return json(this.createTask(body), 201);
    }
    const [, id] = segments;
    if (!id) return protocolError("not found", "VALIDATION_ERROR", 404);
    if (segments.length !== 2) return protocolError("not found", "VALIDATION_ERROR", 404);
    if (method === "GET") return jsonOrNotFound(this.tasks.get(id), "task not found");
    if (method === "PATCH") {
      const current = this.tasks.get(id);
      if (!current) return protocolError("task not found", "TASK_NOT_FOUND", 404);
      const conflict = this.preconditionFailure(ifMatch, current.metadata.version);
      if (conflict) return conflict;
      const body = await readValidatedBody<TaskUpdateRequest>(init, requestValidators.taskUpdate);
      return body instanceof Response ? body : json(this.updateTask(id, body));
    }
    if (method === "DELETE") return this.deleteTaskResponse(id);
    return protocolError("not found", "VALIDATION_ERROR", 404);
  }

  private async objectRouteResponse(
    segments: string[],
    method: string,
    init: RequestInit | undefined,
    ifMatch: string | null
  ): Promise<Response> {
    if (segments.length === 1 && method === "POST") {
      const body = await readValidatedBody<ObjectCreateRequest>(init, requestValidators.objectCreate);
      if (body instanceof Response) return body;
      if (this.objects.has(body.object_id)) {
        return protocolError("object already exists", "OBJECT_ALREADY_EXISTS", 409);
      }
      return json(this.createObject(body), 201);
    }
    const [, id, action] = segments;
    if (!id) return protocolError("not found", "VALIDATION_ERROR", 404);
    if (segments.length === 3 && action === "download" && method === "GET") {
      if (!this.objects.has(id)) return protocolError("object not found", "OBJECT_NOT_FOUND", 404);
      this.objectDownloadCount++;
      this.onObjectDownload?.(id);
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (segments.length !== 2) return protocolError("not found", "VALIDATION_ERROR", 404);
    if (method === "GET") return jsonOrNotFound(this.objectResponse(id), "object not found");
    if (method === "PATCH") {
      const current = this.objects.get(id);
      if (!current) return protocolError("object not found", "OBJECT_NOT_FOUND", 404);
      const conflict = this.preconditionFailure(ifMatch, current.metadata.version);
      if (conflict) return conflict;
      const body = await readValidatedBody<ObjectUpdateRequest>(init, requestValidators.objectUpdate);
      return body instanceof Response ? body : json(this.updateObject(id, body));
    }
    if (method === "DELETE") return this.deleteObjectResponse(id);
    return protocolError("not found", "VALIDATION_ERROR", 404);
  }

  private preconditionFailure(ifMatch: string | null, currentVersion: number): Response | undefined {
    return ifMatch !== null && ifMatch !== "*" && ifMatch !== `"v${currentVersion}"`
      ? protocolError("precondition failed", "PRECONDITION_FAILED", 412)
      : undefined;
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

  private async checkInEntityResponse(
    id: string,
    parsed: URL,
    init: RequestInit | undefined,
    ifMatch: string | null
  ): Promise<Response> {
    const current = this.entities.get(id);
    if (!current) return protocolError("entity not found", "ENTITY_NOT_FOUND", 404);
    const conflict = this.preconditionFailure(ifMatch, current.metadata.version);
    if (conflict) return conflict;
    const limit = Number(parsed.searchParams.get("limit") ?? "10");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      return protocolError("limit must be between 1 and 20", "VALIDATION_ERROR", 400);
    }
    const body = await readValidatedBody<EntityCheckInRequest>(
      init ?? {},
      requestValidators.entityCheckIn,
      "VALIDATION_ERROR"
    );
    if (body instanceof Response) return body;

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
      (value) =>
        value.entity_id === id &&
        statusFilter.includes(value.status) &&
        (sinceMs === undefined || Date.parse(value.metadata.updated_at) >= sinceMs)
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
      path: null,
      content_type: null,
      type: request.type ?? null,
      size_bytes: null,
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
      ...(patch.type === undefined ? {} : { type: patch.type }),
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
    return this.deleteEntity(id)
      ? new Response(null, { status: 204 })
      : protocolError("entity not found", "ENTITY_NOT_FOUND", 404);
  }

  private deleteTaskResponse(id: string): Response {
    return this.deleteTask(id)
      ? new Response(null, { status: 204 })
      : protocolError("task not found", "TASK_NOT_FOUND", 404);
  }

  private deleteObjectResponse(id: string): Response {
    return this.deleteObject(id)
      ? new Response(null, { status: 204 })
      : protocolError("object not found", "OBJECT_NOT_FOUND", 404);
  }

  emit(
    event: FeedEvent,
    options?: { dropForSockets?: boolean; beforeTaskEntityId?: string | null; record?: boolean }
  ): void {
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
    return { ...object, extra: { ...(this.objectExtras.get(object.object_id) ?? {}) } };
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

function changedSinceCursor(
  rawCursor: string | null,
  sinceVersion: number,
  currentVersion: number
): { snapshotVersion: number; offset: number } {
  if (rawCursor === null) {
    return { snapshotVersion: currentVersion, offset: 0 };
  }
  const match = /^changed:(\d+):(\d+):(\d+)$/.exec(rawCursor);
  if (!match) throw new InvalidCursorError(rawCursor);
  const [, rawSince, rawSnapshot, rawOffset] = match;
  const values = [rawSince, rawSnapshot, rawOffset].map(Number);
  if (values.some((value) => !Number.isSafeInteger(value)) || values[0] !== sinceVersion) {
    throw new InvalidCursorError(rawCursor);
  }
  return { snapshotVersion: values[1], offset: values[2] };
}

function encodeChangedSinceCursor(sinceVersion: number, snapshotVersion: number, offset: number): string {
  return `changed:${sinceVersion}:${snapshotVersion}:${offset}`;
}

const promotedObjectExtraKeys = new Set([
  "path",
  "content_type",
  "type",
  "size_bytes",
  "usage_hints",
  "bucket",
  "referenced_by",
  "version"
]);

function minimalTask(value: TaskResource): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    task_id: value.task_id,
    status: value.status
  };
  if (value.entity_id !== null) entry.entity_id = value.entity_id;
  const command = value.components.command;
  const commandID = firstNonEmptyString(
    (value.components as Record<string, unknown>).command_id,
    command?.id,
    command?.type,
    command
  );
  const parameters = firstRecord(
    value.components.parameters,
    value.components.target,
    command?.parameters,
    command?.target
  );
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
