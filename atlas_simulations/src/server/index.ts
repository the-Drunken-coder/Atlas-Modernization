import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { jsonNumber, type HealthResponse, type RunEvent, type RunListResponse, type ScenarioListResponse, type StartRunRequest, type StartRunResponse } from "../shared/types.js";
import { createAtlasClientFactory } from "./atlas.js";
import { loadConfig, type SimulationConfig } from "./config.js";
import { RunStore } from "./run-store.js";
import { descriptorForScenario, parseStartRequest, type ParsedStart } from "./scenario.js";
import { findScenario, scenarios } from "./scenario-registry.js";

export type SimulationServer = {
  listen(): Promise<string>;
  close(): Promise<void>;
  store: RunStore;
};

type EventStream = {
  response: ServerResponse;
  close(): void;
};

const MUTATION_HEADER = "x-atlas-simulations-request";
const UI_SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'"
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

export function createSimulationServer(options: { config?: SimulationConfig; store?: RunStore } = {}): SimulationServer {
  const config = options.config ?? loadConfig();
  const store = options.store ?? new RunStore(createAtlasClientFactory(config));
  const eventStreams = new Set<EventStream>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, store, eventStreams).catch((error) => {
      if (response.headersSent || response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJSON(response, error instanceof RequestBodyError ? error.status : 500, { message: errorMessage(error) });
    });
  });
  return {
    store,
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("error", onError);
          reject(error);
        };
        server.once("error", onError);
        server.listen(config.port, "127.0.0.1", () => {
          server.off("error", onError);
          const address = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${address.port}`);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const run of store.list()) {
          if (run.status === "running") store.stop(run.id);
        }
        for (const stream of [...eventStreams]) stream.close();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: SimulationConfig,
  store: RunStore,
  eventStreams: Set<EventStream>
): Promise<void> {
  if (!hasLoopbackHost(request.headers.host)) {
    sendJSON(response, 403, { message: "Requests require a loopback Host header" });
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    sendJSON(response, 400, { message: "Request target must be a valid URL" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    const health = await atlasHealth(config);
    sendJSON(response, health.ok ? 200 : health.status ?? 503, health satisfies HealthResponse);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/scenarios") {
    sendJSON(response, 200, { scenarios: scenarios.map(descriptorForScenario) } satisfies ScenarioListResponse);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/runs") {
    sendJSON(response, 200, { runs: store.list() } satisfies RunListResponse);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/runs") {
    if (!requireTrustedMutation(request, response)) return;
    const bodyText = await readRequestText(request);
    const body = readRequestBody(bodyText);
    const scenario = findScenario(body.scenarioId);
    if (!scenario) {
      sendJSON(response, 404, { message: "Scenario not found" });
      return;
    }
    let parsed: ParsedStart;
    try {
      parsed = parseStartRequest(scenario, body);
    } catch (error) {
      sendJSON(response, 400, { message: errorMessage(error) });
      return;
    }
    sendJSON(response, 201, { run: store.start(scenario, parsed.input) } satisfies StartRunResponse);
    return;
  }
  const runMatch = /^\/api\/runs\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (runMatch) {
    const runId = safeDecodeURIComponent(runMatch[1]);
    if (runId === undefined) {
      sendJSON(response, 400, { message: "Request path must use valid URL encoding" });
      return;
    }
    const action = runMatch[2];
    await handleRunRoute(request, response, store, runId, action, eventStreams);
    return;
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    sendJSON(response, 404, { message: "Not found" });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJSON(response, 405, { message: "Method not allowed" });
    return;
  }
  serveStatic(response, config.packageRoot, url.pathname, request.method === "HEAD", shouldServeSpaShell(url.pathname));
}

async function handleRunRoute(
  request: IncomingMessage,
  response: ServerResponse,
  store: RunStore,
  runId: string,
  action: string | undefined,
  eventStreams: Set<EventStream>
): Promise<void> {
  if (request.method === "GET" && action === undefined) {
    const run = store.get(runId);
    if (!run) {
      sendJSON(response, 404, { message: "Run not found" });
      return;
    }
    sendJSON(response, 200, { run });
    return;
  }
  if (request.method === "GET" && action === "events") {
    if (!store.get(runId)) {
      sendJSON(response, 404, { message: "Run not found" });
      return;
    }
    streamRunEvents(response, store, runId, eventStreams);
    return;
  }
  if (request.method === "POST" && action === "stop") {
    if (!requireTrustedMutation(request, response)) return;
    await drainRequestBody(request);
    if (!store.get(runId)) {
      sendJSON(response, 404, { message: "Run not found" });
      return;
    }
    sendJSON(response, 200, { run: store.stop(runId) });
    return;
  }
  if (request.method === "POST" && action === "cleanup") {
    if (!requireTrustedMutation(request, response)) return;
    await drainRequestBody(request);
    if (!store.get(runId)) {
      sendJSON(response, 404, { message: "Run not found" });
      return;
    }
    try {
      sendJSON(response, 200, { run: await store.cleanup(runId) });
    } catch (error) {
      if (isCleanupConflict(error)) {
        sendJSON(response, 409, { message: error.message });
        return;
      }
      throw error;
    }
    return;
  }
  sendJSON(response, 404, { message: "Not found" });
}

async function atlasHealth(config: SimulationConfig): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  let response: Response | undefined;
  try {
    const headers = new Headers();
    if (config.atlasApiKey) headers.set("X-API-Key", config.atlasApiKey);
    response = await fetch(`${config.atlasBaseUrl}/health`, { headers, signal: controller.signal });
    return {
      ok: response.ok,
      status: jsonNumber(response.status),
      message: response.ok ? "Atlas Core reachable" : `Atlas Core returned ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error)
    };
  } finally {
    await response?.body?.cancel().catch(() => undefined);
    clearTimeout(timeout);
  }
}

