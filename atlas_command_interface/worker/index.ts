import {
  ATLAS_PROTOCOL_REVISION,
  AtlasAPIError,
  AtlasClient,
  ProtocolMismatchError,
  type EntityResource,
  type FullDatasetResponse,
  type ObjectResponse,
  type TaskResource
} from "../../atlas_sdk/src/index.js";
import {
  type APIErrorResponse,
  type CommandSubmitRequest,
  CommandModelError,
  assertEntitySupportsCommand,
  buildCommandTaskRequest,
  catalogFromObject,
  coerceParameters,
  commandById
} from "../src/atlas/command-model.js";

const COMMAND_CATALOG_OBJECT_ID = "command_catalog";
const CORE_REQUEST_TIMEOUT_MS = 10_000;
const PROXY_REQUEST_TIMEOUT_MS = 30_000;

export type AtlasClientLike = {
  handshake(): Promise<void>;
  queries: {
    full(options?: { entityLimit?: number; taskLimit?: number; objectLimit?: number }): Promise<FullDatasetResponse>;
  };
  objects: {
    get(id: string, options?: { fresh?: boolean }): Promise<ObjectResponse>;
  };
  tasks: {
    create(task: ReturnType<typeof buildCommandTaskRequest>): Promise<TaskResource>;
  };
};

type WorkerSocket = {
  readonly readyState: number;
  accept?: () => void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: string | ArrayBuffer }) => void): void;
};

type WebSocketPairLike = {
  0: WorkerSocket;
  1: WorkerSocket;
};

export type CommandWorkerDependencies = {
  createClient?: (env: Env) => AtlasClientLike;
  createTaskId?: () => string;
  fetch?: typeof fetch;
  WebSocketCtor?: new (url: string) => WorkerSocket;
  createWebSocketPair?: () => WebSocketPairLike;
};

class WorkerHTTPError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string | number | boolean | null>;

  constructor(status: number, code: string, message: string, details: Record<string, string | number | boolean | null> = {}) {
    super(message);
    this.name = "WorkerHTTPError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createHandler(dependencies: CommandWorkerDependencies = {}): ExportedHandler<Env> {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return await handleCommandRequest(request, env, ctx, dependencies);
    }
  } satisfies ExportedHandler<Env>;
}

export default createHandler();

export async function handleCommandRequest(request: Request, env: Env, ctx: ExecutionContext, dependencies: CommandWorkerDependencies = {}): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") {
      return jsonResponse({
        atlasBaseUrl: new URL("/atlas", request.url).toString().replace(/\/$/, ""),
        protocolRevision: ATLAS_PROTOCOL_REVISION
      });
    }
    if (url.pathname === "/api/commands" && request.method === "POST") {
      return jsonResponse(await submitCommand(request, env, dependencies), { status: 201 });
    }
    if (url.pathname.startsWith("/atlas/") || url.pathname === "/atlas") {
      return await proxyAtlasRequest(request, env, ctx, dependencies);
    }
    if (url.pathname.startsWith("/api/")) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "API route not found", { path: url.pathname });
    }
    throw new WorkerHTTPError(404, "NOT_FOUND", "Not found", { path: url.pathname });
  } catch (error) {
    return errorResponse(error, request);
  }
}

async function submitCommand(request: Request, env: Env, dependencies: CommandWorkerDependencies): Promise<{ task: TaskResource }> {
  const body = parseSubmitRequest(await readJSONBody(request));
  const client = createClient(env, dependencies);
  await client.handshake();
  const [dataset, catalogObject] = await Promise.all([
    client.queries.full({ entityLimit: 500, taskLimit: 100, objectLimit: 50 }),
    client.objects.get(COMMAND_CATALOG_OBJECT_ID, { fresh: true })
  ]);
  const catalog = catalogFromObject(catalogObject);
  const entity = findCommandEntity(dataset.entities, body.entity_id);
  const command = commandById(catalog, body.command_id);
  assertEntitySupportsCommand(entity, command.id);
  const parameters = coerceParameters(command, body.parameters);
  const task = await client.tasks.create(
    buildCommandTaskRequest({
      taskId: dependencies.createTaskId?.() ?? `command-${crypto.randomUUID()}`,
      entityId: entity.entity_id,
      command,
      parameters
    })
  );
  return { task };
}

export async function proxyAtlasRequest(request: Request, env: Env, ctx: ExecutionContext, dependencies: CommandWorkerDependencies = {}): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/atlas/feed" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return proxyFeedRequest(env, dependencies);
  }
  const baseUrl = requiredCoreBaseUrl(env);
  const upstreamUrl = new URL(stripAtlasPrefix(url.pathname) + url.search, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_REQUEST_TIMEOUT_MS);
  const fetchImpl = dependencies.fetch ?? fetch;
  try {
    const response = await fetchImpl(upstreamUrl.toString(), {
      method: request.method,
      headers: proxyRequestHeaders(request.headers, env),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      signal: controller.signal
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: proxyResponseHeaders(response.headers)
    });
  } finally {
    clearTimeout(timeout);
  }
}

function proxyFeedRequest(env: Env, dependencies: CommandWorkerDependencies): Response {
  requiredCoreBaseUrl(env);
  const pair = dependencies.createWebSocketPair?.() ?? createNativeWebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept?.();
  const WebSocketCtor = dependencies.WebSocketCtor ?? WebSocket;
  const upstream = new WebSocketCtor(feedUrl(env.ATLAS_CORE_BASE_URL));
  bridgeFeedSockets(server, upstream, optionalString(env.ATLAS_API_KEY));
  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WorkerSocket });
}

