import {
  AtlasClient,
  type EntityResource,
  type FeedEvent,
  type ObjectResource,
  type ResourceType,
  type TaskResource
} from "../../src";
import { isEntityResource, isObjectDetailResource, isTaskResource } from "../../src/protocol.js";
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
    const deletionCount = core.deleteEvents.length;
    const response = await core.fetch(String(url), init);
    if (!response.ok || !route) {
      return response;
    }
    if (route.kind === "delete") {
      const event = core.deleteEvents
        .slice(deletionCount)
        .find((value) => value.resource_type === route.resource_type && value.id === route.id);
      if (event) {
        core.emit(event, { record: false });
      }
      return response;
    }
    const resource = await readResource(response.clone(), route.resource_type);
    if (resource) {
      core.emit(upsertEvent(core, route.event, route.resource_type, resource), { record: false });
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
  }
  if (method === "PATCH") {
    if (entityIDPathPattern.test(parsed.pathname)) return { kind: "upsert", event: "update", resource_type: "entity" };
    if (objectIDPathPattern.test(parsed.pathname)) return { kind: "upsert", event: "update", resource_type: "object" };
  }
  if (method === "POST" && taskLifecyclePathPattern.test(parsed.pathname)) {
    return { kind: "upsert", event: "update", resource_type: "task" };
  }
  if (method === "DELETE") {
    const entityID = pathID(parsed.pathname, entityIDPathPattern);
    if (entityID) return { kind: "delete", resource_type: "entity", id: entityID };
    const objectID = pathID(parsed.pathname, objectIDPathPattern);
    if (objectID) return { kind: "delete", resource_type: "object", id: objectID };
  }
  return undefined;
}

async function readResource(
  response: Response,
  type: ResourceType
): Promise<EntityResource | TaskResource | ObjectResource | undefined> {
  try {
    const value = (await response.json()) as unknown;
    if (type === "entity" && isEntityResource(value)) return value;
    if (type === "task" && isTaskResource(value)) return value;
    if (type === "object" && isObjectDetailResource(value)) return objectResource(value);
    return undefined;
  } catch {
    return undefined;
  }
}

function upsertEvent(
  core: FakeCore,
  event: "create" | "update",
  type: ResourceType,
  resource: EntityResource | TaskResource | ObjectResource
): FeedEvent {
  switch (type) {
    case "entity": {
      const value = resource as EntityResource;
      return { event, resource_type: "entity", id: value.entity_id, version: value.metadata.version, resource: value };
    }
    case "task": {
      const value = resource as TaskResource;
      const version = core.tasks.get(value.task_id)?.metadata.version;
      if (version === undefined) throw new Error(`missing fake Task ${value.task_id}`);
      return { event, resource_type: "task", id: value.task_id, version, resource: value };
    }
    case "object": {
      const value = resource as ObjectResource;
      return { event, resource_type: "object", id: value.object_id, version: value.metadata.version, resource: value };
    }
  }
}

function objectResource(value: ObjectResource & { extra?: unknown }): ObjectResource {
  const { extra: _extra, ...resource } = value;
  return resource;
}

function pathID(pathname: string, pattern: RegExp): string | undefined {
  if (!pattern.test(pathname)) {
    return undefined;
  }
  return decodeURIComponent(pathname.split("/")[2]);
}

const entityIDPathPattern = /^\/entities\/[^/]+$/;
const taskLifecyclePathPattern = /^\/tasks\/[^/]+\/(acknowledge|start|progress|complete|fail|cancel)$/;
const objectIDPathPattern = /^\/objects\/[^/]+$/;
