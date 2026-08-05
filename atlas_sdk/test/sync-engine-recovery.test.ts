import { describe, expect, it, vi } from "vitest";
import { AtlasClient } from "../src";
import { entity, FakeCore, task } from "./support/fake-core.js";

describe("AtlasClient sync: recovery and hydration", () => {
  it("hydrates, polls changed-since, updates cache, and serves covered reads from cache", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    core.upsertTask(task("task-1", "asset-1"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const updated = core.upsertTask({ ...task("task-1", "asset-1"), status: "acknowledged" });
    await client.changedSince();
    await expect(client.tasks.get("task-1")).resolves.toEqual(updated);
    expect(client.sync.status().healthy).toBe(true);
  });

  it("serves object details from the full-dataset cache", async () => {
    const core = new FakeCore();
    const hydrated = core.createObject({ object_id: "object-hydrated-detail", extra: { label: "hydrated" } });
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    await client.sync.start();
    core.requests = [];

    await expect(client.objects.get(hydrated.object_id)).resolves.toEqual(hydrated);
    expect(core.requests).toEqual([]);
  });

  it("recovers object summaries and refreshes details on demand", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();

    const recovered = core.createObject({ object_id: "object-recovered-detail", extra: { label: "recovered" } });
    await client.changedSince();
    core.requests = [];

    await expect(client.objects.get(recovered.object_id)).resolves.toEqual(recovered);
    expect(core.requests).toEqual([`/objects/${recovered.object_id}`]);
  });

  it("emits the original feed event for changed-since upserts", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const updated = core.upsertTask(task("task-polled", "asset-1"));
    await client.changedSince();

    await expect(client.tasks.get("task-polled")).resolves.toEqual(updated);
    expect(watch).toHaveBeenCalledWith(
      updated,
      expect.objectContaining({ event: "update", resource_type: "task", id: "task-polled" })
    );
  });

  it("applies each changed-since page before requesting the next page", async () => {
    const core = new FakeCore();
    core.changedSinceLimit = 1;
    let releaseSecondPage!: () => void;
    let secondPageStarted = false;
    const secondPage = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/queries/changed-since" && requestUrl.searchParams.has("cursor")) {
        secondPageStarted = true;
        await secondPage;
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const first = core.upsertTask(task("task-page-1", "asset-1"));
    const second = core.upsertTask(task("task-page-2", "asset-1"));
    const recovery = client.changedSince();
    await vi.waitFor(() => expect(secondPageStarted).toBe(true));
    expect(client.sync.status().lastVersion).toBe(first.metadata.version);
    expect(client.sync.status().healthy).toBe(false);
    const later = core.upsertTask(task("task-after-snapshot", "asset-1"));
    releaseSecondPage();
    await recovery;

    expect(
      core.requests.some((request) => request.startsWith("/queries/changed-since?") && request.includes("cursor="))
    ).toBe(true);
    expect(watch).toHaveBeenCalledWith(
      first,
      expect.objectContaining({ id: "task-page-1", version: first.metadata.version })
    );
    expect(watch).toHaveBeenCalledWith(
      second,
      expect.objectContaining({ id: "task-page-2", version: second.metadata.version })
    );
    expect(watch).not.toHaveBeenCalledWith(later, expect.anything());
    expect(client.sync.status().lastVersion).toBe(second.metadata.version);

    await client.changedSince();
    expect(watch).toHaveBeenCalledWith(
      later,
      expect.objectContaining({ id: "task-after-snapshot", version: later.metadata.version })
    );
    expect(client.sync.status().lastVersion).toBe(later.metadata.version);
  });

  it("rejects repeated changed-since cursor states", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-page-1"));
    core.upsertEntity(entity("asset-page-2"));
    let changedSinceRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/changed-since") return core.fetch(String(url), init);
      changedSinceRequests += 1;
      if (changedSinceRequests > 4) throw new Error("test stopped repeated changed-since pagination");
      return Response.json({
        events: [core.events[changedSinceRequests - 1]],
        has_more: true,
        next_cursor: "same-cursor",
        version: core.version
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });

    await expect(client.changedSince()).rejects.toThrow("Atlas changed-since pagination repeated cursor");
    expect(changedSinceRequests).toBe(2);
  });

  it("rehydrates automatically when the recovery cursor has expired", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-retention"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();

    const first = core.upsertTask(task("task-retained-1", "asset-retention"));
    const second = core.upsertTask(task("task-retained-2", "asset-retention"));
    core.minRetainedVersion = first.metadata.version;
    core.requests = [];

    await client.changedSince();

    expect(core.requests.filter((request) => request.startsWith("/queries/full"))).toHaveLength(1);
    await expect(client.tasks.get(first.task_id)).resolves.toEqual(first);
    await expect(client.tasks.get(second.task_id)).resolves.toEqual(second);
    expect(client.sync.status()).toMatchObject({
      healthy: true,
      degraded: false,
      lastVersion: second.metadata.version
    });
  });
});
