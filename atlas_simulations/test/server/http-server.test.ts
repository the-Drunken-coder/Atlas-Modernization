import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  type ClientRequest,
  createServer,
  type Server as HttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ATLAS_PROTOCOL_REVISION } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { AtlasClientFactory } from "../../src/server/atlas.js";
import { CleanupLedger } from "../../src/server/cleanup-ledger.js";
import { createSimulationServer, type SimulationServer } from "../../src/server/index.js";
import { RunStore } from "../../src/server/run-store.js";
import type { Scenario } from "../../src/server/scenario.js";
import type { RunEvent } from "../../src/shared/types.js";
import { createFakeAtlasCore } from "../support/fake-atlas.js";

let server: SimulationServer | undefined;
let coreServer: HttpServer | undefined;
let coreHealthRequests: string[] = [];
let coreHealthApiKeys: Array<string | undefined> = [];
let coreResourceRequests: Array<{ method: string; path: string; apiKey?: string }> = [];

const INTEGRATION_TIMEOUT_MS = 5_000;

afterEach(async () => {
  await server?.close();
  await closeCoreServer();
  server = undefined;
  coreHealthRequests = [];
  coreHealthApiKeys = [];
  coreResourceRequests = [];
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

  it("lists API targets and health-checks the selected target", async () => {
    const coreUrl = await startCoreHealthServer(200, "/deployed");
    server = createSimulationServer({
      config: {
        atlasBaseUrl: "http://127.0.0.1:8000",
        atlasTargets: [
          { id: "local", label: "Local Core", baseUrl: "http://127.0.0.1:8000" },
          { id: "deployed", label: "Atlas Command API", baseUrl: coreUrl, apiKey: "remote-key" }
        ],
        defaultAtlasTargetId: "local",
        port: 0,
        packageRoot: process.cwd()
      },
      store: new RunStore(createFakeAtlasCore().factory)
    });
    const baseUrl = await server.listen();

    const targets = await fetchJSON<{
      targets: Array<{ id: string; label: string; baseUrl: string; deployed: boolean; apiKeyConfigured: boolean }>;
      defaultTargetId: string;
    }>(`${baseUrl}/api/targets`);
    expect(targets).toMatchObject({
      defaultTargetId: "local",
      targets: [
        { id: "local", label: "Local Core", deployed: false, apiKeyConfigured: false },
        { id: "deployed", label: "Atlas Command API", baseUrl: coreUrl, deployed: false, apiKeyConfigured: true }
      ]
    });

    const health = await fetchJSON<{
      ok: boolean;
      status: number;
      target: { id: string; deployed: boolean; apiKeyConfigured: boolean };
    }>(`${baseUrl}/api/health?target=deployed`, { headers: { "X-Atlas-Target-Api-Key": "pasted-key" } });
    expect(health).toMatchObject({ ok: true, status: 200, target: { id: "deployed" } });
    expect(coreHealthRequests).toEqual(["/deployed/health"]);
    expect(coreHealthApiKeys).toEqual(["pasted-key"]);
    expect(health.target.deployed).toBe(false);
    expect(health.target.apiKeyConfigured).toBe(true);
    await expectStatus(`${baseUrl}/api/health?target=missing`, 404);
  });

  it("uses the selected target factory when a store is injected", async () => {
    const defaultCore = createFakeAtlasCore();
    const selectedCore = createFakeAtlasCore();
    server = createSimulationServer({
      config: {
        atlasBaseUrl: "http://127.0.0.1:8000",
        atlasTargets: [
          { id: "local", label: "Local Core", baseUrl: "http://127.0.0.1:8000", clientFactory: defaultCore.factory },
          {
            id: "deployed",
            label: "Atlas Command API",
            baseUrl: "https://atlascommandapi.org",
            clientFactory: selectedCore.factory
          }
        ],
        defaultAtlasTargetId: "local",
        port: 0,
        packageRoot: process.cwd()
      },
      store: durableStore(defaultCore.factory)
    });
    const baseUrl = await server.listen();

    const started = await fetchJSON<{ run: { id: string; target?: { id: string } } }>(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        scenarioId: "moving-assets",
        targetId: "deployed",
        confirmDeployedMutation: true,
        inputs: { assetCount: 1, ticks: 1, tickMs: 0, startLatitude: 38, startLongitude: -77 }
      })
    });
    expect(started.run.target).toMatchObject({ id: "deployed" });

    await waitFor(async () => {
      const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.run.id}`);
      expect(current.run.status).toBe("completed");
    });
    const current = await fetchJSON<{
      run: { cleaned: boolean; createdResources: Array<{ type: string; id: string }> };
    }>(`${baseUrl}/api/runs/${started.run.id}`);
    const created = current.run.createdResources[0];
    expect(created).toMatchObject({ type: "entity" });

    await fetchJSON<{ run: { cleaned: boolean } }>(`${baseUrl}/api/runs/${started.run.id}/cleanup`, {
      method: "POST",
      headers: mutationHeaders()
    });

    expect(selectedCore.state.deleted).toEqual([`entity:${created!.id}`]);
    expect(defaultCore.state.deleted).toEqual([]);
  });

  it("requires confirmation for every non-loopback target regardless of its ID while local starts remain unconfirmed", async () => {
    const localCore = createFakeAtlasCore();
    const deployedCore = createFakeAtlasCore();
    server = createSimulationServer({
      config: {
        atlasBaseUrl: "http://127.0.0.1:8000",
        atlasTargets: [
          { id: "loopback", label: "Local Core", baseUrl: "http://127.0.0.1:8000", clientFactory: localCore.factory },
          {
            id: "local",
            label: "Local-looking remote",
            baseUrl: "https://atlas.example",
            clientFactory: deployedCore.factory
          }
        ],
        defaultAtlasTargetId: "loopback",
        port: 0,
        packageRoot: process.cwd()
      },
      store: durableStore(localCore.factory)
    });
    const baseUrl = await server.listen();
    const inputs = { assetCount: 1, ticks: 1, tickMs: 0, startLatitude: 38, startLongitude: -77 };

    const rejected = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ scenarioId: "moving-assets", targetId: "local", inputs })
    });

    expect(rejected.status).toBe(400);
    await expect(responseJSON<{ message: string }>(rejected)).resolves.toMatchObject({
      message: expect.stringMatching(/confirm/i)
    });
    expect(deployedCore.state.entities.size).toBe(0);

    const local = await fetchJSON<{ run: { id: string } }>(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ scenarioId: "moving-assets", targetId: "loopback", inputs })
    });
    await waitFor(async () => {
      const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${local.run.id}`);
      expect(current.run.status).toBe("completed");
    });
    expect(localCore.state.entities.size).toBe(1);

    const confirmed = await fetchJSON<{ run: { id: string; target?: { deployed: boolean } } }>(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ scenarioId: "moving-assets", targetId: "local", confirmDeployedMutation: true, inputs })
    });
    expect(confirmed.run.target).toMatchObject({ deployed: true });
    await waitFor(async () => {
      const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${confirmed.run.id}`);
      expect(current.run.status).toBe("completed");
    });
    expect(deployedCore.state.entities.size).toBe(1);
    await fetchJSON(`${baseUrl}/api/runs/${confirmed.run.id}/cleanup`, { method: "POST", headers: mutationHeaders() });
    await fetchJSON(`${baseUrl}/api/runs/${local.run.id}/cleanup`, { method: "POST", headers: mutationHeaders() });
  });

  it("recovers production-owned deployed runs after restart and waits for explicit cleanup", async () => {
    const packageRoot = tempPackageRoot();
    const core = createFakeAtlasCore();
    const config = {
      atlasBaseUrl: "http://127.0.0.1:8000",
      atlasTargets: [
        { id: "local", label: "Local Core", baseUrl: "http://127.0.0.1:8000", clientFactory: core.factory },
        { id: "deployed", label: "Deployed Core", baseUrl: "https://atlas.example.test", clientFactory: core.factory }
      ],
      defaultAtlasTargetId: "local",
      cleanupLedgerDirectory: path.join(packageRoot, "state", "runs"),
      port: 0,
      packageRoot
    };
    const inputs = { assetCount: 1, ticks: 1, tickMs: 0, startLatitude: 38, startLongitude: -77 };

    try {
      server = createSimulationServer({ config });
      let baseUrl = await server.listen();
      const started = await fetchJSON<{ run: { id: string } }>(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: mutationHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          scenarioId: "moving-assets",
          targetId: "deployed",
          confirmDeployedMutation: true,
          inputs
        })
      });
      await waitFor(async () => {
        const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.run.id}`);
        expect(current.run.status).toBe("completed");
      });

      await server.close();
      server = undefined;
      expect(core.state.deleted).toEqual([]);

      const mismatchedConfig = {
        ...config,
        atlasTargets: config.atlasTargets.map((target) =>
          target.id === "deployed" ? { ...target, baseUrl: "https://different-atlas.example.test" } : target
        )
      };
      server = createSimulationServer({ config: mismatchedConfig });
      baseUrl = await server.listen();
      const recovered = await fetchJSON<{ runs: Array<{ id: string; status: string; cleaned: boolean }> }>(
        `${baseUrl}/api/runs`
      );
      expect(recovered.runs).toEqual([
        expect.objectContaining({ id: started.run.id, status: "abandoned", cleaned: false })
      ]);
      expect(core.state.deleted).toEqual([]);
      const refusedCleanup = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs/${started.run.id}/cleanup`, {
        method: "POST",
        headers: mutationHeaders()
      });
      expect(refusedCleanup.status).toBe(409);
      await expect(responseJSON<{ message: string }>(refusedCleanup)).resolves.toMatchObject({
        message: expect.stringContaining("no longer matches")
      });
      expect(core.state.deleted).toEqual([]);
      await server.close();
      server = undefined;

      server = createSimulationServer({ config });
      baseUrl = await server.listen();
      await fetchJSON(`${baseUrl}/api/runs/${started.run.id}/cleanup`, { method: "POST", headers: mutationHeaders() });
      expect(core.state.deleted).toHaveLength(1);
      await server.close();
      server = undefined;

      server = createSimulationServer({ config });
      baseUrl = await server.listen();
      await expect(fetchJSON<{ runs: unknown[] }>(`${baseUrl}/api/runs`)).resolves.toEqual({ runs: [] });
    } finally {
      await server?.close();
      server = undefined;
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("forwards pasted target API keys to Core when starting and cleaning up protected runs", async () => {
    const coreUrl = await startCoreResourceServer();
    server = createSimulationServer({
      config: {
        atlasBaseUrl: coreUrl,
        atlasTargets: [{ id: "deployed", label: "Atlas Command API", baseUrl: coreUrl }],
        defaultAtlasTargetId: "deployed",
        port: 0,
        packageRoot: process.cwd()
      }
    });
    const baseUrl = await server.listen();

    const started = await fetchJSON<{ run: { id: string; status: string } }>(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "application/json", "X-Atlas-Target-Api-Key": "pasted-key" }),
      body: JSON.stringify({
        scenarioId: "moving-assets",
        targetId: "deployed",
        inputs: { assetCount: 1, ticks: 1, tickMs: 0, startLatitude: 38, startLongitude: -77 }
      })
    });

    await waitFor(async () => {
      const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.run.id}`);
      expect(current.run.status).toBe("completed");
    });

    await fetchJSON<{ run: { cleaned: boolean } }>(`${baseUrl}/api/runs/${started.run.id}/cleanup`, {
      method: "POST",
      headers: mutationHeaders({ "X-Atlas-Target-Api-Key": "pasted-key" })
    });

    expect(
      coreResourceRequests
        .filter((request) => request.method === "POST" && request.path === "/entities")
        .map((request) => request.apiKey)
    ).toEqual(["pasted-key"]);
    expect(
      coreResourceRequests
        .filter((request) => request.method === "DELETE" && request.path.startsWith("/entities/"))
        .map((request) => request.apiKey)
    ).toEqual(["pasted-key"]);
    expect(new Set(coreResourceRequests.map((request) => request.apiKey))).toEqual(new Set(["pasted-key"]));
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
    const replayAndCleanupEvents = readRunStream(stream);

    const cleaned = await fetchJSON<{
      run: { status: string; cleaned: boolean; createdResources: Array<{ type: string; id: string }> };
    }>(`${baseUrl}/api/runs/${started.run.id}/cleanup`, { method: "POST", headers: mutationHeaders() });
    expect(cleaned.run).toMatchObject({ status: "completed", cleaned: true });
    expect(core.state.deleted).toEqual([`entity:${cleaned.run.createdResources[0]?.id}`]);
    const streamedEvents = await replayAndCleanupEvents;
    const completedEvent = streamedEvents.find((event) => event.type === "status" && event.status === "completed");
    expect(completedEvent).toMatchObject({ type: "status", status: "completed" });
    const streamedCleanupEvent = streamedEvents.find((event) => event.type === "cleanup" && !event.resource);
    expect(streamedCleanupEvent).toMatchObject({ type: "cleanup", message: "Cleanup complete" });

    const cleanupReplay = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs/${started.run.id}/events`);
    const cleanupReplayEvents = await readRunStream(cleanupReplay);
    const cleanupEvent = cleanupReplayEvents.find((event) => event.type === "cleanup" && !event.resource);
    expect(cleanupEvent).toMatchObject({ type: "cleanup", message: "Cleanup complete" });
  });

  it("keeps secrets and terminal controls out of stored, HTTP, and SSE error messages", async () => {
    const secrets = ["userinfo-canary", "query-canary", "bearer-canary", "basic-canary", "atlas_ak_canary"];
    const unsafeMessage =
      `failed https://user:${secrets[0]}@core.test?api_key=${secrets[1]} ` +
      `Bearer ${secrets[2]} Basic ${secrets[3]} ${secrets[4]} \u001b[31m\nstack-canary`;
    const store = new RunStore(createFakeAtlasCore().factory);
    const scenario: Scenario = {
      id: "unsafe-errors",
      name: "Unsafe errors",
      summary: "Exercises error boundaries",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        ctx.assert("unsafe assertion", false, unsafeMessage);
        throw new Error(unsafeMessage);
      }
    };
    const started = store.start(scenario, { fields: {} });
    await waitFor(async () => expect(store.get(started.id)?.status).toBe("failed"));
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot: process.cwd() },
      store
    });
    const baseUrl = await server.listen();

    const stored = JSON.stringify({ run: store.get(started.id), events: store.events(started.id) });
    const response = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs/${started.id}`);
    const responseText = await response.text();
    const stream = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs/${started.id}/events`);
    const streamedEvents = readRunStream(stream);
    await fetchJSON(`${baseUrl}/api/runs/${started.id}/cleanup`, { method: "POST", headers: mutationHeaders() });
    const streamed = await streamedEvents;
    const outputs = [stored, responseText, JSON.stringify(streamed)];

    for (const output of outputs) {
      for (const secret of secrets) expect(output).not.toContain(secret);
      expect(output).not.toContain("stack-canary");
      expect(output).not.toContain("\\u001b");
    }
    const assertionEvent = streamed.find((event) => event.type === "assertion");
    expect(assertionEvent).toMatchObject({ assertion: { message: expect.stringContaining("[redacted]") } });
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

    const stopped = await fetchJSON<{ run: { id: string; status: string } }>(
      `${baseUrl}/api/runs/${started.run.id}/stop`,
      {
        method: "POST",
        headers: mutationHeaders()
      }
    );

    expect(stopped.run).toMatchObject({ id: started.run.id, status: "cancelled" });
    await waitFor(async () => {
      const current = await fetchJSON<{ run: { status: string } }>(`${baseUrl}/api/runs/${started.run.id}`);
      expect(current.run.status).toBe("cancelled");
    });
  });

  it("returns 409 when cleanup is requested while a run is still running", async () => {
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

    const cleanup = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs/${started.run.id}/cleanup`, {
      method: "POST",
      headers: mutationHeaders()
    });

    expect(cleanup.status).toBe(409);
    await expect(responseJSON<{ message: string }>(cleanup)).resolves.toMatchObject({
      message: "Wait for the run to finish before cleanup"
    });
  });

  it("surfaces cleanup deletion failures as server errors", async () => {
    const core = createFakeAtlasCore();
    const failingFactory: AtlasClientFactory = (options) => {
      const client = core.factory(options);
      return {
        ...client,
        entities: {
          ...client.entities,
          delete: async (id) => {
            throw new Error(`delete failed for ${id}`);
          }
        }
      };
    };
    const store = new RunStore(failingFactory);
    const scenario: Scenario = {
      id: "cleanup-failure",
      name: "Cleanup failure",
      summary: "Creates one resource and then fails cleanup deletion",
      acceptsJson: false,
      inputFields: [],
      async run(ctx) {
        await ctx.createEntity({ entity_id: ctx.id("asset"), entity_type: "asset", components: {} });
      }
    };
    const run = store.start(scenario, { fields: {} });
    await waitFor(async () => expect(store.get(run.id)?.status).toBe("completed"));
    server = createSimulationServer({
      config: { atlasBaseUrl: "http://127.0.0.1:8000", port: 0, packageRoot: process.cwd() },
      store
    });
    const baseUrl = await server.listen();

    const cleanup = await fetchWithIntegrationTimeout(`${baseUrl}/api/runs/${run.id}/cleanup`, {
      method: "POST",
      headers: mutationHeaders()
    });

    expect(cleanup.status).toBe(500);
    await expect(responseJSON<{ message: string }>(cleanup)).resolves.toMatchObject({
      message: expect.stringContaining("delete failed for")
    });
  });

  it("waits for a stopped run to unwind before cleanup", async () => {
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

    const cleanup = fetchJSON<{ run: { status: string; cleaned: boolean } }>(
      `${baseUrl}/api/runs/${started.id}/cleanup`,
      {
        method: "POST",
        headers: mutationHeaders()
      }
    );
    release();
    await expect(cleanup).resolves.toMatchObject({ run: { status: "cancelled", cleaned: true } });
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
      await expectChunkedStatus(
        `${baseUrl}/api/runs/missing/${action}`,
        413,
        ["x".repeat(500_001), "x".repeat(500_001)],
        mutationHeaders()
      );
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
    await expectChunkedStatus(
      `${baseUrl}/api/runs`,
      413,
      ["x".repeat(500_001), "x".repeat(500_001)],
      mutationHeaders({ "Content-Type": "application/json" })
    );
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
    if (controller.signal.aborted)
      throw new Error(`Timed out waiting for HTTP response after ${INTEGRATION_TIMEOUT_MS}ms`);
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
    const apiKey = request.headers["x-api-key"];
    coreHealthApiKeys.push(Array.isArray(apiKey) ? apiKey.at(-1) : apiKey);
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

async function startCoreResourceServer(): Promise<string> {
  const entities = new Map<string, Record<string, unknown>>();
  let version = 0;
  coreServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const apiKey = request.headers["x-api-key"];
    coreResourceRequests.push({
      method: request.method ?? "",
      path: url.pathname,
      apiKey: Array.isArray(apiKey) ? apiKey.at(-1) : apiKey
    });
    const entityMatch = /^\/entities\/([^/]+)$/.exec(url.pathname);
    const checkInMatch = /^\/entities\/([^/]+)\/checkin$/.exec(url.pathname);
    if (request.method === "GET" && url.pathname === "/protocol/revision") {
      sendCoreJSON(response, 200, { protocol_revision: ATLAS_PROTOCOL_REVISION });
      return;
    }
    if (request.method === "POST" && url.pathname === "/entities") {
      const body = await readIncomingJSON<Record<string, unknown>>(request);
      const entity = {
        ...body,
        subtype: body.subtype ?? null,
        alias: body.alias ?? null,
        components: body.components ?? {},
        metadata: metadata(++version)
      };
      entities.set(String(body.entity_id), entity);
      sendCoreJSON(response, 200, entity);
      return;
    }
    if (request.method === "POST" && checkInMatch) {
      const id = decodeURIComponent(checkInMatch[1]!);
      const current = entities.get(id);
      if (!current) {
        sendCoreJSON(response, 404, { message: "not found" });
        return;
      }
      const body = await readIncomingJSON<Record<string, unknown>>(request);
      const updated = {
        ...current,
        components: {
          ...((current.components as Record<string, unknown> | undefined) ?? {}),
          ...((body.components as Record<string, unknown> | undefined) ?? {}),
          ...(body.status ? { status: { value: body.status, last_update: new Date().toISOString() } } : {}),
          ...(body.latitude !== undefined ||
          body.longitude !== undefined ||
          body.speed_m_s !== undefined ||
          body.heading_deg !== undefined
            ? {
                telemetry: {
                  ...(((current.components as Record<string, unknown> | undefined)?.telemetry as
                    | Record<string, unknown>
                    | undefined) ?? {}),
                  ...(body.latitude === undefined ? {} : { latitude: body.latitude }),
                  ...(body.longitude === undefined ? {} : { longitude: body.longitude }),
                  ...(body.speed_m_s === undefined ? {} : { speed_m_s: body.speed_m_s }),
                  ...(body.heading_deg === undefined ? {} : { heading_deg: body.heading_deg }),
                  last_update: new Date().toISOString()
                }
              }
            : {})
        },
        metadata: metadata(++version, (current.metadata as { created_at?: string } | undefined)?.created_at)
      };
      entities.set(id, updated);
      sendCoreJSON(response, 200, { entity: updated, tasks: [], task_count: 0, task_limit: 10, has_more_tasks: false });
      return;
    }
    if (request.method === "GET" && entityMatch) {
      const entity = entities.get(decodeURIComponent(entityMatch[1]!));
      if (!entity) {
        sendCoreJSON(response, 404, { message: "not found" });
        return;
      }
      sendCoreJSON(response, 200, entity);
      return;
    }
    if (request.method === "DELETE" && entityMatch) {
      entities.delete(decodeURIComponent(entityMatch[1]!));
      response.writeHead(204);
      response.end();
      return;
    }
    sendCoreJSON(response, 404, { message: "not found" });
  });
  await new Promise<void>((resolve) => coreServer!.listen(0, "127.0.0.1", resolve));
  const address = coreServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readIncomingJSON<T>(request: IncomingMessage): Promise<T> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}") as T;
}

function metadata(version: number, createdAt = new Date().toISOString()) {
  const now = new Date().toISOString();
  return { created_at: createdAt, updated_at: now, version };
}

function sendCoreJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
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

async function expectChunkedStatus(
  url: string,
  status: number,
  chunks: string[],
  headers: Record<string, string>
): Promise<void> {
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
        response.on("end", () =>
          finish(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
        );
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

function durableStore(clientFactory: AtlasClientFactory): RunStore {
  return new RunStore(clientFactory, {
    ledger: new CleanupLedger(path.join(tempPackageRoot(), "state", "runs"))
  });
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