function streamRunEvents(response: ServerResponse, store: RunStore, runId: string, eventStreams: Set<EventStream>): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  response.flushHeaders();
  try {
    let unsubscribe: (() => void) | undefined;
    let stream: EventStream | undefined;
    let replaying = true;
    let closeAfterReplay = false;
    let closeScheduled = false;
    let dropFurtherEvents = false;
    const removeStream = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (stream) eventStreams.delete(stream);
    };
    const close = () => {
      removeStream();
      if (!response.writableEnded) response.end();
    };
    stream = { response, close };
    eventStreams.add(stream);
    const scheduleClose = () => {
      if (closeScheduled) return;
      closeScheduled = true;
      queueMicrotask(close);
    };
    const closeAfterCurrentReplay = () => {
      closeAfterReplay = true;
      if (!replaying && unsubscribe) scheduleClose();
    };
    response.on("close", removeStream);
    unsubscribe = store.subscribe(runId, (event) => {
      if (dropFurtherEvents || closeScheduled || response.writableEnded) return;
      const wrote = response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      if (!wrote) {
        dropFurtherEvents = true;
        closeAfterCurrentReplay();
        return;
      }
      if (isTerminalRunEvent(event)) closeAfterCurrentReplay();
    });
    replaying = false;
    if (closeAfterReplay) scheduleClose();
  } catch (error) {
    response.write(`event: error\n`);
    response.write(`data: ${JSON.stringify({ message: errorMessage(error) })}\n\n`);
    response.end();
  }
}

async function readRequestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > 1_000_000) {
      throw new RequestBodyError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function drainRequestBody(request: IncomingMessage): Promise<void> {
  await readRequestText(request);
}

function readJSON(body: string): unknown {
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestBodyError(400, "Request body must be valid JSON");
  }
}

function readRequestBody(bodyText: string): StartRunRequest {
  try {
    const body = readJSON(bodyText);
    if (!isRecord(body)) {
      throw new RequestBodyError(400, "Request body must be a JSON object");
    }
    if (typeof body.scenarioId !== "string") {
      throw new RequestBodyError(400, "scenarioId is required");
    }
    return body as StartRunRequest;
  } catch (error) {
    if (error instanceof RequestBodyError) {
      throw error;
    }
    throw new RequestBodyError(400, errorMessage(error));
  }
}

