import { describe, expect, it, vi } from "vitest";
import { AtlasClient } from "../src";
import { createAtlasClient } from "./support/client.js";
import { entity, FakeCore, task } from "./support/fake-core.js";

describe("AtlasClient sync: recovery and hydration", () => {
  it("hydrates, polls changed-since, updates cache, and serves covered reads from cache", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    core.upsertTask(task("task-1", "asset-1"));
    const client = createAtlasClient(core, {
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
    const client = createAtlasClient(core, {
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
    const client = createAtlasClient(core, {
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
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });
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

  it("publishes updated and deleted resources when an expired cursor requires rehydration", async () => {
    const core = new FakeCore();
    const retained = core.upsertEntity(entity("asset-retention"));
    const deleted = core.upsertEntity(entity("asset-deleted"));
    const client = createAtlasClient(core, {
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const snapshots = vi.fn();
    client.sync.watchSnapshot(snapshots);

    const updated = core.upsertEntity({ ...retained, alias: "Recovered by hydration" });
    core.deleteEntity(deleted.entity_id);
    core.minRetainedVersion = updated.metadata.version;
    core.requests = [];

    await client.changedSince();

    expect(core.requests.filter((request) => request.startsWith("/queries/full"))).toHaveLength(1);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveBeenCalledWith({
      entities: { [updated.entity_id]: updated },
      tasks: {},
      objects: {}
    });
    expect(client.sync.status()).toMatchObject({
      healthy: true,
      degraded: false,
      lastVersion: core.version
    });
  });

  it("does not announce a feed event twice when it arrives during expired-cursor hydration", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-race"));
    let delayFallbackHydration = false;
    let hydrationStarted!: () => void;
    let releaseHydration!: () => void;
    const started = new Promise<void>((resolve) => {
      hydrationStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      if (delayFallbackHydration && new URL(String(url)).pathname === "/queries/full") {
        delayFallbackHydration = false;
        core.upsertEntity({ ...original, alias: "Included in hydration" });
        const response = await core.fetch(String(url), init);
        core.emit(core.events.at(-1)!, { record: false });
        hydrationStarted();
        await release;
        return response;
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: fetchImpl,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const resourceEvents = vi.fn();
    const snapshots = vi.fn();
    client.entities.watch(original.entity_id, resourceEvents);
    client.sync.watchSnapshot(snapshots);

    core.upsertTask(task("retention-boundary", original.entity_id));
    core.minRetainedVersion = core.version;
    delayFallbackHydration = true;
    const recovery = client.changedSince();
    await started;
    releaseHydration();
    await recovery;

    const updated = core.entities.get(original.entity_id)!;
    expect(client.sync.snapshot().entities[original.entity_id]).toEqual(updated);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(resourceEvents).not.toHaveBeenCalled();
    expect(client.sync.status().lastVersion).toBe(updated.metadata.version);
  });

  it("shares startup hydration with a concurrent expired-cursor recovery", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-shared-hydration"));
    let fullRequests = 0;
    let releaseFull!: (response: Response) => void;
    const pendingFull = new Promise<Response>((resolve) => {
      releaseFull = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === "/queries/full") {
        fullRequests++;
        return pendingFull;
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    const startup = client.sync.start();
    await vi.waitFor(() => expect(fullRequests).toBe(1));
    const updated = core.upsertEntity({ ...original, alias: "Recovered after shared hydration" });
    core.minRetainedVersion = original.metadata.version;
    const concurrentRecovery = client.changedSince();
    await vi.waitFor(() =>
      expect(core.requests.some((request) => request === "/queries/changed-since?since_version=0")).toBe(true)
    );
    expect(fullRequests).toBe(1);

    releaseFull(
      Response.json({
        entities: [original],
        tasks: [],
        objects: [],
        version: original.metadata.version,
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      })
    );
    await Promise.all([startup, concurrentRecovery]);

    expect(fullRequests).toBe(1);
    expect(client.sync.snapshot().entities[original.entity_id]).toEqual(updated);
    expect(client.sync.status().lastVersion).toBe(updated.metadata.version);
  });
});
