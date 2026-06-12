import { ATLAS_PROTOCOL_REVISION, type EntityResource, type FeedEvent, type ObjectResource, type TaskResource } from "../src";

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

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/protocol/revision") return json({ protocol_revision: this.revision });
    if (path === "/queries/full") {
      return json({
        entities: [...this.entities.values()],
        tasks: [...this.tasks.values()],
        objects: [...this.objects.values()]
      });
    }
    if (path === "/queries/changed-since") {
      const since = Number(parsed.searchParams.get("since_version") ?? 0);
      const changed = this.events.filter((event) => event.version > since);
      return json({
        entities: changed.filter(isEntityUpsert).map((event) => event.resource),
        tasks: changed.filter(isTaskUpsert).map((event) => event.resource),
        objects: changed.filter(isObjectUpsert).map((event) => event.resource),
        deleted_entities: changed.filter(isDelete("entity")).map(deleted),
        deleted_tasks: changed.filter(isDelete("task")).map(deleted),
        deleted_objects: changed.filter(isDelete("object")).map(deleted),
        version: this.version
      });
    }
    if (path.startsWith("/entities/") && init?.method === "GET") {
      return json(this.entities.get(decodeURIComponent(path.split("/")[2])));
    }
    if (path === "/entities" && init?.method === "POST") {
      return json(this.upsertEntity(await readBody<EntityResource>(init)));
    }
    if (path.startsWith("/entities/") && init?.method === "PATCH") {
      if (init.headers instanceof Headers && init.headers.get("If-Match") === '"v0"') {
        return json({ error_code: "PRECONDITION_FAILED" }, 412);
      }
      const id = decodeURIComponent(path.split("/")[2]);
      return json(this.upsertEntity({ ...this.entities.get(id), ...(await readBody<Partial<EntityResource>>(init)) } as EntityResource));
    }
    if (path.startsWith("/tasks/") && init?.method === "GET") {
      return json(this.tasks.get(decodeURIComponent(path.split("/")[2])));
    }
    if (path === "/tasks" && init?.method === "POST") {
      return json(this.upsertTask(await readBody<TaskResource>(init)));
    }
    if (path.startsWith("/objects/") && path.endsWith("/download")) {
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (path.startsWith("/objects/") && init?.method === "GET") {
      return json(this.objects.get(decodeURIComponent(path.split("/")[2])));
    }
    return json({ error: "not found" }, 404);
  };

  WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url, currentCore);
    }
  };

  attachWebSocketGlobal(): typeof FakeWebSocket {
    currentCore = this;
    return this.WebSocket;
  }

  upsertEntity(entity: EntityResource): EntityResource {
    const version = this.nextVersion();
    const value = { ...entity, metadata: metadata(version) };
    this.entities.set(value.entity_id, value);
    this.record({ event: "update", resource_type: "entity", id: value.entity_id, version, resource: value });
    return value;
  }

  upsertTask(task: TaskResource): TaskResource {
    const version = this.nextVersion();
    const value = { ...task, metadata: metadata(version) };
    this.tasks.set(value.task_id, value);
    this.record({ event: "update", resource_type: "task", id: value.task_id, version, resource: value });
    return value;
  }

  upsertObject(object: ObjectResource): ObjectResource {
    const version = this.nextVersion();
    const value = { ...object, metadata: metadata(version) };
    this.objects.set(value.object_id, value);
    this.record({ event: "update", resource_type: "object", id: value.object_id, version, resource: value });
    return value;
  }

  emit(event: FeedEvent, options?: { dropForSockets?: boolean }): void {
    this.record(event);
    if (options?.dropForSockets) return;
    for (const socket of this.sockets) socket.receive(event);
  }

  private record(event: FeedEvent): void {
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
}

let currentCore: FakeCore;

class FakeWebSocket {
  readyState = 0;
  private listeners = new Map<string, Set<Listener>>();
  private subscriptions: unknown[] = [];

  constructor(readonly url: string, private readonly core: FakeCore) {
    this.core.sockets.add(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch("open", {});
      setTimeout(() => this.receive({ type: "hello", protocol_revision: this.core.revision }), 0);
    });
  }

  send(data: string): void {
    const parsed = JSON.parse(data);
    if (parsed.action === "subscribe") this.subscriptions.push(parsed);
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

  receive(value: unknown): void {
    this.dispatch("message", { data: JSON.stringify(value) });
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function readBody<T>(init: RequestInit): Promise<T> {
  return JSON.parse(String(init.body ?? "{}")) as T;
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
  return { id: event.id, type: event.resource_type, version: event.version };
}