function isTerminalRunEvent(event: RunEvent): boolean {
  return (event.type === "status" && event.status !== "running") || (event.type === "cleanup" && !event.resource);
}

function sendJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function requireTrustedMutation(request: IncomingMessage, response: ServerResponse): boolean {
  if (hasTrustedMutation(request)) return true;
  response.setHeader("Connection", "close");
  sendJSON(response, 403, { message: "Mutating simulation requests require a local UI request header" });
  return false;
}

function hasTrustedMutation(request: IncomingMessage): boolean {
  if (!hasLoopbackHost(request.headers.host)) return false;
  return request.headers.origin ? hasSameOrigin(request) : hasMutationHeader(request);
}

function hasMutationHeader(request: IncomingMessage): boolean {
  const value = request.headers[MUTATION_HEADER];
  return Array.isArray(value) ? value.includes("1") : value === "1";
}

function hasSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const hostUrl = urlForHost(request.headers.host);
  if (!origin || !hostUrl) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === "http:" && originUrl.host === hostUrl.host && isLoopbackHostname(originUrl.hostname);
  } catch {
    return false;
  }
}

function hasLoopbackHost(host: string | undefined): boolean {
  const hostUrl = urlForHost(host);
  return !!hostUrl && isLoopbackHostname(hostUrl.hostname);
}

function urlForHost(host: string | undefined): URL | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function serveStatic(response: ServerResponse, packageRoot: string, requestPath: string, headOnly = false, allowSpaFallback = true): void {
  const staticRoot = path.join(packageRoot, "dist/client");
  const target = safeStaticPath(staticRoot, requestPath);
  if (target === "invalid-encoding") {
    response.writeHead(400, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Request path must use valid URL encoding");
    return;
  }
  if (target === "invalid-path") {
    response.writeHead(400, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Request path must stay inside the client root");
    return;
  }
  const file = target && existsSync(target) && statSync(target).isFile() ? target : allowSpaFallback ? path.join(staticRoot, "index.html") : undefined;
  if (!file) {
    response.writeHead(404, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Static asset not found");
    return;
  }
  if (!existsSync(file)) {
    response.writeHead(404, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Atlas Simulations UI has not been built. Run npm run build or use npm run dev.");
    return;
  }
  if (!isRealPathInsideRoot(staticRoot, file)) {
    response.writeHead(404, { ...UI_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(headOnly ? undefined : "Static asset not found");
    return;
  }
  if (headOnly) {
    response.writeHead(200, { ...UI_SECURITY_HEADERS, "Content-Type": contentType(file) });
    response.end();
    return;
  }
  const stream = createReadStream(file);
  stream.once("open", () => {
    response.writeHead(200, { ...UI_SECURITY_HEADERS, "Content-Type": contentType(file) });
    stream.pipe(response);
  });
  stream.on("error", (error) => {
    if (!response.headersSent) {
      sendJSON(response, 500, { message: errorMessage(error) });
      return;
    }
    response.destroy(error);
  });
}

function shouldServeSpaShell(requestPath: string): boolean {
  return !requestPath.startsWith("/assets/") && !/\/[^/]+\.[^/]+$/.test(requestPath);
}

function isRealPathInsideRoot(staticRoot: string, file: string): boolean {
  const realStaticRoot = realpathSync(staticRoot);
  const realFile = realpathSync(file);
  const relative = path.relative(realStaticRoot, realFile);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeStaticPath(staticRoot: string, requestPath: string): string | "invalid-encoding" | "invalid-path" | undefined {
  const decoded = safeDecodeURIComponent(requestPath);
  if (decoded === undefined) return "invalid-encoding";
  if (decoded.split(/[\\/]+/).includes("..")) return "invalid-path";
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(staticRoot, normalized === "/" ? "index.html" : normalized);
  return target.startsWith(staticRoot) ? target : undefined;
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCleanupConflict(error: unknown): error is Error {
  return error instanceof Error && error.message === "Wait for the run to finish before cleanup";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RequestBodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const app = createSimulationServer();
  app.listen().then((url) => {
    console.log(`Atlas Simulations server listening on ${url}`);
  }).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
