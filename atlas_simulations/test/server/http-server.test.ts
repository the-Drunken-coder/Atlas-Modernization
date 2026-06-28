import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
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

    const stream = await fetch(`${baseUrl}/api/runs/${started.run.id}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const streamBody = await readUntilContains(stream, '"status":"completed"');
    expect(streamBody).toContain("data:");
    expect(streamBody).toContain('"status":"completed"');

    const cleaned = await fetchJSON<{ run: { status: string; cleaned: boolean } }>(`${baseUrl}/api/runs/${started.run.id}/cleanup`, { method: "POST", headers: mutationHeaders() });
    expect(cleaned.run).toMatchObject({ status: "completed", cleaned: true });
    expect(core.state.deleted).toEqual([`entity:${started.run.id}-asset-1`]);
  });

  it("returns client errors for bad request bodies and missing runs", async () => {
    const core = createFakeAtlasCore();
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot: process.cwd() },
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
    await expectStatus(`${baseUrl}/api/runs/missing/events`, 404);
    await expectStatus(`${baseUrl}/api/runs/missing/stop`, 404, { method: "POST", headers: mutationHeaders() });
    await expectStatus(`${baseUrl}/api/runs/missing/cleanup`, 404, { method: "POST", headers: mutationHeaders() });
    await expectStatus(`${baseUrl}/api/runs/%E0%A4%A/events`, 400);
    await expectStatus(`${baseUrl}/%E0%A4%A`, 400);
    await expectStatus(`${baseUrl}/..%2fpackage.json`, 400);
    const head = await fetch(`${baseUrl}/`, { method: "HEAD" });
    expect([200, 404]).toContain(head.status);
    expect(await head.text()).toBe("");
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

    const route = await fetch(`${baseUrl}/runs/sim-example`);
    expect(route.status).toBe(200);
    expect(route.headers.get("content-type")).toContain("text/html");
    expect(route.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(route.headers.get("x-frame-options")).toBe("DENY");

    await expectStatus(`${baseUrl}/assets/missing.js`, 404);
    await expectStatus(`${baseUrl}/favicon.ico`, 404);
    await expectStatus(`${baseUrl}/assets/secret.txt`, 404);
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

async function requestStatusWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { Host: host }
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

function tempPackageRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atlas-simulations-http-"));
}

async function readUntilContains(response: Response, text: string): Promise<string> {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let body = "";
  const deadline = Date.now() + INTEGRATION_TIMEOUT_MS;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for ${text}`);
    const result = await withTimeout(reader!.read(), remaining);
    if (result.done) throw new Error(`Stream closed before ${text}`);
    body += decoder.decode(result.value, { stream: true });
    if (body.includes(text)) {
      await reader!.cancel();
      return body;
    }
  }
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
