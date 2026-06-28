import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HealthResponse, RunEvent, RunListResponse, ScenarioListResponse, StartRunRequest, StartRunResponse } from "../shared/types.js";
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

const MUTATION_HEADER = "x-atlas-simulations-request";

export function createSimulationServer(options: { config?: SimulationConfig; store?: RunStore } = {}): SimulationServer {
  const config = options.config ?? loadConfig();
  const store = options.store ?? new RunStore(createAtlasClientFactory(config));
  const eventStreams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, store, eventStreams).catch((error) => {
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
        for (const stream of eventStreams) {
          if (!stream.writableEnded) stream.end();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: SimulationConfig,
  store: RunStore,
  eventStreams: Set<ServerResponse>
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJSON(response, 200, await atlasHealth(config) satisfies HealthResponse);
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
    const body = await readRequestBody(request);
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
  if (url.pathname.startsWith("/api/")) {
    sendJSON(response, 404, { message: "Not found" });
    return;
  }
  serveStatic(response, config.packageRoot, url.pathname);
}

async function handleRunRoute(
  request: IncomingMessage,
  response: ServerResponse,
  store: RunStore,
  runId: string,
  action: string | undefined,
  eventStreams: Set<ServerResponse>
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
    if (!store.get(runId)) {
      sendJSON(response, 404, { message: "Run not found" });
      return;
    }
    sendJSON(response, 200, { run: store.stop(runId) });
    return;
  }
  if (request.method === "POST" && action === "cleanup") {
    if (!requireTrustedMutation(request, response)) return;
    if (!store.get(runId)) {
      sendJSON(response, 404, { message: "Run not found" });
      return;
    }
    sendJSON(response, 200, { run: await store.cleanup(runId) });
    return;
  }
  sendJSON(response, 404, { message: "Not found" });
}

async function atlasHealth(config: SimulationConfig): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const headers = new Headers();
    if (config.atlasApiKey) headers.set("X-API-Key", config.atlasApiKey);
    const response = await fetch(`${config.atlasBaseUrl}/health`, { headers, signal: controller.signal });
    return {
      ok: response.ok,
      atlasBaseUrl: config.atlasBaseUrl,
      status: response.status,
      message: response.ok ? "Atlas Core reachable" : `Atlas Core returned ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      atlasBaseUrl: config.atlasBaseUrl,
      message: errorMessage(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function streamRunEvents(response: ServerResponse, store: RunStore, runId: string, eventStreams: Set<ServerResponse>): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  eventStreams.add(response);
  try {
    let unsubscribe: (() => void) | undefined;
    let closeAfterSubscribe = false;
    let closeQueued = false;
    const removeStream = () => {
      unsubscribe?.();
      eventStreams.delete(response);
    };
    const close = () => {
      removeStream();
      if (!response.writableEnded) response.end();
    };
    const closeSoon = () => {
      closeAfterSubscribe = true;
      if (!unsubscribe || closeQueued) return;
      closeQueued = true;
      queueMicrotask(close);
    };
    unsubscribe = store.subscribe(runId, (event) => {
      response.write(`id: ${event.sequence}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      if (isTerminalRunEvent(event)) closeSoon();
    });
    response.on("close", removeStream);
    if (closeAfterSubscribe) close();
  } catch (error) {
    eventStreams.delete(response);
    response.write(`event: error\n`);
    response.write(`data: ${JSON.stringify({ message: errorMessage(error) })}\n\n`);
    response.end();
  }
}

async function readJSON(request: IncomingMessage): Promise<unknown> {
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
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestBodyError(400, "Request body must be valid JSON");
  }
}

function isTerminalRunEvent(event: RunEvent): boolean {
  return event.type === "status" && event.status !== "running";
}

async function readRequestBody(request: IncomingMessage): Promise<StartRunRequest> {
  try {
    const body = await readJSON(request);
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

function sendJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function requireTrustedMutation(request: IncomingMessage, response: ServerResponse): boolean {
  if (hasMutationHeader(request) || hasSameOrigin(request)) return true;
  sendJSON(response, 403, { message: "Mutating simulation requests require a local UI request header" });
  return false;
}

function hasMutationHeader(request: IncomingMessage): boolean {
  const value = request.headers[MUTATION_HEADER];
  return Array.isArray(value) ? value.includes("1") : value === "1";
}

function hasSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function serveStatic(response: ServerResponse, packageRoot: string, requestPath: string): void {
  const staticRoot = path.join(packageRoot, "dist/client");
  const target = safeStaticPath(staticRoot, requestPath);
  if (target === "invalid-encoding") {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Request path must use valid URL encoding");
    return;
  }
  const file = target && existsSync(target) && statSync(target).isFile() ? target : path.join(staticRoot, "index.html");
  if (!existsSync(file)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Atlas Simulations UI has not been built. Run npm run build or use npm run dev.");
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", (error) => {
    if (!response.headersSent) {
      sendJSON(response, 500, { message: errorMessage(error) });
      return;
    }
    response.destroy(error);
  });
  response.writeHead(200, { "Content-Type": contentType(file) });
  stream.pipe(response);
}

function safeStaticPath(staticRoot: string, requestPath: string): string | "invalid-encoding" | undefined {
  const decoded = safeDecodeURIComponent(requestPath);
  if (decoded === undefined) return "invalid-encoding";
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
