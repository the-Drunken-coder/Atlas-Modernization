import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type {
  EntityCreateRequest,
  EntityResource,
  JSONValue,
  MapArea,
  PluginManifest,
  PluginOperationInteraction,
  SpatialOperationResult
} from "@the-drunken-coder/atlas-sdk";
import { isAtlasAPIError, isJSONValue, isMapArea, isSpatialOperationResult } from "@the-drunken-coder/atlas-sdk";

const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const maxBodyBytes = 1 << 20;

type OperationHandler<Input extends JSONValue, Output extends JSONValue> = {
  bivarianceHack(input: Input, signal: AbortSignal): Output | Promise<Output>;
}["bivarianceHack"];

export type Operation<Input extends JSONValue = JSONValue, Output extends JSONValue = JSONValue> = {
  displayName: string;
  timeoutMs: number;
  handler: OperationHandler<Input, Output>;
  interaction?: PluginOperationInteraction;
};

export type SpatialOperation = Operation<MapArea, SpatialOperationResult> & {
  interaction: { readonly kind: "map_area" };
};

export function defineSpatialOperation(definition: Omit<SpatialOperation, "interaction">): SpatialOperation {
  return Object.freeze({
    ...definition,
    interaction: Object.freeze({ kind: "map_area" as const }),
    async handler(input: MapArea, signal: AbortSignal): Promise<SpatialOperationResult> {
      if (!isMapArea(input)) {
        throw new PluginInputError("invalid_map_area");
      }
      const result = await definition.handler(input, signal);
      if (!isSpatialOperationResult(result)) {
        throw new PluginFailureError("invalid_spatial_result");
      }
      return result;
    }
  });
}

export type OperationMap = Record<string, Operation>;

export type PluginDefinition<Operations extends OperationMap> = {
  pluginId: string;
  displayName: string;
  operations: Operations;
  taskable?: boolean;
  health?: (signal: AbortSignal) => boolean | Promise<boolean>;
};

export type DefinedPlugin<Operations extends OperationMap> = PluginDefinition<Operations> & {
  manifest: PluginManifest;
};

export function definePlugin<const Operations extends OperationMap>(
  definition: PluginDefinition<Operations>
): DefinedPlugin<Operations> {
  requireIdentifier("Plugin", definition.pluginId);
  requireDisplayName("Plugin", definition.displayName);
  const operationEntries = Object.entries(definition.operations).map(([operationId, operation]) => {
    requireIdentifier("Operation", operationId);
    requireDisplayName(`Operation ${operationId}`, operation.displayName);
    if (!Number.isInteger(operation.timeoutMs) || operation.timeoutMs < 1 || operation.timeoutMs > 25_000) {
      throw new TypeError(`Operation ${operationId} timeoutMs must be an integer between 1 and 25000`);
    }
    const interaction = normalizeOperationInteraction(operationId, operation.interaction);
    return [operationId, operation, interaction] as const;
  });
  const operations = operationEntries
    .map(([operationId, operation, interaction]) => {
      return Object.freeze({
        operation_id: operationId,
        display_name: operation.displayName.trim(),
        timeout_ms: operation.timeoutMs,
        ...(interaction ? { interaction } : {})
      });
    })
    .sort((left, right) => left.operation_id.localeCompare(right.operation_id));
  const normalizedOperations = Object.freeze(
    Object.fromEntries(
      operationEntries.map(([operationId, operation, interaction]) => [
        operationId,
        Object.freeze({
          displayName: operation.displayName.trim(),
          timeoutMs: operation.timeoutMs,
          handler: operation.handler,
          ...(interaction ? { interaction } : {})
        })
      ])
    )
  ) as Operations;
  const manifest: PluginManifest = {
    plugin_id: definition.pluginId,
    display_name: definition.displayName.trim(),
    operations,
    ...(definition.taskable ? { tool_asset_id: deriveToolAssetId(definition.pluginId) } : {})
  };
  Object.freeze(operations);
  Object.freeze(manifest);
  return Object.freeze({
    pluginId: definition.pluginId,
    displayName: definition.displayName.trim(),
    operations: normalizedOperations,
    taskable: definition.taskable,
    health: definition.health,
    manifest
  });
}

