import {
  ATLAS_PROTOCOL_REVISION,
  AtlasAPIError,
  AtlasClient,
  ProtocolMismatchError,
  type EntityResource,
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
const MAX_PENDING_FEED_MESSAGES = 256;

export type AtlasClientLike = {
  handshake(): Promise<void>;
  entities: {
    get(id: string, options?: { fresh?: boolean }): Promise<EntityResource>;
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
      requireCommandAuth(request, env);
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
  const [entity, catalogObject] = await Promise.all([
    getCommandEntity(client, body.entity_id),
    client.objects.get(COMMAND_CATALOG_OBJECT_ID, { fresh: true })
  ]);
  const catalog = catalogFromObject(catalogObject);
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

async function getCommandEntity(client: AtlasClientLike, entityId: string): Promise<EntityResource> {
  try {
    return await client.entities.get(entityId, { fresh: true });
  } catch (error) {
    if (error instanceof AtlasAPIError && error.status === 404) {
      throw new WorkerHTTPError(404, "ENTITY_NOT_FOUND", `Entity ${entityId} was not found`, { entity_id: entityId });
    }
    throw error;
  }
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
  } catch (error) {
    if (isAbortError(error)) {
      return jsonResponse(
        {
          success: false,
          error_code: "GATEWAY_TIMEOUT",
          message: "Atlas Core request timed out",
          details: { timeout_ms: PROXY_REQUEST_TIMEOUT_MS }
        },
        { status: 504 }
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function proxyFeedRequest(env: Env, dependencies: CommandWorkerDependencies): Response {
  const baseUrl = requiredCoreBaseUrl(env);
  const pair = dependencies.createWebSocketPair?.() ?? createNativeWebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept?.();
  const WebSocketCtor = dependencies.WebSocketCtor ?? WebSocket;
  const upstream = new WebSocketCtor(feedUrl(baseUrl));
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
    if (closed) return;
    upstreamOpen = true;
    if (apiKey) {
      upstream.send(JSON.stringify({ action: "auth", api_key: apiKey }));
    }
    for (const message of pending.splice(0)) {
      upstream.send(message);
    }
  });
  browser.addEventListener("message", (event) => {
    if (closed) return;
    if (event.data === undefined) return;
    if (upstreamOpen) {
      upstream.send(event.data);
      return;
    }
    if (pending.length >= MAX_PENDING_FEED_MESSAGES) {
      closeBoth();
      return;
    }
    pending.push(event.data);
  });
  upstream.addEventListener("message", (event) => {
    if (closed) return;
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

function requireCommandAuth(request: Request, env: Env): void {
  const expected = optionalString((env as Env & { ATLAS_COMMAND_API_KEY?: unknown }).ATLAS_COMMAND_API_KEY);
  if (!expected) {
    throw new WorkerHTTPError(500, "CONFIGURATION_ERROR", "ATLAS_COMMAND_API_KEY is not configured");
  }
  const actual = commandCredential(request.headers);
  if (!actual || !sameSecret(actual, expected)) {
    throw new WorkerHTTPError(401, "UNAUTHORIZED", "Command API credentials are required");
  }
}

function commandCredential(headers: Headers): string | undefined {
  const authorization = headers.get("Authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  return optionalString(headers.get("X-API-Key"));
}

function sameSecret(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") || (isRecord(error) && error.name === "AbortError");
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
