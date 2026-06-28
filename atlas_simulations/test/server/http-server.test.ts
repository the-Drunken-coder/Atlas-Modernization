import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSimulationServer, type SimulationServer } from "../../src/server/index.js";
import { RunStore } from "../../src/server/run-store.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

let server: SimulationServer | undefined;
let coreServer: HttpServer | undefined;

const INTEGRATION_TIMEOUT_MS = 5_000;

afterEach(async () => {
  await server?.close();
  await closeCoreServer();
  server = undefined;
});

describe("simulation HTTP server", () => {
  it("reports Atlas health success and upstream failures", async () => {
    const coreUrl = await startCoreHealthServer(200);
    server = createSimulationServer({
      config: { atlasBaseUrl: coreUrl, port: 0, packageRoot: process.cwd() },
      store: new RunStore(createFakeAtlasCore().factory)
    });
    const baseUrl = await server.listen();

    const healthy = await fetchJSON<{ ok: boolean; status: number }>(`${baseUrl}/api/health`);
    expect(healthy).toMatchObject({ ok: true, status: 200 });

    await closeCoreServer();
    const failedCoreUrl = await startCoreHealthServer(503);
    await server.close();
    server = createSimulationServer({
      config: { atlasBaseUrl: failedCoreUrl, port: 0, packageRoot: process.cwd() },
      store: new RunStore(createFakeAtlasCore().factory)
    });
    const failedBaseUrl = await server.listen();

    const unhealthyResponse = await fetch(`${failedBaseUrl}/api/health`);
    expect(unhealthyResponse.status).toBe(503);
    const unhealthy = (await unhealthyResponse.json()) as { ok: boolean; status: number };
    expect(unhealthy).toMatchObject({ ok: false, status: 503 });
  });

  it("lists scenarios, starts a run, streams replay events, and cleans up", async () => {
    const core = createFakeAtlasCore();
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://atlas.test", port: 0, packageRoot: process.cwd() },
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

    const stream = await fetch(`${baseUrl}/api/runs/${started.run.id}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const streamBody = await readUntil(stream, '"status":"completed"');
    expect(streamBody).toContain("data:");
    expect(streamBody).toContain('"status":"completed"');

    const cleaned = await fetchJSON<{ run: { status: string; cleaned: boolean } }>(`${baseUrl}/api/runs/${started.run.id}/cleanup`, { method: "POST", headers: mutationHeaders() });
    expect(cleaned.run).toMatchObject({ status: "completed", cleaned: true });
    expect(core.state.deleted).toEqual([`entity:${started.run.id}-asset-1`]);
  });

  it("returns client errors for bad request bodies and missing runs", async () => {
    const core = createFakeAtlasCore();
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://atlas.test", port: 0, packageRoot: process.cwd() },
      store: new RunStore(core.factory)
    });
    const baseUrl = await server.listen();

    await expectStatus(`${baseUrl}/api/runs`, 403, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    await expectStatus(`${baseUrl}/api/runs`, 403, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json", Origin: "http://example.test" }),
      body: "{}"
    });
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
    await expectStatus(`${baseUrl}/api/runs/missing/events`, 404);
    await expectStatus(`${baseUrl}/api/runs/missing/stop`, 404, { method: "POST", headers: mutationHeaders() });
    await expectStatus(`${baseUrl}/api/runs/missing/cleanup`, 404, { method: "POST", headers: mutationHeaders() });
    await expectStatus(`${baseUrl}/api/runs/%E0%A4%A/events`, 400);
    await expectStatus(`${baseUrl}/%E0%A4%A`, 400);
    await expectStatus(`${baseUrl}/`, 405, { method: "POST" });
  });
});

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function startCoreHealthServer(status: number): Promise<string> {
  coreServer = createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: status < 400 }));
  });
  await new Promise<void>((resolve) => coreServer!.listen(0, "127.0.0.1", resolve));
  const address = coreServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeCoreServer(): Promise<void> {
  if (!coreServer) return;
  await new Promise<void>((resolve, reject) => {
    coreServer!.close((error) => (error ? reject(error) : resolve()));
  });
  coreServer = undefined;
}

async function expectStatus(url: string, status: number, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  expect(response.status).toBe(status);
}

function mutationHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { "X-Atlas-Simulations-Request": "1", ...headers };
}

async function readUntil(response: Response, text: string): Promise<string> {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let body = "";
  const deadline = Date.now() + INTEGRATION_TIMEOUT_MS;
  try {
    while (!body.includes(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${text}`);
      const result = await withTimeout(reader!.read(), remaining);
      if (result.done) break;
      body += decoder.decode(result.value, { stream: true });
    }
  } finally {
    await reader!.cancel().catch(() => undefined);
  }
  return body;
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + INTEGRATION_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
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