export class PluginInputError extends Error {
  constructor(
    readonly pluginCode: string,
    readonly details?: JSONValue
  ) {
    requireIdentifier("Plugin error", pluginCode);
    requireErrorDetails(details);
    super(pluginCode);
    this.name = "PluginInputError";
  }
}

export class PluginFailureError extends Error {
  constructor(
    readonly pluginCode: string,
    readonly details?: JSONValue
  ) {
    requireIdentifier("Plugin error", pluginCode);
    requireErrorDetails(details);
    super(pluginCode);
    this.name = "PluginFailureError";
  }
}

export type ServePluginOptions = {
  host?: string;
  port?: number;
  signal?: AbortSignal;
};

export async function servePlugin<Operations extends OperationMap>(
  plugin: DefinedPlugin<Operations>,
  options: ServePluginOptions = {}
): Promise<Server> {
  options.signal?.throwIfAborted();
  const activeRequests = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const requestController = new AbortController();
    activeRequests.add(requestController);
    const abort = () => requestController.abort();
    const abortForShutdown = () => requestController.abort(options.signal?.reason);
    request.once("aborted", abort);
    options.signal?.addEventListener("abort", abortForShutdown, { once: true });
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });
    try {
      const requestUrl = new URL(request.url ?? "/", "http://plugin.invalid");
      if (request.method === "GET" && requestUrl.pathname === "/manifest") {
        writeJSON(response, 200, plugin.manifest);
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        let healthy: boolean;
        try {
          healthy = (await plugin.health?.(requestController.signal)) ?? true;
        } catch {
          healthy = false;
        }
        writeJSON(response, healthy ? 200 : 503, {
          status: healthy ? "ok" : "unhealthy"
        });
        return;
      }
      const match = /^\/operations\/([a-z][a-z0-9]*(?:_[a-z0-9]+)*)$/.exec(requestUrl.pathname);
      if (request.method !== "POST" || !match) {
        writeJSON(response, 404, { code: "route_not_found" });
        return;
      }
      const operation = plugin.operations[match[1]];
      if (!operation) {
        writeJSON(response, 404, { code: "operation_not_found" });
        return;
      }
      const input = await readJSON(request, requestController.signal);
      const result = await operation.handler(input, requestController.signal);
      if (!isJSONValue(result)) throw new PluginFailureError("invalid_output");
      writeJSON(response, 200, result);
    } catch (error) {
      if (requestController.signal.aborted || response.headersSent) return;
      if (error instanceof PluginInputError) {
        const body = pluginErrorBody(error.pluginCode, error.details);
        writeJSON(response, body ? 400 : 500, body ?? { code: "operation_failed" });
      } else if (error instanceof PluginFailureError) {
        writeJSON(response, 500, pluginErrorBody(error.pluginCode, error.details) ?? { code: "operation_failed" });
      } else if (error instanceof SyntaxError || error instanceof RangeError) {
        writeJSON(response, 400, { code: "invalid_input" });
      } else {
        writeJSON(response, 500, { code: "operation_failed" });
      }
    } finally {
      activeRequests.delete(requestController);
      request.off("aborted", abort);
      options.signal?.removeEventListener("abort", abortForShutdown);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (options.signal?.aborted) {
    await closeServer(server);
    options.signal.throwIfAborted();
  }
  const shutdown = () => {
    for (const controller of activeRequests) controller.abort(options.signal?.reason);
    server.close();
    server.closeAllConnections();
  };
  options.signal?.addEventListener("abort", shutdown, { once: true });
  server.once("close", () => options.signal?.removeEventListener("abort", shutdown));
  return server;
}

export type HeaderTuple = readonly [string, string];

export type SourceGatewayRequest = {
  method: string;
  path: string;
  query?: readonly HeaderTuple[];
  headers?: readonly HeaderTuple[];
  body?: Uint8Array | null;
};

