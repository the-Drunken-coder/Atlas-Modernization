import { describe, expect, it, vi } from "vitest";
import { AtlasAPIError, type EntityResource, type JSONValue, type ObjectResponse, type TaskCreateRequest, type TaskResource } from "../../atlas_sdk/src/index.js";
import { bridgeFeedSockets, handleCommandRequest, proxyAtlasRequest, type AtlasClientLike } from "./index.js";

const metadata = {
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z",
  version: 1
};

const commandCatalogPayload: Record<string, JSONValue> = {
  type: "command_catalog",
  name: "Command Catalog",
  description: "Worker test catalog",
  commands: [
    {
      id: "hold_position",
      name: "Hold Position",
      description: "Hold here.",
      parameters_schema: {
        seconds: { type: "number", description: "Duration", required: true, minimum: 1, maximum: 60 },
        notify: { type: "boolean", description: "Notify operator", required: false }
      }
    },
    {
      id: "return_home",
      name: "Return Home",
      description: "Return to base.",
      parameters_schema: {}
    }
  ]
};

describe("atlas command worker", () => {
  it("returns non-secret browser configuration", async () => {
    const response = await handleCommandRequest(new Request("https://command.test/api/config"), env(), executionContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      atlasBaseUrl: "https://command.test/atlas",
      protocolRevision: expect.any(String)
    });
  });

  it("proxies Atlas HTTP requests through the Worker origin", async () => {
    let proxiedRequest: { input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      proxiedRequest = { input, init };
      return new Response("{}", { headers: { "Content-Type": "application/json", ETag: "\"v1\"" } });
    };
    const request = new Request("https://command.test/atlas/entities?limit=5", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "If-Match": "7",
        Authorization: "Bearer browser-should-not-forward"
      },
      body: JSON.stringify({ entity_type: "asset" })
    });

    const response = await proxyAtlasRequest(request, env(), executionContext(), { fetch: fetchImpl });

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe("\"v1\"");
    if (!proxiedRequest?.init) throw new Error("proxy fetch was not called");
    const { input, init } = proxiedRequest;
    expect(String(input)).toBe("http://localhost:8000/entities?limit=5");
    expect(init.method).toBe("POST");
    expect((init.headers as Headers).get("X-API-Key")).toBe("worker-secret");
    expect((init.headers as Headers).get("If-Match")).toBe("7");
    expect((init.headers as Headers).has("Authorization")).toBe(false);
    expect(init.body).toBe(request.body);
  });

  it("returns 504 when proxied Atlas HTTP requests time out", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });

    try {
      const pending = proxyAtlasRequest(new Request("https://command.test/atlas/entities"), env(), executionContext(), { fetch: fetchImpl });
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await pending;

      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toMatchObject({ error_code: "GATEWAY_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates commands against the live catalog and creates a task", async () => {
    let createdTask: TaskCreateRequest | undefined;
    const client = fakeClient({
      dataset: {
        entities: [asset("asset-1", ["hold_position"])],
        tasks: [],
        objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      },
      catalog: catalogObject(),
      createTask(task) {
        createdTask = task;
        return {
          task_id: task.task_id,
          status: task.status ?? "pending",
          entity_id: task.entity_id ?? null,
          components: task.components ?? {},
          metadata
        };
      }
    });

    const response = await handleCommandRequest(
      commandRequest({ entity_id: "asset-1", command_id: "hold_position", parameters: { seconds: "5", notify: "true" } }),
      env(),
      executionContext(),
      { createClient: () => client, createTaskId: () => "command-fixed" }
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ task: { task_id: "command-fixed", status: "pending", entity_id: "asset-1" } });
    expect(createdTask).toEqual({
      task_id: "command-fixed",
      status: "pending",
      entity_id: "asset-1",
      components: {
        command: { type: "hold_position", id: "hold_position" },
        parameters: { seconds: 5, notify: true }
      }
    });
  });

  it("rejects commands unsupported by the selected target", async () => {
    const client = fakeClient({
      dataset: {
        entities: [asset("asset-1", ["hold_position"])],
        tasks: [],
        objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      },
      catalog: catalogObject()
    });

    const response = await handleCommandRequest(
      commandRequest({ entity_id: "asset-1", command_id: "return_home", parameters: {} }),
      env(),
      executionContext(),
      { createClient: () => client }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error_code: "UNSUPPORTED_COMMAND" });
  });

  it("rejects unauthenticated command submissions before creating a client", async () => {
    const createClient = vi.fn(() =>
      fakeClient({
        dataset: {
          entities: [asset("asset-1", ["hold_position"])],
          tasks: [],
          objects: [],
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false
        },
        catalog: catalogObject()
      })
    );

    const response = await handleCommandRequest(
      new Request("https://command.test/api/commands", {
        method: "POST",
        body: JSON.stringify({ entity_id: "asset-1", command_id: "hold_position", parameters: { seconds: 5 } })
      }),
      env(),
      executionContext(),
      { createClient }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error_code: "UNAUTHORIZED" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reads command targets directly instead of scanning a capped full-dataset page", async () => {
    let requestedEntityId = "";
    const client = fakeClient({
      dataset: {
        entities: [],
        tasks: [],
        objects: [],
        has_more_entities: true,
        has_more_tasks: false,
        has_more_objects: false
      },
      catalog: catalogObject(),
      getEntity(entityId) {
        requestedEntityId = entityId;
        return asset(entityId, ["hold_position"]);
      }
    });

    const response = await handleCommandRequest(
      commandRequest({ entity_id: "asset-after-page-500", command_id: "hold_position", parameters: { seconds: 5 } }),
      env(),
      executionContext(),
      { createClient: () => client, createTaskId: () => "command-fixed" }
    );

    expect(response.status).toBe(201);
    expect(requestedEntityId).toBe("asset-after-page-500");
  });

  it("returns 404 when the command target entity is missing", async () => {
    const client = fakeClient({
      dataset: {
        entities: [],
        tasks: [],
        objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      },
      catalog: catalogObject()
    });

    const response = await handleCommandRequest(
      commandRequest({ entity_id: "missing-asset", command_id: "hold_position", parameters: { seconds: 5 } }),
      env(),
      executionContext(),
      { createClient: () => client }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error_code: "ENTITY_NOT_FOUND" });
  });

  it("authenticates and forwards feed WebSocket frames", () => {
    const browser = new TestSocket();
    const upstream = new TestSocket();

    bridgeFeedSockets(browser, upstream, "worker-secret");
    browser.emit("message", { data: JSON.stringify({ action: "subscribe", filter: "all" }) });
    upstream.emit("open", {});
    upstream.emit("message", { data: JSON.stringify({ type: "hello", protocol_revision: "test" }) });

    expect(upstream.sent).toEqual([
      JSON.stringify({ action: "auth", api_key: "worker-secret" }),
      JSON.stringify({ action: "subscribe", filter: "all" })
    ]);
    expect(browser.sent).toEqual([JSON.stringify({ type: "hello", protocol_revision: "test" })]);
  });

  it("stops forwarding WebSocket frames after either side closes", () => {
    const browser = new TestSocket();
    const upstream = new TestSocket();

    bridgeFeedSockets(browser, upstream);
    upstream.emit("open", {});
    browser.emit("close", {});
    browser.emit("message", { data: "late browser frame" });
    upstream.emit("message", { data: "late upstream frame" });

    expect(upstream.sent).toEqual([]);
    expect(browser.sent).toEqual([]);
  });

  it("closes the feed bridge when pre-open browser messages exceed the pending queue limit", () => {
    const browser = new TestSocket();
    const upstream = new TestSocket();

    bridgeFeedSockets(browser, upstream);
    for (let index = 0; index < 257; index++) {
      browser.emit("message", { data: `queued-${index}` });
    }

    expect(browser.readyState).toBe(3);
    expect(upstream.readyState).toBe(3);
    upstream.emit("open", {});
    expect(upstream.sent).toEqual([]);
  });
});

