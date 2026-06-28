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
      headers: { "Content-Type": "application/json" },
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
    const streamBody = await withTimeout(stream.text(), 1_000);
    expect(streamBody).toContain("data:");
    expect(streamBody).toContain('"status":"completed"');

    const cleaned = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.run.id}/cleanup`, { method: "POST" });
    expect(cleaned.run.status).toBe("cleaned");
    expect(core.state.deleted).toEqual([`entity:${started.run.id}-asset-1`]);
  });
});

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
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
