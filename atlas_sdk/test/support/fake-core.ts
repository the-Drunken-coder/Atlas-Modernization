import {
  ATLAS_PROTOCOL_REVISION,
  type CommandCatalog,
  type EntityCheckInRequest,
  type EntityComponents,
  type EntityCreateRequest,
  type EntityResource,
  type EntityUpdateRequest,
  type FeedEvent,
  type ObjectCreateRequest,
  type ObjectDetailResource,
  type ObjectResource,
  type ObjectUpdateRequest,
  type TaskCreateRequest,
  type TaskResource
} from "../../src";
import type { WebSocketCtor } from "../../src/types.js";
import { recordLedgerEvent } from "./event-ledger.js";
import { FakeWebSocket } from "./fake-websocket.js";
import { type FakeTaskResource, metadata, taskFromCreateRequest, withTaskMetadata } from "./fixtures.js";
import { InvalidCursorError, json, jsonOrNotFound, pageValues, protocolError, versionedJSON } from "./http.js";
import { readValidatedBody, requestValidators } from "./request-validation.js";

export { entity, metadata, object, task, taskFromCreateRequest } from "./fixtures.js";

export class FakeCore {
  revision = ATLAS_PROTOCOL_REVISION;
  version = 0;
  entities = new Map<string, EntityResource>();
  tasks = new Map<string, FakeTaskResource>();
  taskIdempotency = new Map<string, { request: string; task: FakeTaskResource }>();
  runtimes = new Map<string, { runtimeId: string; ready: boolean }>();
  objects = new Map<string, ObjectResource>();
  objectExtras = new Map<string, Record<string, unknown>>();
  deleteEvents: FeedEvent[] = [];
  events: FeedEvent[] = [];
  sockets = new Set<FakeWebSocket>();
  feedConnections = 0;
  requests: string[] = [];
  requestHeaders: Array<{
    path: string;
    ifMatch?: string | null;
    apiKey?: string | null;
    idempotencyKey?: string | null;
    runtimeId?: string | null;
  }> = [];
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
  readonly commandCatalog: CommandCatalog = [];

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const ifMatch = headers.get("If-Match");
    const apiKey = headers.get("X-API-Key");
    const idempotencyKey = headers.get("Idempotency-Key");
    const runtimeId = headers.get("Atlas-Runtime-ID");
    this.requests.push(parsed.pathname + parsed.search);
    this.requestHeaders.push({ path: parsed.pathname + parsed.search, ifMatch, apiKey, idempotencyKey, runtimeId });
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
    if (segments[0] === "tasks") return this.taskResponse(segments, method, init, idempotencyKey);
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
    if (segments.length === 3 && action === "runtime" && method === "POST") {
      const body = await readValidatedBody(init ?? {}, requestValidators.runtimeRegistration);
      if (body instanceof Response) return body;
      this.runtimes.set(id, { runtimeId: body.runtime_id, ready: false });
      return new Response(null, { status: 204 });
    }
    if (segments.length === 4 && action === "runtime" && segments[3] === "ready" && method === "POST") {
      const body = await readValidatedBody(init ?? {}, requestValidators.runtimeReady);
      if (body instanceof Response) return body;
      const runtime = this.runtimes.get(id);
      if (!runtime || runtime.runtimeId !== body.runtime_id) {
        return protocolError("stale runtime", "VALIDATION_ERROR", 400);
      }
      runtime.ready = true;
      return new Response(null, { status: 204 });
    }
    if (segments.length === 4 && action === "runtime" && segments[3] === "stop" && method === "POST") {
      const body = await readValidatedBody(init ?? {}, requestValidators.runtimeStop);
      if (body instanceof Response) return body;
      const runtime = this.runtimes.get(id);
      if (runtime?.runtimeId === body.runtime_id) runtime.ready = false;
      return new Response(null, { status: 204 });
    }
    if (segments.length === 4 && action === "runtime" && segments[3] === "tasks" && method === "GET") {
      const runtime = this.runtimes.get(id);
      if (!runtime || !runtime.ready) return protocolError("runtime not ready", "VALIDATION_ERROR", 400);
      return json({
        tasks: [...this.tasks.values()].filter((task) => task.asset_id === id && task.status === "pending")
      });
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
    idempotencyKey: string | null
  ): Promise<Response> {
    if (segments.length === 1 && method === "POST") {
      if (!idempotencyKey) return protocolError("Idempotency-Key is required", "VALIDATION_ERROR", 400);
      const body = await readValidatedBody<TaskCreateRequest>(init, requestValidators.taskCreate);
      if (body instanceof Response) return body;
      const encoded = JSON.stringify(body);
      const existing = this.taskIdempotency.get(idempotencyKey);
      if (existing) {
        if (existing.request !== encoded) return protocolError("idempotency key reused", "TASK_ALREADY_EXISTS", 409);
        const task = this.tasks.get(existing.task.task_id) ?? existing.task;
        return versionedJSON(task, task.metadata.version);
      }
      const task = this.createTask(body);
      this.taskIdempotency.set(idempotencyKey, { request: encoded, task });
      return versionedJSON(task, task.metadata.version, 201);
    }
    const [, id, action] = segments;
    if (!id) return protocolError("not found", "VALIDATION_ERROR", 404);
    if (segments.length === 2 && method === "GET") {
      const task = this.tasks.get(id);
      return task ? versionedJSON(task, task.metadata.version) : jsonOrNotFound(task, "task not found");
    }
    if (segments.length === 3 && method === "POST") {
      const current = this.tasks.get(id);
      if (!current) return protocolError("task not found", "TASK_NOT_FOUND", 404);
      switch (action) {
        case "acknowledge": {
          const body = await readValidatedBody(init ?? {}, requestValidators.taskAcknowledge);
          if (body instanceof Response) return body;
          const task = this.updateTask(id, { status: "acknowledged", acknowledged_at: now() });
          return versionedJSON(task, task.metadata.version);
        }
        case "start": {
          const body = await readValidatedBody(init ?? {}, requestValidators.taskStart);
          if (body instanceof Response) return body;
          const startedAt = now();
          const task = this.updateTask(id, {
            status: "in_progress",
            acknowledged_at: current.acknowledged_at ?? startedAt,
            started_at: startedAt
          });
          return versionedJSON(task, task.metadata.version);
        }
        case "progress": {
          const body = await readValidatedBody(init ?? {}, requestValidators.taskProgress);
          if (body instanceof Response) return body;
          const task = this.updateTask(id, { progress: body.progress });
          return versionedJSON(task, task.metadata.version);
        }
        case "complete": {
          const body = await readValidatedBody(init ?? {}, requestValidators.taskComplete);
          if (body instanceof Response) return body;
          const task = this.updateTask(id, { status: "completed", finished_at: now(), ...body });
          return versionedJSON(task, task.metadata.version);
        }
        case "fail": {
          const body = await readValidatedBody(init ?? {}, requestValidators.taskFail);
          if (body instanceof Response) return body;
          const task = this.updateTask(id, { status: "failed", failure: body.failure, finished_at: now() });
          return versionedJSON(task, task.metadata.version);
        }
        case "cancel": {
          const body = await readValidatedBody(init ?? {}, requestValidators.taskCancel);
          if (body instanceof Response) return body;
          const task = this.updateTask(id, {
            status: "cancelled",
            cancellation: body.cancellation,
            finished_at: now()
          });
          return versionedJSON(task, task.metadata.version);
        }
      }
    }
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

  upsertTask(task: TaskResource): FakeTaskResource {
    const version = this.nextVersion();
    const updatedAt = now();
    const value = withTaskMetadata(taskWithLifecycleFields({ ...task, updated_at: updatedAt }, updatedAt), version);
    this.tasks.set(value.task_id, value);
    this.record({ event: "update", resource_type: "task", id: value.task_id, version, resource: value });
    return value;
  }

  createTask(request: TaskCreateRequest): FakeTaskResource {
    return this.recordTask(taskFromCreateRequest(request), "create");
  }

  updateTask(id: string, patch: Partial<TaskResource>): FakeTaskResource {
    const current = this.tasks.get(id);
    if (!current) {
      throw new Error(`fake core task ${id} missing during update`);
    }
    return this.upsertTask({ ...current, ...patch });
  }

  private async checkInEntityResponse(
    id: string,
    _parsed: URL,
    init: RequestInit | undefined,
    ifMatch: string | null
  ): Promise<Response> {
    const current = this.entities.get(id);
    if (!current) return protocolError("entity not found", "ENTITY_NOT_FOUND", 404);
    const conflict = this.preconditionFailure(ifMatch, current.metadata.version);
    if (conflict) return conflict;
    const body = await readValidatedBody<EntityCheckInRequest>(
      init ?? {},
      requestValidators.entityCheckIn,
      "VALIDATION_ERROR"
    );
    if (body instanceof Response) return body;

    const timestamp = now();
    const components: EntityComponents = { ...(body.components ?? {}) };
    if (body.status !== undefined) {
      components.status = { value: body.status, last_update: timestamp };
    }
    const telemetry: Record<string, number | string> = {};
    for (const key of ["latitude", "longitude", "altitude_m", "speed_m_s", "heading_deg"] as const) {
      if (body[key] !== undefined) telemetry[key] = body[key];
    }
    if (Object.keys(telemetry).length > 0) {
      telemetry.last_update = timestamp;
      components.telemetry = telemetry;
    }
    components.heartbeat = { last_seen: timestamp };
    const updatedEntity = this.updateEntity(id, { components });
    return json({ entity: updatedEntity });
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

  private deleteObjectResponse(id: string): Response {
    return this.deleteObject(id)
      ? new Response(null, { status: 204 })
      : protocolError("object not found", "OBJECT_NOT_FOUND", 404);
  }

  emit(event: FeedEvent, options?: { dropForSockets?: boolean; record?: boolean }): void {
    if (options?.record !== false) {
      this.record(event);
    }
    if (options?.dropForSockets) return;
    for (const socket of this.sockets) {
      if (socket.subscribedTo(event)) {
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

  private recordTask(task: TaskResource, eventName: "create" | "update"): FakeTaskResource {
    const version = this.nextVersion();
    const value = withTaskMetadata(task, version);
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

function taskWithLifecycleFields(task: TaskResource, timestamp: string): TaskResource {
  switch (task.status) {
    case "acknowledged":
      return { ...task, acknowledged_at: task.acknowledged_at ?? timestamp };
    case "in_progress":
      return {
        ...task,
        acknowledged_at: task.acknowledged_at ?? timestamp,
        started_at: task.started_at ?? timestamp
      };
    case "completed":
      return {
        ...task,
        acknowledged_at: task.acknowledged_at ?? timestamp,
        started_at: task.started_at ?? timestamp,
        finished_at: task.finished_at ?? timestamp
      };
    case "failed":
    case "cancelled":
      return { ...task, finished_at: task.finished_at ?? timestamp };
    case "pending":
      return task;
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

function now(): string {
  return "2026-06-12T12:00:00Z";
}