function env(): Env {
  return {
    ATLAS_CORE_BASE_URL: "http://localhost:8000",
    ATLAS_API_KEY: "worker-secret",
    ATLAS_COMMAND_API_KEY: "command-secret"
  };
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    exports: {} as Cloudflare.Exports,
    props: undefined
  };
}

function fakeClient(options: {
  dataset: { entities: EntityResource[] } & Record<string, unknown>;
  catalog: ObjectResponse;
  getEntity?: (entityId: string) => EntityResource | Promise<EntityResource>;
  createTask?: (task: TaskCreateRequest) => TaskResource;
}): AtlasClientLike {
  return {
    async handshake() {},
    entities: {
      async get(entityId) {
        const entity = await (options.getEntity?.(entityId) ?? options.dataset.entities.find((candidate) => candidate.entity_id === entityId));
        if (!entity) {
          throw new AtlasAPIError("entity not found", 404, { success: false, error_code: "ENTITY_NOT_FOUND", message: "entity not found" });
        }
        return entity;
      }
    },
    objects: {
      async get() {
        return options.catalog;
      }
    },
    tasks: {
      async create(task) {
        return options.createTask?.(task) ?? {
          task_id: task.task_id,
          status: task.status ?? "pending",
          entity_id: task.entity_id ?? null,
          components: task.components ?? {},
          metadata
        };
      }
    }
  };
}

function commandRequest(body: Record<string, unknown>): Request {
  return new Request("https://command.test/api/commands", {
    method: "POST",
    headers: { Authorization: "Bearer command-secret" },
    body: JSON.stringify(body)
  });
}

function asset(entityId: string, supportedTasks?: string[]): EntityResource {
  return {
    entity_id: entityId,
    entity_type: "asset",
    subtype: null,
    alias: "Asset One",
    components: supportedTasks === undefined ? {} : { task_catalog: { supported_tasks: supportedTasks } },
    metadata
  };
}

function catalogObject(): ObjectResponse {
  return {
    object_id: "command_catalog",
    path: "objects/command_catalog",
    content_type: "application/json",
    type: "command_catalog",
    size_bytes: 1,
    usage_hints: ["command_catalog"],
    bucket: "atlas-media",
    metadata,
    payload: commandCatalogPayload
  };
}

type TestSocketEvent = "open" | "message" | "close" | "error";
type TestSocketListener = (event: { data?: string | ArrayBuffer }) => void;

class TestSocket {
  readyState = 0;
  readonly sent: Array<string | ArrayBuffer> = [];
  private readonly listeners = new Map<TestSocketEvent, TestSocketListener[]>();

  accept(): void {
    this.readyState = 1;
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: TestSocketEvent, listener: TestSocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: TestSocketEvent, event: { data?: string | ArrayBuffer }): void {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
