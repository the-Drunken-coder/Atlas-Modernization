import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HealthResponse, RunListResponse, ScenarioListResponse, StartRunRequest, StartRunResponse } from "../shared/types.js";
import { createAtlasClientFactory } from "./atlas.js";
import { loadConfig, type SimulationConfig } from "./config.js";
import { RunStore } from "./run-store.js";
import { descriptorForScenario, parseStartRequest } from "./scenario.js";
import { findScenario, scenarios } from "./scenario-registry.js";

export type SimulationServer = {
  listen(): Promise<string>;
  close(): Promise<void>;
  store: RunStore;
};

export function createSimulationServer(options: { config?: SimulationConfig; store?: RunStore } = {}): SimulationServer {
  const config = options.config ?? loadConfig();
  const store = options.store ?? new RunStore(createAtlasClientFactory(config));
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, store).catch((error) => {
      sendJSON(response, 500, { message: errorMessage(error) });
    });
  });
  return {
    store,
    listen: () =>
      new Promise((resolve) => {
        server.listen(config.port, "127.0.0.1", () => {
          const address = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${address.port}`);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, config: SimulationConfig, store: RunStore): Promise<void> {
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
    const body = (await readJSON(request)) as StartRunRequest;
    const scenario = findScenario(body.scenarioId);
    if (!scenario) {
      sendJSON(response, 404, { message: "Scenario not found" });
      return;
    }
    const parsed = parseStartRequest(scenario, body);
    sendJSON(response, 201, { run: store.start(scenario, parsed.input) } satisfies StartRunResponse);
    return;
  }
  const runMatch = /^\/api\/runs\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const action = runMatch[2];
    await handleRunRoute(request, response, store, runId, action);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    sendJSON(response, 404, { message: "Not found" });
    return;
  }
  serveStatic(response, config.packageRoot, url.pathname);
}

async function handleRunRoute(request: IncomingMessage, response: ServerResponse, store: RunStore, runId: string, action: string | undefined): Promise<void> {
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
    streamRunEvents(response, store, runId);
    return;
  }
  if (request.method === "POST" && action === "stop") {
    sendJSON(response, 200, { run: store.stop(runId) });
    return;
  }
  if (request.method === "POST" && action === "cleanup") {
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

function streamRunEvents(response: ServerResponse, store: RunStore, runId: string): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  try {
    const unsubscribe = store.subscribe(runId, (event) => {
      response.write(`id: ${event.sequence}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    response.on("close", unsubscribe);
  } catch (error) {
    response.write(`event: error\n`);
    response.write(`data: ${JSON.stringify({ message: errorMessage(error) })}\n\n`);
    response.end();
  }
}

async function readJSON(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 1_000_000) {
      throw new Error("Request body is too large");
    }
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.trim() ? JSON.parse(body) : {};
}

function sendJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function serveStatic(response: ServerResponse, packageRoot: string, requestPath: string): void {
  const staticRoot = path.join(packageRoot, "dist/client");
  const target = safeStaticPath(staticRoot, requestPath);
  const file = target && existsSync(target) && statSync(target).isFile() ? target : path.join(staticRoot, "index.html");
  if (!existsSync(file)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Atlas Simulations UI has not been built. Run npm run build or use npm run dev.");
    return;
  }
  response.writeHead(200, { "Content-Type": contentType(file) });
  createReadStream(file).pipe(response);
}

function safeStaticPath(staticRoot: string, requestPath: string): string | undefined {
  const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(staticRoot, normalized === "/" ? "index.html" : normalized);
  return target.startsWith(staticRoot) ? target : undefined;
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const app = createSimulationServer();
  app.listen().then((url) => {
    console.log(`Atlas Simulations server listening on ${url}`);
  });
}
