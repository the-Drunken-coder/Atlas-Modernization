import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  jsonNumber,
  type HealthResponse,
  type RunListResponse,
  type ScenarioListResponse,
  type StartRunResponse,
  type TargetListResponse
} from "../shared/types.js";
import { createAtlasClientFactory } from "./atlas.js";
import { CleanupLedger } from "./cleanup-ledger.js";
import { loadConfig, type AtlasTargetConfig, type SimulationConfig } from "./config.js";
import { streamRunEvents, type EventStream } from "./event-stream.js";
import {
  apiKeyForRequest,
  drainRequestBody,
  errorMessage,
  hasLoopbackHost,
  readRequestBody,
  readRequestText,
  RequestBodyError,
  requireTrustedMutation,
  safeDecodeURIComponent,
  sendJSON
} from "./http-utils.js";
import { RunStore } from "./run-store.js";
import { descriptorForScenario, parseStartRequest, type ParsedStart } from "./scenario.js";
import { findScenario, scenarios } from "./scenario-registry.js";
import { serveStatic, shouldServeSpaShell } from "./static.js";
import {
  clientFactoryForTarget,
  createTargetRegistry,
  runTarget,
  targetForId,
  targetForRequest,
  targetForRun,
  targetSummary,
  type TargetRegistry
} from "./targets.js";

export type SimulationServer = {
  listen(): Promise<string>;
  close(): Promise<void>;
  store: RunStore;
};

export function createSimulationServer(options: { config?: SimulationConfig; store?: RunStore } = {}): SimulationServer {
  const config = options.config ?? loadConfig();
  const targetRegistry = createTargetRegistry(config);
  const ownsStore = options.store === undefined;
  const cleanupLedgerDirectory = config.cleanupLedgerDirectory ?? path.join(config.packageRoot, ".atlas-simulations", "runs");
  const store =
    options.store ??
    new RunStore(createAtlasClientFactory(targetRegistry.defaultTarget), {
      ledger: new CleanupLedger(cleanupLedgerDirectory),
      resolveTarget: (target) => runTarget(target, true)
    });
  const eventStreams = new Set<EventStream>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, targetRegistry, store, ownsStore, eventStreams).catch((error) => {
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
  targetRegistry: TargetRegistry,
  store: RunStore,
  ownsStore: boolean,
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
  if (request.method === "GET" && url.pathname === "/api/targets") {
    sendJSON(response, 200, { targets: targetRegistry.summaries, defaultTargetId: targetRegistry.defaultTargetId } satisfies TargetListResponse);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    const target = targetForRequest(url, targetRegistry, apiKeyForRequest(request));
    if (!target) {
      sendJSON(response, 404, { message: "Atlas target not found" });
      return;
    }
    const health = await atlasHealth(target);
    sendJSON(response, health.ok ? 200 : (health.status ?? 503), health satisfies HealthResponse);
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
    const target = targetForId(parsed.targetId, targetRegistry, apiKeyForRequest(request));
    if (!target) {
      sendJSON(response, 404, { message: "Atlas target not found" });
      return;
    }
    if (targetSummary(target).deployed && parsed.confirmDeployedMutation !== true) {
      sendJSON(response, 400, { message: "Starting a deployed simulation requires explicit confirmation" });
      return;
    }
    sendJSON(response, 201, {
      run: store.start(scenario, parsed.input, runTarget(target, ownsStore || parsed.targetId !== undefined))
    } satisfies StartRunResponse);
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
    await handleRunRoute(request, response, store, targetRegistry, runId, action, eventStreams);
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
  targetRegistry: TargetRegistry,
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
    const run = store.get(runId);
    if (!run) {
      sendJSON(response, 404, { message: "Run not found" });
      return;
    }
    const requestApiKey = apiKeyForRequest(request);
    let cleanupFactory: ReturnType<typeof clientFactoryForTarget> | undefined;
    try {
      cleanupFactory =
        run.target && (run.status === "abandoned" || requestApiKey)
          ? clientFactoryForTarget(targetForRun(run.target, targetRegistry, requestApiKey))
          : undefined;
    } catch (error) {
      sendJSON(response, 409, { message: errorMessage(error) });
      return;
    }
    try {
      sendJSON(response, 200, { run: await store.cleanup(runId, cleanupFactory) });
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

async function atlasHealth(target: AtlasTargetConfig): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  let response: Response | undefined;
  try {
    const headers = new Headers();
    if (target.apiKey) headers.set("X-API-Key", target.apiKey);
    response = await fetch(`${target.baseUrl}/health`, { headers, signal: controller.signal });
    return {
      ok: response.ok,
      status: jsonNumber(response.status),
      message: response.ok ? "Atlas Core reachable" : `Atlas Core returned ${response.status}`,
      target: targetSummary(target)
    };
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error),
      target: targetSummary(target)
    };
  } finally {
    await response?.body?.cancel().catch(() => undefined);
    clearTimeout(timeout);
  }
}

function isCleanupConflict(error: unknown): error is Error {
  return error instanceof Error && error.message === "Wait for the run to finish before cleanup";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const app = createSimulationServer();
  app
    .listen()
    .then((url) => {
      console.log(`Atlas Simulations server listening on ${url}`);
    })
    .catch((error) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