export function bridgeFeedSockets(browser: WorkerSocket, upstream: WorkerSocket, apiKey?: string): void {
  const pending: Array<string | ArrayBuffer> = [];
  let upstreamOpen = false;
  let closed = false;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    browser.close();
    upstream.close();
  };
  upstream.addEventListener("open", () => {
    upstreamOpen = true;
    if (apiKey) {
      upstream.send(JSON.stringify({ action: "auth", api_key: apiKey }));
    }
    for (const message of pending.splice(0)) {
      upstream.send(message);
    }
  });
  browser.addEventListener("message", (event) => {
    if (event.data === undefined) return;
    if (upstreamOpen) {
      upstream.send(event.data);
      return;
    }
    pending.push(event.data);
  });
  upstream.addEventListener("message", (event) => {
    if (event.data !== undefined) {
      browser.send(event.data);
    }
  });
  browser.addEventListener("close", closeBoth);
  browser.addEventListener("error", closeBoth);
  upstream.addEventListener("close", closeBoth);
  upstream.addEventListener("error", closeBoth);
}

function createClient(env: Env, dependencies: CommandWorkerDependencies): AtlasClientLike {
  if (dependencies.createClient) {
    return dependencies.createClient(env);
  }
  return new AtlasClient({
    baseUrl: requiredCoreBaseUrl(env),
    apiKey: optionalString(env.ATLAS_API_KEY),
    fetch: (input, init) => fetch(input, init),
    requestTimeoutMs: CORE_REQUEST_TIMEOUT_MS
  });
}

async function readJSONBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new WorkerHTTPError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

function parseSubmitRequest(value: unknown): CommandSubmitRequest {
  if (!isRecord(value)) {
    throw new WorkerHTTPError(400, "VALIDATION_ERROR", "Command request must be a JSON object");
  }
  const entityId = value.entity_id;
  const commandId = value.command_id;
  if (typeof entityId !== "string" || entityId.trim() === "") {
    throw new WorkerHTTPError(400, "VALIDATION_ERROR", "entity_id is required");
  }
  if (typeof commandId !== "string" || commandId.trim() === "") {
    throw new WorkerHTTPError(400, "VALIDATION_ERROR", "command_id is required");
  }
  const parameters = value.parameters;
  if (parameters !== undefined && !isRecord(parameters)) {
    throw new WorkerHTTPError(400, "VALIDATION_ERROR", "parameters must be an object");
  }
  return { entity_id: entityId, command_id: commandId, parameters };
}

function findCommandEntity(entities: EntityResource[], entityId: string): EntityResource {
  const entity = entities.find((candidate) => candidate.entity_id === entityId);
  if (!entity) {
    throw new WorkerHTTPError(404, "ENTITY_NOT_FOUND", `Entity ${entityId} was not found`, { entity_id: entityId });
  }
  return entity;
}

function stripAtlasPrefix(pathname: string): string {
  if (pathname === "/atlas") return "/";
  return pathname.slice("/atlas".length) || "/";
}

function proxyRequestHeaders(headers: Headers, env: Env): Headers {
  const next = new Headers();
  for (const header of ["Accept", "Content-Type", "If-Match", "X-Request-ID"]) {
    const value = headers.get(header);
    if (value) next.set(header, value);
  }
  const apiKey = optionalString(env.ATLAS_API_KEY);
  if (apiKey) {
    next.set("X-API-Key", apiKey);
  }
  return next;
}

function proxyResponseHeaders(headers: Headers): Headers {
  const next = new Headers();
  for (const header of ["Content-Type", "ETag", "X-Next-Cursor", "Location"]) {
    const value = headers.get(header);
    if (value) next.set(header, value);
  }
  return next;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function errorResponse(error: unknown, request: Request): Response {
  const mapped = mapError(error);
  if (mapped.status >= 500) {
    const url = new URL(request.url);
    console.error(
      JSON.stringify({
        message: "atlas_command_interface request failed",
        error_code: mapped.body.error_code,
        error: mapped.body.message,
        path: url.pathname
      })
    );
  }
  return jsonResponse(mapped.body, { status: mapped.status });
}

function mapError(error: unknown): { status: number; body: APIErrorResponse } {
  if (error instanceof WorkerHTTPError) {
    return {
      status: error.status,
      body: { success: false, error_code: error.code, message: error.message, details: error.details }
    };
  }
  if (error instanceof CommandModelError) {
    return {
      status: 400,
      body: { success: false, error_code: error.code, message: error.message, details: error.details }
    };
  }
  if (error instanceof ProtocolMismatchError) {
    return {
      status: 502,
      body: {
        success: false,
        error_code: "PROTOCOL_MISMATCH",
        message: error.message,
        details: { expected: error.expected, actual: error.actual }
      }
    };
  }
  if (error instanceof AtlasAPIError) {
    return {
      status: 502,
      body: {
        success: false,
        error_code: "ATLAS_CORE_ERROR",
        message: error.message,
        details: { status: error.status, atlas_error_code: error.errorCode ?? null }
      }
    };
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    status: 500,
    body: { success: false, error_code: "INTERNAL_SERVER_ERROR", message }
  };
}

function requiredCoreBaseUrl(env: Env): string {
  const baseUrl = optionalString(env.ATLAS_CORE_BASE_URL);
  if (!baseUrl) {
    throw new WorkerHTTPError(500, "CONFIGURATION_ERROR", "ATLAS_CORE_BASE_URL is not configured");
  }
  return baseUrl;
}

function feedUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/feed";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createNativeWebSocketPair(): WebSocketPairLike {
  const pair = new WebSocketPair();
  return {
    0: pair[0],
    1: pair[1]
  };
}