export type SourceGatewayResponse = {
  status: number;
  headers: HeaderTuple[];
  body: Uint8Array;
};

export type SourceGatewayFailureCode =
  | "request_rejected"
  | "unknown_connector"
  | "response_too_large"
  | "upstream_unreachable"
  | "circuit_open"
  | "upstream_timeout";

export class SourceGatewayError extends Error {
  constructor(readonly failureCode: SourceGatewayFailureCode) {
    super(failureCode);
    this.name = "SourceGatewayError";
  }
}

export class SourceGatewayClient {
  private readonly origin: string;

  constructor(
    origin: string,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch
  ) {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      throw new TypeError("Source Gateway origin must be an HTTP origin without credentials");
    }
    if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
      throw new TypeError("Source Gateway origin must not contain a path, query, or fragment");
    }
    this.origin = parsed.origin;
  }

  async request(
    connectorId: string,
    request: SourceGatewayRequest,
    options?: { signal?: AbortSignal }
  ): Promise<SourceGatewayResponse> {
    requireIdentifier("Connector", connectorId);
    if (request.method !== request.method.trim() || request.method !== request.method.toUpperCase()) {
      throw new TypeError("Source Gateway request method must use its canonical uppercase form");
    }
    const response = await this.fetchImplementation(
      `${this.origin}/connectors/${encodeURIComponent(connectorId)}/requests`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          method: request.method,
          path: request.path,
          query: request.query ?? [],
          headers: request.headers ?? [],
          body_base64:
            request.body == null || request.body.byteLength === 0 ? null : Buffer.from(request.body).toString("base64")
        }),
        signal: options?.signal,
        redirect: "manual"
      }
    );
    if (!isJSONContentType(response.headers.get("Content-Type"))) {
      throw new TypeError("Source Gateway response is not application/json");
    }
    const payload: unknown = await response.json();
    if (response.status !== 200) {
      const code = readGatewayFailure(payload);
      if (gatewayFailureStatuses[code] !== response.status) {
        throw new TypeError("Source Gateway failure status does not match its code");
      }
      throw new SourceGatewayError(code);
    }
    if (!isGatewayResponse(payload)) throw new TypeError("Source Gateway response is invalid");
    return {
      status: payload.status,
      headers: payload.headers,
      body: Uint8Array.from(decodeCanonicalBase64(payload.body_base64))
    };
  }
}

export function deriveToolAssetId(pluginId: string): string {
  requireIdentifier("Plugin", pluginId);
  return `plugin_${createHash("sha256").update(pluginId, "ascii").digest("base64url")}`;
}

export async function ensureToolAsset(
  client: ToolAssetClient,
  pluginId: string,
  options?: { alias?: string; signal?: AbortSignal }
): Promise<EntityResource> {
  const entityId = deriveToolAssetId(pluginId);
  let existing: EntityResource | undefined;
  try {
    existing = await client.entities.get(entityId, {
      fresh: true,
      signal: options?.signal
    });
  } catch (error) {
    if (!isAtlasAPIError(error) || error.status !== 404) throw error;
  }
  if (existing) {
    requireMatchingToolAsset(existing, pluginId);
    return existing;
  }
  try {
    return await client.entities.create(
      {
        entity_id: entityId,
        entity_type: "asset",
        subtype: "tool",
        alias: options?.alias,
        components: { custom_plugin: { plugin_id: pluginId } }
      },
      { signal: options?.signal }
    );
  } catch (error) {
    if (!isAtlasAPIError(error) || error.status !== 409) throw error;
    const raced = await client.entities.get(entityId, {
      fresh: true,
      signal: options?.signal
    });
    requireMatchingToolAsset(raced, pluginId);
    return raced;
  }
}

export type ToolAssetClient = {
  entities: {
    get(id: string, options?: { fresh?: boolean; signal?: AbortSignal }): Promise<EntityResource>;
    create(entity: EntityCreateRequest, options?: { signal?: AbortSignal }): Promise<EntityResource>;
  };
};

