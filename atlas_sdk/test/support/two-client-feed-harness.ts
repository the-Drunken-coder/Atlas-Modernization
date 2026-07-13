import { AtlasClient, type EntityResource, type FeedEvent, type ObjectResource, type ResourceType, type TaskResource } from "../../src";
import type { FetchLike } from "../../src/types.js";
import { FakeCore } from "./fake-core.js";

export type TwoClientFeedHarness = {
  core: FakeCore;
  writer: AtlasClient;
  receiver: AtlasClient;
  stop(): void;
};

export function createTwoClientFeedHarness(): TwoClientFeedHarness {
  const core = new FakeCore();
  const writer = new AtlasClient({
    baseUrl: "http://atlas.test",
    fetch: writerFetch(core),
    sync: false,
    pollIntervalMs: 0
  });
  const receiver = new AtlasClient({
    baseUrl: "http://atlas.test",
    fetch: core.fetch,
    WebSocket: core.attachWebSocketGlobal(),
    sync: "all",
    pollIntervalMs: 0
  });

  return {
    core,
    writer,
    receiver,
    stop: () => {
      writer.sync.stop();
      receiver.sync.stop();
    }
  };
}

function writerFetch(core: FakeCore): FetchLike {
  return async (url, init) => {
    const route = writeRoute(url, init);
    const deletionCount = core.deletions.length;
    const response = await core.fetch(String(url), init);
    if (!response.ok || !route) {
      return response;
    }
    if (route.kind === "delete") {
      const event = core.deletions.slice(deletionCount).find((value) => value.resource_type === route.resource_type && value.id === route.id);
      if (event) {
        core.emit(event, { record: false });
      }
      return response;
    }
    const resource = await readResource(response.clone(), route.resource_type);
    if (resource) {
      core.emit(upsertEvent(route.event, route.resource_type, resource), { record: false });
    }
    return response;
  };
}

type WriteRoute =
  | { kind: "upsert"; event: "create" | "update"; resource_type: ResourceType }
  | { kind: "delete"; resource_type: ResourceType; id: string };

function writeRoute(url: RequestInfo | URL, init?: RequestInit): WriteRoute | undefined {
  const parsed = new URL(String(url));
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST") {
    if (parsed.pathname === "/entities") return { kind: "upsert", event: "create", resource_type: "entity" };
    if (parsed.pathname === "/tasks") return { kind: "upsert", event: "create", resource_type: "task" };
    if (parsed.pathname === "/objects") return { kind: "upsert", event: "create", resource_type: "object" };
    if (taskActionPathPattern.test(parsed.pathname)) return { kind: "upsert", event: "update", resource_type: "task" };
  }
  if (method === "PATCH") {
    if (entityIDPathPattern.test(parsed.pathname)) return { kind: "upsert", event: "update", resource_type: "entity" };
    if (taskIDPathPattern.test(parsed.pathname)) return { kind: "upsert", event: "update", resource_type: "task" };
    if (objectIDPathPattern.test(parsed.pathname)) return { kind: "upsert", event: "update", resource_type: "object" };
  }
  if (method === "DELETE") {
    const entityID = pathID(parsed.pathname, entityIDPathPattern);
    if (entityID) return { kind: "delete", resource_type: "entity", id: entityID };
    const taskID = pathID(parsed.pathname, taskIDPathPattern);
    if (taskID) return { kind: "delete", resource_type: "task", id: taskID };
    const objectID = pathID(parsed.pathname, objectIDPathPattern);
    if (objectID) return { kind: "delete", resource_type: "object", id: objectID };
  }
  return undefined;
}

async function readResource(response: Response, type: ResourceType): Promise<EntityResource | TaskResource | ObjectResource | undefined> {
  try {
    const value = (await response.json()) as unknown;
    if (type === "entity" && isEntityResource(value)) return value;
    if (type === "task" && isTaskResource(value)) return value;
    if (type === "object" && isObjectResource(value)) return objectResource(value);
    return undefined;
  } catch {
    return undefined;
  }
}

function upsertEvent(event: "create" | "update", type: ResourceType, resource: EntityResource | TaskResource | ObjectResource): FeedEvent {
  switch (type) {
    case "entity": {
      const value = resource as EntityResource;
      return { event, resource_type: "entity", id: value.entity_id, version: value.metadata.version, resource: value };
    }
    case "task": {
      const value = resource as TaskResource;
      return { event, resource_type: "task", id: value.task_id, version: value.metadata.version, resource: value };
    }
    case "object": {
      const value = resource as ObjectResource;
      return { event, resource_type: "object", id: value.object_id, version: value.metadata.version, resource: value };
    }
  }
}

function isEntityResource(value: unknown): value is EntityResource {
  if (!isRecord(value) || typeof value.entity_id !== "string" || !isRecord(value.metadata)) {
    return false;
  }
  return typeof value.metadata.version === "number";
}

function isTaskResource(value: unknown): value is TaskResource {
  if (!isRecord(value) || typeof value.task_id !== "string" || !isRecord(value.metadata)) {
    return false;
  }
  return typeof value.metadata.version === "number";
}

function isObjectResource(value: unknown): value is ObjectResource & { extra?: unknown } {
  if (!isRecord(value) || typeof value.object_id !== "string" || !isRecord(value.metadata)) {
    return false;
  }
  return typeof value.metadata.version === "number";
}

function objectResource(value: ObjectResource & { extra?: unknown }): ObjectResource {
  const { extra: _extra, ...resource } = value;
  return resource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathID(pathname: string, pattern: RegExp): string | undefined {
  if (!pattern.test(pathname)) {
    return undefined;
  }
  return decodeURIComponent(pathname.split("/")[2]);
}

const entityIDPathPattern = /^\/entities\/[^/]+$/;
const taskIDPathPattern = /^\/tasks\/[^/]+$/;
const taskActionPathPattern = /^\/tasks\/[^/]+\/(?:acknowledge|complete|fail|status)$/;
const objectIDPathPattern = /^\/objects\/[^/]+$/;
