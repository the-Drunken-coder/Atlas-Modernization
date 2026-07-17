import { describe, expect, it, vi } from "vitest";
import { AtlasClient } from "../src";
import { FakeCore } from "./support/fake-core.js";

describe("AtlasClient sync: connection and startup", () => {
  it("reports initial synchronization failures in status", async () => {
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: vi.fn(async () => {
        throw new Error("initial request failed");
      }),
      sync: false,
      pollIntervalMs: 0
    });
    await expect(client.sync.start()).rejects.toThrow("initial request failed");
    expect(client.sync.status()).toHaveProperty("error", "Atlas Core initial synchronization failed");
  });

  it("configures sync presets without starting hydration or feed side effects", () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    expect(client.sync.status()).toMatchObject({
      running: false,
      healthy: false,
      degraded: false,
      lastVersion: 0,
      subscriptions: [{ filter: "all" }]
    });
    expect(core.requests).toEqual([]);
    expect(core.feedConnections).toBe(0);
  });

  it("does not report a stopped engine healthy after a manual changed-since call", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      sync: false,
      pollIntervalMs: 60_000
    });

    await client.changedSince();

    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
  });
});
