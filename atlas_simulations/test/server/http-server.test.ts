import { afterEach, describe, expect, it } from "vitest";
import { createSimulationServer, type SimulationServer } from "../../src/server/index.js";
import { RunStore } from "../../src/server/run-store.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

let server: SimulationServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("simulation HTTP server", () => {
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

    const cleaned = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.run.id}/cleanup`, { method: "POST", headers: mutationHeaders() });
    expect(cleaned.run.status).toBe("cleaned");
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
  });
});

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
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
  try {
    while (!body.includes(text)) {
      const result = await withTimeout(reader!.read(), 1_000);
      if (result.done) break;
      body += decoder.decode(result.value, { stream: true });
    }
  } finally {
    await reader!.cancel().catch(() => undefined);
  }
  return body;
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 2000;
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
