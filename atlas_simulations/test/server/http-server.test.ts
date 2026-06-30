import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type ClientRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../../src/shared/types.js";
import { createSimulationServer, type SimulationServer } from "../../src/server/index.js";
import { RunStore } from "../../src/server/run-store.js";
import type { Scenario } from "../../src/server/scenario.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

let server: SimulationServer | undefined;
let coreServer: HttpServer | undefined;
let coreHealthRequests: string[] = [];

const INTEGRATION_TIMEOUT_MS = 5_000;

afterEach(async () => {
  await server?.close();
  await closeCoreServer();
  server = undefined;
  coreHealthRequests = [];
});

describe("simulation HTTP server", () => {
  it("reports Atlas health success and upstream failures", async () => {
    const coreUrl = await startCoreHealthServer(200, "/api");
    server = createSimulationServer({
      config: { atlasBaseUrl: coreUrl, port: 0, packageRoot: process.cwd() },
      store: new RunStore(createFakeAtlasCore().factory)
    });
    const baseUrl = await server.listen();

    const healthy = await fetchJSON<{ ok: boolean; status: number }>(`${baseUrl}/api/health`);
    expect(healthy).toMatchObject({ ok: true, status: 200 });
    expect(coreHealthRequests).toEqual(["/api/health"]);

    await closeCoreServer();
    coreHealthRequests = [];
    const failedCoreUrl = await startCoreHealthServer(503, "/api");
    await server.close();
    server = createSimulationServer({
      config: { atlasBaseUrl: failedCoreUrl, port: 0, packageRoot: process.cwd() },
      store: new RunStore(createFakeAtlasCore().factory)
    });
    const failedBaseUrl = await server.listen();

    const unhealthyResponse = await fetchWithIntegrationTimeout(`${failedBaseUrl}/api/health`);
    expect(unhealthyResponse.status).toBe(503);
    const unhealthy = await responseJSON<{ ok: boolean; status: number }>(unhealthyResponse);
    expect(unhealthy).toMatchObject({ ok: false, status: 503 });
    expect(coreHealthRequests).toEqual(["/api/health"]);
  });

  it("lists scenarios, starts a run, streams replay events, and cleans up", async () => {
    const core = createFakeAtlasCore();
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot: process.cwd() },
      store: new RunStore(core.factory)
    });
    const baseUrl = await server.listen();

    const scenarios = await fetchJSON<{ scenarios: Array<{ id: string }> }>(`${baseUrl}/api/scenarios`);
    expect(scenarios.scenarios.some((scenario) => scenario.id === "moving-assets")).toBe(true);

    const started = await fetchJSON<{ run: { id: string; status: string } }>(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        scenarioId: "moving-assets",
        inputs: { assetCount: 1, ticks: 1, tickMs: 0, startLatitude: 38, startLongitude: -77 }
      })
    });
    await waitFor(async () => {
      const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.run.id}`);
      expect(current.run.status).toBe("completed");
    });

    const stream = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs/${started.run.id}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const replayEvents = await readRunStream(stream);
    const completedEvent = replayEvents.find((event) => event.type === "status" && event.status === "completed");
    expect(completedEvent).toMatchObject({ type: "status", status: "completed" });

    const cleaned = await fetchJSON<{ run: { status: string; cleaned: boolean; createdResources: Array<{ type: string; id: string }> } }>(
      `${baseUrl}/api/runs/${started.run.id}/cleanup`,
      { method: "POST", headers: mutationHeaders() }
    );
    expect(cleaned.run).toMatchObject({ status: "completed", cleaned: true });
    expect(core.state.deleted).toEqual([`entity:${cleaned.run.createdResources[0]?.id}`]);

    const cleanupReplay = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs/${started.run.id}/events`);
    const cleanupReplayEvents = await readRunStream(cleanupReplay);
    const cleanupEvent = cleanupReplayEvents.find((event) => event.type === "cleanup" && !event.resource);
    expect(cleanupEvent).toMatchObject({ type: "cleanup", message: "Cleanup complete" });
  });

  it("stops a live run through the HTTP API", async () => {
    const core = createFakeAtlasCore();
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot: process.cwd() },
      store: new RunStore(core.factory)
    });
    const baseUrl = await server.listen();
    const started = await fetchJSON<{ run: { id: string; status: string } }>(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        scenarioId: "moving-assets",
        inputs: { assetCount: 1, ticks: 2, tickMs: 1000, startLatitude: 38, startLongitude: -77 }
      })
    });

    const stopped = await fetchJSON<{ run: { id: string; status: string } }>(`${baseUrl}/api/runs/${started.run.id}/stop`, {
      method: "POST",
      headers: mutationHeaders()
    });

    expect(stopped.run).toMatchObject({ id: started.run.id, status: "cancelled" });
    await waitFor(async () => {
      const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.run.id}`);
      expect(current.run.status).toBe("cancelled");
    });
  });

  it("returns conflict when cleanup is requested before a stopped run unwinds", async () => {
    const core = createFakeAtlasCore();
    const store = new RunStore(core.factory);
    let release!: () => void;
    const scenario: Scenario = {
      id: "blocked-cleanup",
      name: "Blocked cleanup",
      summary: "Stays unsettled after stop",
      acceptsJson: false,
      inputFields: [],
      async run() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const started = store.start(scenario, { fields: {} });
    await waitFor(async () => expect(release).toBeTypeOf("function"));
    store.stop(started.id);
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot: process.cwd() },
      store
    });
    const baseUrl = await server.listen();

    await expectStatus(`${baseUrl}/api/runs/${started.id}/cleanup`, 409, { method: "POST", headers: mutationHeaders() });
    release();
    await waitFor(async () => {
      const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.id}`);
      expect(current.run.status).toBe("cancelled");
    });
  });

  it("returns client errors for bad request bodies and missing runs", async () => {
    const core = createFakeAtlasCore();
    const packageRoot = tempPackageRoot();
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot },
      store: new RunStore(core.factory)
    });
    const baseUrl = await server.listen();

    await expectStatus(`${baseUrl}/api/runs`, 403, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    expect(await requestStatusWithHost(`${baseUrl}/api/scenarios`, "example.test")).toBe(403);
    await expectStatus(`${baseUrl}/api/runs`, 403, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json", Origin: "http://example.test" }),
      body: "{}"
    });
    for (const action of ["stop", "cleanup"]) {
      await expectStatus(`${baseUrl}/api/runs/missing/${action}`, 403, { method: "POST" });
      await expectStatus(`${baseUrl}/api/runs/missing/${action}`, 403, {
        method: "POST",
        headers: mutationHeaders({ Origin: "http://example.test" })
      });
      await expectChunkedStatus(`${baseUrl}/api/runs/missing/${action}`, 413, ["x".repeat(500_001), "x".repeat(500_001)], mutationHeaders());
    }
    await expectStatus(`${baseUrl}/api/runs`, 400, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: "{"
    });
    await expectStatus(`${baseUrl}/api/runs`, 400, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: "null"
    });
    await expectStatus(`${baseUrl}/api/runs`, 413, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: "x".repeat(1_000_001)
    });
    await expectChunkedStatus(`${baseUrl}/api/runs`, 413, ["x".repeat(500_001), "x".repeat(500_001)], mutationHeaders({ "Content-Type": "application/json" }));
    await expectStatus(`${baseUrl}/api/runs/missing/events`, 404);
    await expectStatus(`${baseUrl}/api/runs/missing/stop`, 404, { method: "POST", headers: mutationHeaders() });
    await expectStatus(`${baseUrl}/api/runs/missing/cleanup`, 404, { method: "POST", headers: mutationHeaders() });
    await expectStatus(`${baseUrl}/api/runs/%E0%A4%A/events`, 400);
    await expectStatus(`${baseUrl}/%E0%A4%A`, 400);
    await expectStatus(`${baseUrl}/..%2fpackage.json`, 400);
    const head = await rawRequest(`${baseUrl}/`, "HEAD");
    expect(head.status).toBe(404);
    expect(head.body).toBe("");
    await expectStatus(`${baseUrl}/`, 405, { method: "POST" });
  });

  it("serves SPA routes without masking missing static assets", async () => {
    const packageRoot = tempPackageRoot();
    mkdirSync(path.join(packageRoot, "dist/client/assets"), { recursive: true });
    writeFileSync(path.join(packageRoot, "dist/client/index.html"), "<html><body>Atlas Simulations</body></html>");
    writeFileSync(path.join(packageRoot, "secret.txt"), "secret");
    symlinkSync(path.join(packageRoot, "secret.txt"), path.join(packageRoot, "dist/client/assets/secret.txt"));

    server = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot },
      store: new RunStore(createFakeAtlasCore().factory)
    });
    const baseUrl = await server.listen();

    const route = await fetchWithIntegrationTimeout(`${baseUrl}/runs/sim-example`);
    expect(route.status).toBe(200);
    expect(route.headers.get("content-type")).toContain("text/html");
    const csp = route.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(route.headers.get("x-content-type-options")).toBe("nosniff");
    expect(route.headers.get("x-frame-options")).toBe("DENY");

    await expectStatus(`${baseUrl}/assets/missing.js`, 404);
    await expectStatus(`${baseUrl}/favicon.ico`, 404);
    await expectStatus(`${baseUrl}/assets/secret.txt`, 404);
  });
});

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithIntegrationTimeout(url, init);
  expect(response.ok).toBe(true);
  return await responseJSON<T>(response);
}

