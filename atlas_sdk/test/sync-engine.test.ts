import { describe, expect, it, vi } from "vitest";
import { AtlasClient, type EntityResource, type FeedEvent, type ResourceType, type TaskResource } from "../src";
import { ResourceCache } from "../src/cache.js";
import { parseSubscriptionKey } from "../src/subscriptions.js";
import { changedSinceToEvents, type ChangedSinceResponse, type ResourceValue } from "../src/types.js";
import { entity, FakeCore, metadata, object, task } from "./support/fake-core.js";

describe("AtlasClient sync", () => {
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
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: false, pollIntervalMs: 60_000 });

    await client.changedSince();

    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
  });

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

  it("emits recovered events for changed-since upserts", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-1"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const updated = core.upsertTask(task("task-polled", "asset-1"));
    await client.changedSince();

    await expect(client.tasks.get("task-polled")).resolves.toEqual(updated);
    expect(watch).toHaveBeenCalledWith(updated, expect.objectContaining({ event: "recovered", resource_type: "task", id: "task-polled" }));
  });

  it("emits changed-since recovery events in global version order", () => {
    const entityVersion5 = { ...entity("entity-v5"), metadata: metadata(5) };
    const taskVersion2 = { ...task("task-v2", null), metadata: metadata(2) };
    const objectVersion4 = { ...object("object-v4"), metadata: metadata(4) };
    const response: ChangedSinceResponse = {
      entities: [entityVersion5],
      tasks: [taskVersion2],
      objects: [objectVersion4],
      deleted_entities: [{ id: "entity-v1", type: "entity", version: 1 }],
      deleted_tasks: [{ id: "task-v3", type: "task", version: 3, entity_id: null }],
      deleted_objects: [],
      version: 5
    };

    expect(changedSinceToEvents(response).map((event) => event.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it("drains paginated changed-since responses before advancing the high-water mark", async () => {
    const core = new FakeCore();
    core.changedSinceLimitPerType = 1;
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const first = core.upsertTask(task("task-page-1", "asset-1"));
    const second = core.upsertTask(task("task-page-2", "asset-1"));
    await client.changedSince();

    expect(core.requests.some((request) => request.startsWith("/queries/changed-since?") && request.includes("task_cursor="))).toBe(true);
    expect(watch).toHaveBeenCalledWith(first, expect.objectContaining({ id: "task-page-1", version: first.metadata.version }));
    expect(watch).toHaveBeenCalledWith(second, expect.objectContaining({ id: "task-page-2", version: second.metadata.version }));
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("rejects repeated changed-since cursor states", async () => {
    const core = new FakeCore();
    let changedSinceRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/changed-since") return core.fetch(String(url), init);
      changedSinceRequests += 1;
      if (changedSinceRequests > 4) throw new Error("test stopped repeated changed-since pagination");
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        deleted_entities: [],
        deleted_tasks: [],
        deleted_objects: [],
        has_more_entities: true,
        next_entity_cursor: "same-cursor",
        has_more_tasks: true,
        next_task_cursor: `task-cursor-${changedSinceRequests}`,
        version: 0
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });

    await expect(client.changedSince()).rejects.toThrow("Atlas changed-since pagination repeated entity_cursor");
    expect(changedSinceRequests).toBe(2);
  });

  it("ignores in-flight changed-since results after stop", async () => {
    let resolveChangedSince!: (response: Response) => void;
    const changedSinceResponse = new Promise<Response>((resolve) => {
      resolveChangedSince = resolve;
    });
    const fetchImpl: typeof fetch = (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/queries/changed-since") {
        return changedSinceResponse;
      }
      return Promise.resolve(new Response(JSON.stringify({ success: false, message: "not found", error_code: "ENTITY_NOT_FOUND" }), { status: 404 }));
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });

    const recovery = client.changedSince();
    client.sync.stop();
    resolveChangedSince(
      new Response(
        JSON.stringify({
          entities: [{ ...entity("asset-after-stop"), metadata: metadata(1) }],
          tasks: [],
          objects: [],
          deleted_entities: [],
          deleted_tasks: [],
          deleted_objects: [],
          version: 1
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
    await recovery;

    expect(client.sync.status().lastVersion).toBe(0);
  });

  it("does not advance the global change cursor from point reads", async () => {
    const core = new FakeCore();
    const baseline = core.upsertEntity(entity("asset-baseline-read"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    const unseenTask = core.upsertTask(task("task-unseen-before-read", "asset-baseline-read"));
    const newerEntity = core.upsertEntity({ ...entity("asset-point-read"), alias: "fresh" });
    core.requests = [];

    await expect(client.entities.get(newerEntity.entity_id, { fresh: true })).resolves.toEqual(newerEntity);

    expect(client.sync.status().lastVersion).toBe(baseline.metadata.version);
    await client.changedSince();
    expect(core.requests.find((request) => request.startsWith("/queries/changed-since?"))).toContain(`since_version=${baseline.metadata.version}`);
    await expect(client.tasks.get(unseenTask.task_id)).resolves.toEqual(unseenTask);
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("replaces pre-start point-read cache state at the hydration watermark", async () => {
    const core = new FakeCore();
    const cached = core.upsertEntity(entity("asset-deleted-before-hydration"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });

    await expect(client.entities.get(cached.entity_id)).resolves.toEqual(cached);
    expect(client.sync.snapshot().entities).toEqual({ [cached.entity_id]: cached });
    const deletion = core.deleteEntity(cached.entity_id);
    if (!deletion) throw new Error("fake core did not delete the hydration fixture");

    await client.sync.start();

    const snapshot = client.sync.snapshot();
    expect(snapshot.entities).toEqual({});
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entities)).toBe(true);
    expect(client.sync.status().lastVersion).toBe(deletion.version);
    expect(core.requests).toContain(`/queries/changed-since?since_version=${deletion.version}`);
  });

  it("does not advance the global change cursor from optimistic local writes", async () => {
    const core = new FakeCore();
    const baseline = core.upsertEntity(entity("asset-baseline-write"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    const unseenTask = core.upsertTask(task("task-unseen-before-write", "asset-baseline-write"));
    core.requests = [];
    const written = await client.entities.create({ entity_id: "asset-local-write", entity_type: "asset" });

    expect(client.sync.status().lastVersion).toBe(baseline.metadata.version);
    await expect(client.entities.get(written.entity_id)).resolves.toEqual(written);
    await client.changedSince();
    expect(core.requests.find((request) => request.startsWith("/queries/changed-since?"))).toContain(`since_version=${baseline.metadata.version}`);
    await expect(client.tasks.get(unseenTask.task_id)).resolves.toEqual(unseenTask);
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("lets changed-since recovery replace a delete tombstone with a later recreated resource", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-recreated"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.entities.watch("asset-recreated", watch);

    await client.entities.delete(original.entity_id);
    const recreated = core.upsertEntity({ ...entity("asset-recreated"), alias: "back" });
    await client.changedSince();

    expect(watch).toHaveBeenCalledWith(recreated, expect.objectContaining({ event: "recovered", id: "asset-recreated", version: recreated.metadata.version }));
    await expect(client.entities.get("asset-recreated")).resolves.toEqual(recreated);
  });

  it("does not let stale changed-since recovery resurrect an uncached local delete", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const live = core.upsertEntity(entity("asset-delete-race"));
    const watch = vi.fn();
    client.entities.watch(live.entity_id, watch);

    await client.entities.delete(live.entity_id);
    const deleteEvent = core.deletions.at(-1);
    if (!deleteEvent) throw new Error("fake core did not record delete event");
    core.events = core.events.filter((event) => event.version < deleteEvent.version);
    core.version = live.metadata.version;

    await client.changedSince();

    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0][1]).toEqual({ event: "local_delete", resource_type: "entity", id: live.entity_id });
    await expect(client.entities.get(live.entity_id)).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND"
    });

    core.events.push(deleteEvent);
    core.version = deleteEvent.version;
    await client.changedSince();

    expect(watch).toHaveBeenCalledTimes(1);
    await expect(client.entities.get(live.entity_id)).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND"
    });
  });

  it("drains paginated full-dataset hydration responses", async () => {
    const core = new FakeCore();
    core.fullLimitPerType = 1;
    core.upsertEntity(entity("asset-page-1"));
    core.upsertEntity(entity("asset-page-2"));
    core.upsertTask(task("task-hydrate-1", "asset-page-1"));
    core.upsertTask(task("task-hydrate-2", "asset-page-2"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();

    expect(core.requests.some((request) => request.startsWith("/queries/full?") && request.includes("entity_cursor="))).toBe(true);
    expect(core.requests.some((request) => request.startsWith("/queries/full?") && request.includes("task_cursor="))).toBe(true);
  });

  it("recovers changes after the initial full-dataset watermark instead of advancing from later pages", async () => {
    const core = new FakeCore();
    core.version = 1000;
    const staleEntity = core.upsertEntity(entity("asset-hydration-race"));
    const snapshotVersion = staleEntity.metadata.version;
    const fullDatasetRequests: string[] = [];
    const changedSinceVersions: string[] = [];
    let concurrentUpdate!: EntityResource;
    let laterPageTask!: TaskResource;
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/queries/full") {
        fullDatasetRequests.push(parsed.pathname + parsed.search);
        if (fullDatasetRequests.length === 1) {
          concurrentUpdate = core.upsertEntity({ ...staleEntity, alias: "updated between full pages" });
          laterPageTask = core.upsertTask(task("task-hydration-later-page", staleEntity.entity_id));
          return Response.json({
            entities: [staleEntity],
            tasks: [],
            objects: [],
            version: snapshotVersion,
            has_more_tasks: true,
            next_task_cursor: "later-task-page"
          });
        }
        expect(parsed.searchParams.get("task_cursor")).toBe("later-task-page");
        return Response.json({
          entities: [],
          tasks: [laterPageTask],
          objects: [],
          version: snapshotVersion
        });
      }
      if (parsed.pathname === "/queries/changed-since") {
        changedSinceVersions.push(parsed.searchParams.get("since_version") ?? "");
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

    try {
      await client.sync.start();

      expect(fullDatasetRequests).toHaveLength(2);
      expect(changedSinceVersions[0]).toBe(String(snapshotVersion));
      expect(concurrentUpdate.metadata.version).toBe(1002);
      expect(laterPageTask.metadata.version).toBe(1003);
      expect(client.sync.snapshot().entities[staleEntity.entity_id]).toEqual(concurrentUpdate);
      expect(client.sync.snapshot().tasks[laterPageTask.task_id]).toEqual(laterPageTask);
      expect(client.sync.status().lastVersion).toBe(1003);
    } finally {
      client.sync.stop();
    }
  });

  it("rejects missing full-dataset version watermarks", async () => {
    const core = new FakeCore();
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      return Response.json({ entities: [], tasks: [], objects: [] });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("version watermark must be a non-negative safe integer");
    expect(client.sync.snapshot()).toEqual({ entities: {}, tasks: {}, objects: {} });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid full-dataset version watermark %s", async (version) => {
    const core = new FakeCore();
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      return Response.json({ entities: [], tasks: [], objects: [], version });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("version watermark must be a non-negative safe integer");
  });

  it("rejects changing full-dataset version watermarks", async () => {
    const core = new FakeCore();
    let fullDatasetRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      fullDatasetRequests += 1;
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        version: fullDatasetRequests,
        has_more_entities: fullDatasetRequests === 1,
        next_entity_cursor: fullDatasetRequests === 1 ? "next-page" : undefined
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("changed version watermark from 1 to 2");
    expect(fullDatasetRequests).toBe(2);
    expect(client.sync.snapshot()).toEqual({ entities: {}, tasks: {}, objects: {} });
  });

  it("rejects repeated full-dataset cursor states", async () => {
    const core = new FakeCore();
    let fullDatasetRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      fullDatasetRequests += 1;
      if (fullDatasetRequests > 4) throw new Error("test stopped repeated full-dataset pagination");
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        version: 0,
        has_more_entities: true,
        next_entity_cursor: "same-cursor",
        has_more_tasks: true,
        next_task_cursor: `task-cursor-${fullDatasetRequests}`
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("Atlas full-dataset pagination repeated entity_cursor");
    expect(fullDatasetRequests).toBe(2);
  });

  it("allows advancing full-dataset pagination beyond 100 pages", async () => {
    const core = new FakeCore();
    let fullDatasetRequests = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      fullDatasetRequests += 1;
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        version: 0,
        has_more_entities: fullDatasetRequests <= 100,
        next_entity_cursor: fullDatasetRequests <= 100 ? `cursor-${fullDatasetRequests}` : undefined
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).resolves.toBeUndefined();
    expect(fullDatasetRequests).toBe(101);
  });

  it("does not expose partial hydration when pagination fails", async () => {
    const core = new FakeCore();
    const existing = core.upsertEntity(entity("asset-before-failed-hydration"));
    let failHydration = false;
    let fullDatasetRequests = 0;
    const partial = entity("asset-partial-hydration");
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
      if (!failHydration) return core.fetch(String(url), init);
      fullDatasetRequests += 1;
      return Response.json({
        entities: fullDatasetRequests === 1 ? [partial] : [],
        tasks: [],
        objects: [],
        version: core.version,
        has_more_entities: true,
        next_entity_cursor: "same-cursor",
        has_more_tasks: true,
        next_task_cursor: `task-cursor-${fullDatasetRequests}`
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    const snapshot = client.sync.snapshot();
    client.sync.stop();
    failHydration = true;

    await expect(client.sync.start()).rejects.toThrow("Atlas full-dataset pagination repeated entity_cursor");
    expect(client.sync.snapshot()).toBe(snapshot);
    expect(client.sync.snapshot().entities).toEqual({ [existing.entity_id]: existing });
  });

  it("falls through to Core when no automatic update path exists", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-without-updates"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });

    try {
      await client.sync.start();
      expect(client.sync.status()).toMatchObject({ running: true, healthy: false, degraded: true });

      const updated = core.upsertEntity({ ...original, alias: "fresh from Core" });
      core.requests = [];

      await expect(client.entities.get(original.entity_id)).resolves.toEqual(updated);
      expect(core.requests).toContain(`/entities/${original.entity_id}`);
    } finally {
      client.sync.stop();
      vi.unstubAllGlobals();
    }
  });

  it("treats polling as the update path when WebSocket is unavailable", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 60_000 });

    try {
      await client.sync.start();
      expect(client.sync.status()).toMatchObject({ running: true, healthy: true, degraded: false });
    } finally {
      client.sync.stop();
      vi.unstubAllGlobals();
    }
  });

  it("treats polling as the update path while WebSocket is disconnected", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 60_000
    });

    try {
      await client.sync.start();
      const socket = [...core.sockets][0];
      if (!socket) throw new Error("expected an initial feed socket");
      socket.close();
      await client.changedSince();

      expect(client.sync.status()).toMatchObject({ running: true, healthy: true, degraded: false });
    } finally {
      client.sync.stop();
    }
  });

  it("returns pure live cache snapshots after paginated hydration and deletes", async () => {
    const core = new FakeCore();
    core.fullLimitPerType = 1;
    const firstEntity = core.upsertEntity(entity("asset-snapshot-1"));
    const secondEntity = core.upsertEntity(entity("asset-snapshot-2"));
    const firstTask = core.upsertTask(task("task-snapshot-1", firstEntity.entity_id));
    const deletedTask = core.upsertTask(task("task-snapshot-deleted", secondEntity.entity_id));
    const cachedObject = core.upsertObject(object("object-snapshot"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    const requestCount = core.requests.length;
    const first = client.sync.snapshot();
    const second = client.sync.snapshot();

    expect(first).toEqual({
      entities: { [firstEntity.entity_id]: firstEntity, [secondEntity.entity_id]: secondEntity },
      tasks: { [firstTask.task_id]: firstTask, [deletedTask.task_id]: deletedTask },
      objects: { [cachedObject.object_id]: cachedObject }
    });
    expect(second).toEqual(first);
    expect(second).toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.entities)).toBe(true);
    expect(Object.isFrozen(second.entities[firstEntity.entity_id])).toBe(true);
    expect(core.requests).toHaveLength(requestCount);

    expect(() => {
      first.entities[firstEntity.entity_id].alias = "caller mutation";
    }).toThrow(TypeError);
    expect(second.entities[firstEntity.entity_id]).toEqual(firstEntity);
    expect(client.sync.snapshot().entities[firstEntity.entity_id]).toEqual(firstEntity);
    await expect(client.entities.get(firstEntity.entity_id)).resolves.toEqual(firstEntity);

    core.deleteTask(deletedTask.task_id);
    await client.changedSince();

    const afterDelete = client.sync.snapshot();
    expect(afterDelete).not.toBe(first);
    expect(afterDelete.entities).toBe(first.entities);
    expect(afterDelete.objects).toBe(first.objects);
    expect(afterDelete.tasks).not.toBe(first.tasks);
    expect(afterDelete.tasks).toEqual({ [firstTask.task_id]: firstTask });
  });

  it("uses one immutable resource value for cache reads and snapshots", () => {
    const cache = new ResourceCache();
    const source = {
      ...entity("asset-cache-owned"),
      alias: "server value",
      components: { health: { battery_percent: 87 } },
      metadata: metadata(1)
    };

    expect(cache.cacheResource("entity", source.entity_id, source)).toBe(true);
    const cached = cache.value("entity", source.entity_id);
    const snapshot = cache.snapshot();

    expect(cached).toBe(snapshot.entities[source.entity_id]);
    expect(cached).not.toBe(source);
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached?.components.health)).toBe(true);

    Reflect.set(source, "alias", "source mutation");
    Reflect.set(source.components.health, "battery_percent", 1);
    if (cached) {
      Reflect.set(cached, "alias", "read mutation");
      if (cached.components.health) Reflect.set(cached.components.health, "battery_percent", 0);
    }

    expect(cache.value("entity", source.entity_id)?.alias).toBe("server value");
    expect(cache.value("entity", source.entity_id)?.components.health?.battery_percent).toBe(87);
    expect(cache.snapshot()).toBe(snapshot);
    expect(cache.snapshot().entities[source.entity_id].alias).toBe("server value");
  });

  it("preserves snapshot references and version guards across object detail upgrades", () => {
    const cache = new ResourceCache();
    const cachedEntity = { ...entity("asset-detail-reference"), metadata: metadata(1) };
    const summary = { ...object("object-detail-upgrade"), metadata: metadata(2) };
    cache.cacheResource("entity", cachedEntity.entity_id, cachedEntity);
    cache.cacheResource("object", summary.object_id, summary);
    const beforeDetail = cache.snapshot();
    const detail = { ...summary, payload: { nested: { confidence: 0.91 } } };

    expect(cache.cacheResource("object", detail.object_id, detail, { detail: true })).toBe(true);
    const afterDetail = cache.snapshot();

    expect(afterDetail).not.toBe(beforeDetail);
    expect(afterDetail.entities).toBe(beforeDetail.entities);
    expect(afterDetail.objects).not.toBe(beforeDetail.objects);
    expect(cache.value("object", detail.object_id)).toBe(afterDetail.objects[detail.object_id]);
    expect(cache.entry("object", detail.object_id)).toMatchObject({ version: 2, detail: true });
    expect(afterDetail.objects[detail.object_id]).toMatchObject({ payload: detail.payload });
    expect(Object.isFrozen(Reflect.get(afterDetail.objects[detail.object_id], "payload").nested)).toBe(true);

    const stale = { ...summary, type: "stale", metadata: metadata(1) };
    expect(cache.cacheResource("object", stale.object_id, stale, { detail: true })).toBe(false);
    expect(cache.cacheResource("object", summary.object_id, summary)).toBe(false);
    expect(cache.cacheResource("object", detail.object_id, detail, { detail: true })).toBe(false);
    expect(cache.snapshot()).toBe(afterDetail);
    expect(cache.value("object", detail.object_id)).toMatchObject({ type: summary.type, payload: detail.payload });
  });

  it("projects feed, recovery, remote-delete, and local-delete changes through snapshots", async () => {
    const core = new FakeCore();
    const localTask = core.upsertTask(task("task-snapshot-local-delete", "asset-snapshot-feed"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const snapshots = vi.fn(() => client.sync.snapshot());
    client.watch({ filter: "all" }, snapshots);

    const fedEntity = core.upsertEntity(entity("asset-snapshot-feed"));
    core.emit({ event: "create", resource_type: "entity", id: fedEntity.entity_id, version: fedEntity.metadata.version, resource: fedEntity }, { record: false });
    await vi.waitFor(() => expect(snapshots).toHaveReturnedWith(expect.objectContaining({ entities: { [fedEntity.entity_id]: fedEntity } })));

    const recoveredTask = core.upsertTask(task("task-snapshot-recovered", fedEntity.entity_id));
    await client.changedSince();
    expect(snapshots).toHaveReturnedWith(expect.objectContaining({ tasks: expect.objectContaining({ [recoveredTask.task_id]: recoveredTask }) }));

    core.deleteEntity(fedEntity.entity_id);
    await client.changedSince();
    expect(client.sync.snapshot().entities).not.toHaveProperty(fedEntity.entity_id);

    await client.tasks.delete(localTask.task_id);
    expect(client.sync.snapshot().tasks).not.toHaveProperty(localTask.task_id);
  });

  it("does not let a stale write response regress a newer cached resource", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-stale-write"));
    let resolveWrite!: (response: Response) => void;
    const staleWrite = new Promise<Response>((resolve) => {
      resolveWrite = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "PATCH") return staleWrite;
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

    const write = client.entities.update(original.entity_id, { alias: "stale response" });
    const newer = core.upsertEntity({ ...original, alias: "newer feed value" });
    core.emit({ event: "update", resource_type: "entity", id: newer.entity_id, version: newer.metadata.version, resource: newer }, { record: false });
    await vi.waitFor(() => expect(client.sync.snapshot().entities[original.entity_id]).toEqual(newer));

    resolveWrite(Response.json(original));
    await expect(write).resolves.toEqual(original);
    expect(client.sync.snapshot().entities[original.entity_id]).toEqual(newer);
  });

  it("keeps cached previous values intact for tasks-for-entity routing", async () => {
    const core = new FakeCore();
    const original = core.upsertTask(task("task-owned-previous", "asset-old"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const cached = await client.tasks.get(original.task_id);
    Reflect.set(cached, "entity_id", "asset-caller-mutation");
    const watch = vi.fn();
    client.watch({ filter: "tasks_for_entity", entity_id: "asset-old" }, watch);

    const reassigned = core.upsertTask({ ...original, entity_id: "asset-new" });
    core.emit(
      { event: "update", resource_type: "task", id: reassigned.task_id, version: reassigned.metadata.version, resource: reassigned },
      { record: false }
    );

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(reassigned, expect.objectContaining({ event: "update", id: reassigned.task_id }));
    });
    expect(client.sync.snapshot().tasks[original.task_id].entity_id).toBe("asset-new");
  });

  it("does not start duplicate polling intervals when sync.start is called twice sequentially", async () => {
    vi.useFakeTimers();
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 100 });

    try {
      await client.sync.start();
      await client.sync.start();
      core.requests = [];

      await vi.advanceTimersByTimeAsync(250);

      expect(core.requests.filter((request) => request.startsWith("/queries/changed-since")).length).toBe(2);
    } finally {
      client.sync.stop();
      vi.useRealTimers();
    }
  });

  it("shares one startup path across concurrent sync.start calls", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });

    try {
      const firstStart = client.sync.start();
      const secondStart = client.sync.start();

      await Promise.all([firstStart, secondStart]);

      expect(core.feedConnections).toBe(1);
      expect(core.requests.filter((request) => request.startsWith("/queries/full")).length).toBe(1);
    } finally {
      client.sync.stop();
    }
  });

  it("does not let sync.stop be undone by an in-flight sync.start", async () => {
    const core = new FakeCore();
    let releaseHydration: (() => void) | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === "/queries/full") {
        await new Promise<void>((resolve) => {
          releaseHydration = resolve;
        });
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

    const start = client.sync.start();
    await vi.waitFor(() => expect(releaseHydration).toBeTypeOf("function"));
    client.sync.stop();
    releaseHydration?.();
    await start;

    expect(client.sync.status()).toMatchObject({ running: false, healthy: false, degraded: false });
    expect(core.sockets.size).toBe(0);
  });

  it("does not serve cached point reads while startup recovery is still in flight", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-startup-cache"));
    let releaseRecovery: (() => void) | undefined;
    let delayedRecovery = false;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since" && !delayedRecovery) {
        delayedRecovery = true;
        await new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        });
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

    const start = client.sync.start();
    await vi.waitFor(() => expect(releaseRecovery).toBeTypeOf("function"));
    const updated = core.upsertEntity({ ...entity("asset-startup-cache"), alias: "fresh" });

    await expect(client.entities.get("asset-startup-cache")).resolves.toEqual(updated);

    releaseRecovery?.();
    await start;
  });

  it("evicts local cache entries after successful deletes", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-delete"));
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    await expect(client.entities.get("asset-delete")).resolves.toMatchObject({ entity_id: "asset-delete" });
    await client.entities.delete("asset-delete");

    await expect(client.entities.get("asset-delete")).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND"
    });
  });

  it("emits a local delete notification without fabricating a feed version", async () => {
    const core = new FakeCore();
    core.upsertEntity(entity("asset-delete-uncached"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.connectFeed();
    const watch = vi.fn();
    client.watch({ filter: "id", resource_type: "entity", id: "asset-delete-uncached" }, watch);

    await client.entities.delete("asset-delete-uncached");
    const deleteEvent = core.deletions.at(-1);
    if (!deleteEvent) throw new Error("fake core did not record delete event");
    core.emit(deleteEvent, { record: false });

    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    expect(watch.mock.calls[0][0]).toBeUndefined();
    expect(watch.mock.calls[0][1]).toEqual({ event: "local_delete", resource_type: "entity", id: "asset-delete-uncached" });
    expect(watch.mock.calls[0][1]).not.toHaveProperty("version");
  });

  it("keeps local delete tombstones ahead of stale feed updates", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-delete-stale"));
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.connectFeed();
    const watch = vi.fn();
    client.watch({ filter: "id", resource_type: "entity", id: "asset-delete-stale" }, watch);

    await client.entities.delete("asset-delete-stale");
    core.emit(
      {
        event: "update",
        resource_type: "entity",
        id: "asset-delete-stale",
        version: Number.MAX_SAFE_INTEGER - 1,
        // The stale payload uses a huge safe version to prove newer-looking updates cannot override deletes.
        resource: { ...original, alias: "stale", metadata: { ...original.metadata, version: Number.MAX_SAFE_INTEGER - 1 } }
      },
      { record: false }
    );

    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    expect(watch.mock.calls[0][0]).toBeUndefined();
    expect(watch.mock.calls[0][1]).toMatchObject({ event: "local_delete", resource_type: "entity", id: "asset-delete-stale" });
    await expect(client.entities.get("asset-delete-stale")).rejects.toMatchObject({
      status: 404,
      errorCode: "ENTITY_NOT_FOUND"
    });
  });

  it("re-arms reconnect when a replacement socket closes during recovery", async () => {
    const core = new FakeCore();
    let delayNextChangedSince = false;
    let releaseRecovery: (() => void) | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === "/queries/changed-since" && delayNextChangedSince) {
        delayNextChangedSince = false;
        await new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        });
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

    try {
      await client.sync.start();
      const initialSocket = Array.from(core.sockets)[0];
      delayNextChangedSince = true;
      const recovery = client.connectAndRecoverFeed();

      await vi.waitFor(() => {
        expect(releaseRecovery).toBeTypeOf("function");
      });
      const recoverySocket = Array.from(core.sockets).find((socket) => socket !== initialSocket);
      expect(recoverySocket).toBeDefined();

      recoverySocket?.close();
      releaseRecovery?.();
      await recovery;

      expect(client.sync.status()).toMatchObject({ healthy: false, degraded: true });
      await vi.waitFor(
        () => {
          expect(client.sync.status().healthy).toBe(true);
        },
        { timeout: 2500 }
      );
      expect(core.sockets.size).toBe(1);
      expect(core.sockets.has(recoverySocket!)).toBe(false);
    } finally {
      client.sync.stop();
    }
  });

  it("fails loudly when the fake core records duplicate event versions", () => {
    const core = new FakeCore();
    const value = core.upsertEntity(entity("asset-duplicate-version"));

    expect(() =>
      core.emit({ event: "update", resource_type: "entity", id: value.entity_id, version: value.metadata.version, resource: value })
    ).toThrow("duplicate fake core event version");
  });

  it("keeps successful writes successful when watch callbacks throw", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    client.entities.watch("asset-throwing-write-watch", () => {
      throw new Error("watch failed");
    });

    try {
      await expect(client.entities.create({ entity_id: "asset-throwing-write-watch", entity_type: "asset" })).resolves.toMatchObject({ entity_id: "asset-throwing-write-watch" });
      expect(client.sync.status().degraded).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("isolates cache state and later watchers from watch callback mutation", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const id = "asset-mutating-watch";
    const mutationResults: boolean[] = [];
    client.entities.watch(id, (value) => {
      if (value) mutationResults.push(Reflect.set(value, "alias", "watch mutation"));
    });
    const observer = vi.fn();
    client.entities.watch(id, observer);

    const updated = core.upsertEntity({ ...entity(id), alias: "server value" });
    core.emit({ event: "update", resource_type: "entity", id, version: updated.metadata.version, resource: updated }, { record: false });

    await vi.waitFor(() => {
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ alias: "server value" }), expect.objectContaining({ id }));
    });
    expect(mutationResults).toEqual([false]);
    expect(client.sync.snapshot().entities[id].alias).toBe("server value");
    await expect(client.entities.get(id)).resolves.toMatchObject({ alias: "server value" });
  });

  it("honors explicit tasks-for-entity subscriptions across reassignment", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: false,
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.subscribe({ filter: "tasks_for_entity", entity_id: "asset-old" });
    const watch = vi.fn();
    client.watch({ filter: "tasks_for_entity", entity_id: "asset-old" }, watch);
    await client.connectFeed();

    const first = core.upsertTask(task("task-reassign", "asset-old"));
    core.emit({ event: "create", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first }, { record: false });
    const reassigned = core.upsertTask({ ...first, entity_id: "asset-new" });
    core.emit(
      { event: "update", resource_type: "task", id: reassigned.task_id, version: reassigned.metadata.version, resource: reassigned },
      { beforeTaskEntityId: "asset-old", record: false }
    );

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(reassigned, expect.objectContaining({ id: "task-reassign", version: reassigned.metadata.version }));
    });
  });

  it("sends unsubscribe frames and stops delivering removed watch callbacks", async () => {
    const core = new FakeCore();
    const filter = { filter: "type", resource_type: "task" } as const;
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: false,
      pollIntervalMs: 0
    });
    await client.sync.start();
    await client.subscribe(filter);
    const watch = vi.fn();
    const removeWatch = client.watch(filter, watch);
    await client.connectFeed();
    const socket = Array.from(core.sockets)[0];

    const first = core.upsertTask(task("task-unsubscribe-before", "asset-1"));
    core.emit({ event: "create", resource_type: "task", id: first.task_id, version: first.metadata.version, resource: first }, { record: false });
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));

    await client.unsubscribe(filter);
    removeWatch();

    expect(client.sync.status().subscriptions).toEqual([]);
    expect(socket.sentMessages).toContainEqual({ action: "unsubscribe", filter: "type", resource_type: "task" });
    const second = core.upsertTask(task("task-unsubscribe-after", "asset-1"));
    core.emit({ event: "create", resource_type: "task", id: second.task_id, version: second.metadata.version, resource: second }, { record: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("returns isolated buffers while caching object content by version", async () => {
    const core = new FakeCore();
    core.upsertObject(object("object-1"));
    const fetchSpy = vi.fn(core.fetch);
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchSpy, sync: "all", pollIntervalMs: 0, objectContentCacheEntries: 4 });
    await client.sync.start();
    const first = await client.objects.content("object-1");
    new Uint8Array(first)[0] = 99;
    const second = await client.objects.content("object-1");
    new Uint8Array(second)[1] = 88;
    const third = await client.objects.content("object-1");
    const downloads = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/download"));

    expect([...new Uint8Array(second)]).toEqual([1, 88, 3]);
    expect([...new Uint8Array(third)]).toEqual([1, 2, 3]);
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
    expect(downloads).toHaveLength(1);
  });

  it("retries object content download when metadata changes mid-flight", async () => {
    const core = new FakeCore();
    core.upsertObject(object("object-1"));
    let raced = false;
    core.onObjectDownload = (id) => {
      if (!raced) {
        raced = true;
        core.upsertObject({ ...object(id), type: "log" });
      }
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0, objectContentCacheEntries: 4 });
    await client.sync.start();

    await expect(client.objects.content("object-1")).resolves.toBeInstanceOf(ArrayBuffer);
    expect(core.objectDownloadCount).toBe(2);

    await expect(client.objects.content("object-1")).resolves.toBeInstanceOf(ArrayBuffer);
    expect(core.objectDownloadCount).toBe(2);
  });

  it("exposes typed watch helpers for all resource surfaces", () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });

    expect(typeof client.entities.watch("asset-watch", vi.fn())).toBe("function");
    expect(typeof client.tasks.watch("task-watch", vi.fn())).toBe("function");
    expect(typeof client.objects.watch("object-watch", vi.fn())).toBe("function");
  });

  it("rejects resources written into the wrong cache bucket", () => {
    const cache = new ResourceCache();
    const cacheResource = cache.cacheResource.bind(cache) as (type: ResourceType, id: string, value: ResourceValue) => boolean;
    const taskPayload = task("task-cache-cross-type", "asset-cache-cross-type");

    expect(() => cacheResource("entity", "asset-cache-cross-type", taskPayload)).toThrow("cannot be used as entity");
    expect(cache.entry("entity", "asset-cache-cross-type")).toBeUndefined();
  });

  it("does not commit a cache entry when snapshot cloning fails", () => {
    const cache = new ResourceCache();
    const original = { ...entity("asset-cache-clone-failure"), metadata: metadata(1) };
    cache.cacheResource("entity", original.entity_id, original);
    const snapshot = cache.snapshot();
    const uncloneable = {
      ...original,
      alias: "uncloneable update",
      metadata: metadata(2),
      invalid_runtime_value: () => undefined
    };

    expect(() => cache.cacheResource("entity", original.entity_id, uncloneable)).toThrow();
    expect(cache.value("entity", original.entity_id)).toEqual(original);
    expect(cache.snapshot()).toBe(snapshot);
  });

  it("does not let feed events whose resource payload crosses resource types stop later events", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({
      baseUrl: "http://atlas.test",
      fetch: core.fetch,
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "entity" }, watch);

    const taskPayload = { ...task("task-watch-cross-type", null), metadata: metadata(1) };
    const mismatchedEvent = {
      event: "update",
      resource_type: "entity",
      id: "asset-watch-cross-type",
      version: 1,
      resource: taskPayload
    } as unknown as FeedEvent;
    core.emit(mismatchedEvent, { record: false });

    await vi.waitFor(() => expect(client.sync.status()).toMatchObject({ healthy: false, degraded: true }));
    expect(watch).not.toHaveBeenCalled();

    await client.changedSince();
    expect(client.sync.status()).toMatchObject({ healthy: true, degraded: false });

    const valid = core.upsertEntity(entity("asset-watch-cross-type-valid"));
    core.emit(
      { event: "update", resource_type: "entity", id: valid.entity_id, version: valid.metadata.version, resource: valid },
      { record: false }
    );

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(valid, expect.objectContaining({ resource_type: "entity", id: valid.entity_id }));
    });
  });

  it("stops delivering events after unwatch without affecting other watchers", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const beforeWatch = vi.fn();
    const removedWatch = vi.fn();
    const afterWatch = vi.fn();

    client.entities.watch("asset-watch-before", beforeWatch);
    const unwatch = client.entities.watch("asset-watch-prune", removedWatch);

    unwatch();
    client.entities.watch("asset-watch-after", afterWatch);

    const beforeEntity = core.upsertEntity(entity("asset-watch-before"));
    core.upsertEntity(entity("asset-watch-prune"));
    const afterEntity = core.upsertEntity(entity("asset-watch-after"));

    await client.changedSince();

    expect(beforeWatch).toHaveBeenCalledWith(beforeEntity, expect.objectContaining({ event: "recovered", id: "asset-watch-before" }));
    expect(removedWatch).not.toHaveBeenCalled();
    expect(afterWatch).toHaveBeenCalledWith(afterEntity, expect.objectContaining({ event: "recovered", id: "asset-watch-after" }));
  });

  it("rejects malformed stored subscription keys", () => {
    expect(() => parseSubscriptionKey("not-json")).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["unknown", "entity-1"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["type", "not-a-type"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["id", "task"]))).toThrow("invalid subscription key");
    expect(() => parseSubscriptionKey(JSON.stringify(["tasks_for_entity", ""]))).toThrow("invalid subscription key");
  });

});