function requireMatchingToolAsset(entity: EntityResource, pluginId: string): void {
  const ownership = entity.components?.custom_plugin;
  if (
    entity.entity_type !== "asset" ||
    entity.subtype !== "tool" ||
    ownership?.plugin_id !== pluginId ||
    Object.keys(ownership).length !== 1
  ) {
    throw new Error(`Entity ${entity.entity_id} conflicts with Plugin ${pluginId} Tool Asset ownership`);
  }
}

async function readJSON(request: NodeJS.ReadableStream, signal: AbortSignal): Promise<JSONValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw signal.reason;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new RangeError("request body exceeds limit");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isJSONValue(value)) throw new SyntaxError("request body is not a JSON value");
  return value;
}

function writeJSON(response: import("node:http").ServerResponse, status: number, value: JSONValue): void {
  if (response.destroyed) return;
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    status = 500;
    body = '{"code":"operation_failed"}';
  }
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function pluginErrorBody(code: string, details: JSONValue | undefined): JSONValue | undefined {
  if (details !== undefined && !isSafeJSONValue(details)) return undefined;
  return details === undefined ? { code } : { code, details };
}

function requireErrorDetails(details: JSONValue | undefined): void {
  if (details !== undefined && !isSafeJSONValue(details)) {
    throw new TypeError("Plugin error details must be a JSON value");
  }
}

function isSafeJSONValue(value: unknown): value is JSONValue {
  try {
    return isJSONValue(value);
  } catch {
    return false;
  }
}

function requireIdentifier(subject: string, value: string): void {
  if (!identifierPattern.test(value) || value.length > 64) {
    throw new TypeError(`${subject} identifier must use lowercase underscore-separated segments`);
  }
}

function requireDisplayName(subject: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${subject} display name must not be empty`);
  if ([...trimmed].length > 100) throw new TypeError(`${subject} display name must be no more than 100 characters`);
}

function normalizeOperationInteraction(
  operationId: string,
  interaction: PluginOperationInteraction | undefined
): PluginOperationInteraction | undefined {
  if (interaction === undefined) return undefined;
  if (Object.keys(interaction).length !== 1 || interaction.kind !== "map_area") {
    throw new TypeError(`Operation ${operationId} interaction is invalid`);
  }
  return Object.freeze({ kind: interaction.kind });
}

function readGatewayFailure(value: unknown): SourceGatewayFailureCode {
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 1 || !("code" in value)) {
    throw new TypeError("Source Gateway failure response is invalid");
  }
  const codes: readonly SourceGatewayFailureCode[] = [
    "request_rejected",
    "unknown_connector",
    "response_too_large",
    "upstream_unreachable",
    "circuit_open",
    "upstream_timeout"
  ];
  if (typeof value.code !== "string" || !codes.includes(value.code as SourceGatewayFailureCode)) {
    throw new TypeError("Source Gateway failure response is invalid");
  }
  return value.code as SourceGatewayFailureCode;
}

const gatewayFailureStatuses: Record<SourceGatewayFailureCode, number> = {
  request_rejected: 400,
  unknown_connector: 404,
  response_too_large: 413,
  upstream_unreachable: 502,
  circuit_open: 503,
  upstream_timeout: 504
};

function isJSONContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("Source Gateway response body_base64 is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new TypeError("Source Gateway response body_base64 is invalid");
  }
  return decoded;
}

function isGatewayResponse(value: unknown): value is { status: number; headers: HeaderTuple[]; body_base64: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).some((key) => !["status", "headers", "body_base64"].includes(key))
  ) {
    return false;
  }
  const status = "status" in value ? value.status : undefined;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    !("body_base64" in value) ||
    typeof value.body_base64 !== "string"
  ) {
    return false;
  }
  if (!("headers" in value) || !Array.isArray(value.headers)) return false;
  return value.headers.every(
    (tuple) => Array.isArray(tuple) && tuple.length === 2 && tuple.every((part) => typeof part === "string")
  );
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