async function fetchWithIntegrationTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTEGRATION_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Timed out waiting for HTTP response after ${INTEGRATION_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJSON<T>(response: Response): Promise<T> {
  return (await withTimeout(response.json() as Promise<T>, INTEGRATION_TIMEOUT_MS)) as T;
}

async function startCoreHealthServer(status: number, basePath = ""): Promise<string> {
  const expectedPath = `${basePath}/health`;
  coreServer = createServer((request, response) => {
    coreHealthRequests.push(request.url ?? "");
    if (request.url !== expectedPath) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: status < 400 }));
  });
  await new Promise<void>((resolve) => coreServer!.listen(0, "127.0.0.1", resolve));
  const address = coreServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}${basePath}`;
}

async function closeCoreServer(): Promise<void> {
  if (!coreServer) return;
  await new Promise<void>((resolve, reject) => {
    coreServer!.close((error) => (error ? reject(error) : resolve()));
  });
  coreServer = undefined;
}

async function expectStatus(url: string, status: number, init?: RequestInit): Promise<void> {
  const response = await fetchWithIntegrationTimeout(url, init);
  expect(response.status).toBe(status);
  await withTimeout(response.arrayBuffer(), INTEGRATION_TIMEOUT_MS);
}

function mutationHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { "X-Atlas-Simulations-Request": "1", ...headers };
}

async function requestStatusWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let request: ClientRequest;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      request.setTimeout(0);
      callback();
    };
    request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { Host: host }
      },
      (response) => {
        response.resume();
        response.on("error", (error) => finish(() => reject(error)));
        response.on("end", () => finish(() => resolve(response.statusCode ?? 0)));
      }
    );
    request.setTimeout(INTEGRATION_TIMEOUT_MS, () => request.destroy(new Error("Timed out waiting for HTTP response")));
    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

async function expectChunkedStatus(url: string, status: number, chunks: string[], headers: Record<string, string>): Promise<void> {
  const target = new URL(url);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      request.setTimeout(0);
      callback();
    };
    request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers
      },
      (response) => {
        response.resume();
        response.on("error", (error) => finish(() => reject(error)));
        response.on("end", () => {
          const actual = response.statusCode ?? 0;
          if (actual === status) {
            finish(resolve);
            return;
          }
          finish(() => reject(new Error(`Expected ${status}, received ${actual}`)));
        });
      }
    );
    request.setTimeout(INTEGRATION_TIMEOUT_MS, () => request.destroy(new Error("Timed out waiting for HTTP response")));
    request.on("error", (error) => finish(() => reject(error)));
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function rawRequest(url: string, method: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let request: ClientRequest;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      request.setTimeout(0);
      callback();
    };
    request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method
      },
      (response) => {
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", (error) => finish(() => reject(error)));
        response.on("end", () => finish(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
      }
    );
    request.setTimeout(INTEGRATION_TIMEOUT_MS, () => request.destroy(new Error("Timed out waiting for HTTP response")));
    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

function tempPackageRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atlas-simulations-http-"));
}

async function readRunStream(response: Response): Promise<RunEvent[]> {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let body = "";
  const deadline = Date.now() + INTEGRATION_TIMEOUT_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Timed out waiting for run stream to close");
      const result = await withTimeout(reader!.read(), remaining);
      if (result.done) {
        body += decoder.decode();
        return parseRunEvents(body);
      }
      body += decoder.decode(result.value, { stream: true });
    }
  } catch (error) {
    await reader!.cancel().catch(() => undefined);
    throw error;
  }
}

function parseRunEvents(body: string): RunEvent[] {
  const normalized = body.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  if (!normalized.endsWith("\n\n")) blocks.pop();
  return blocks.flatMap((block) => {
    const data = block
      .split("\n")
      .filter((current) => current.startsWith("data:"))
      .map((current) => current.slice(current.startsWith("data: ") ? "data: ".length : "data:".length))
      .join("\n");
    return data ? [JSON.parse(data) as RunEvent] : [];
  });
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + INTEGRATION_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await withTimeout(assertion(), Math.max(1, deadline - Date.now()));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
