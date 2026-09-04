import { describe, expect, it, vi } from "vitest";
import { AtlasClient, type FeedEvent, type TaskResource } from "../src";
import { ObjectContentCache, ResourceCache } from "../src/cache.js";
import { createAtlasClient } from "./support/client.js";
import { entity, FakeCore, metadata, object, task } from "./support/fake-core.js";

describe("AtlasClient sync: cache projection and reads", () => {
  it("unsubscribes duplicate snapshot watcher registrations independently", async () => {
    const core = new FakeCore();
    const client = createAtlasClient(core);
    const watcher = vi.fn();
    const unsubscribeFirst = client.sync.watchSnapshot(watcher);
    const unsubscribeSecond = client.sync.watchSnapshot(watcher);

    await client.entities.create({ entity_id: "asset-first", entity_type: "asset" });
    expect(watcher).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    await client.entities.create({ entity_id: "asset-second", entity_type: "asset" });
    expect(watcher).toHaveBeenCalledTimes(3);

    unsubscribeSecond();
    await client.entities.create({ entity_id: "asset-third", entity_type: "asset" });
    expect(watcher).toHaveBeenCalledTimes(3);
  });

  it("enforces a positive safe-integer object content cache capacity", () => {
    const core = new FakeCore();
    for (const objectContentCacheEntries of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch, objectContentCacheEntries })
      ).toThrow("objectContentCacheEntries must be a positive safe integer");
    }
  });

  it("evicts the least recently used object content at the configured capacity", () => {
    const cache = new ObjectContentCache(2);
    cache.set("first", Uint8Array.of(1).buffer);
    cache.set("second", Uint8Array.of(2).buffer);

    expect(Array.from(new Uint8Array(cache.get("first")!))).toEqual([1]);
    cache.set("third", Uint8Array.of(3).buffer);

    expect(cache.get("second")).toBeUndefined();
    expect(Array.from(new Uint8Array(cache.get("first")!))).toEqual([1]);
    expect(Array.from(new Uint8Array(cache.get("third")!))).toEqual([3]);
  });

  it("does not advance the global change cursor from point reads", async () => {
    const core = new FakeCore();
    const baseline = core.upsertEntity(entity("asset-baseline-read"));
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    const unseenTask = core.upsertTask(task("task-unseen-before-read", "asset-baseline-read"));
    const newerEntity = core.upsertEntity({ ...entity("asset-point-read"), alias: "fresh" });
    core.requests = [];

    await expect(client.entities.get(newerEntity.entity_id, { fresh: true })).resolves.toEqual(newerEntity);

    expect(client.sync.status().lastVersion).toBe(baseline.metadata.version);
    await client.changedSince();
    expect(core.requests.find((request) => request.startsWith("/queries/changed-since?"))).toContain(
      `since_version=${baseline.metadata.version}`
    );
    await expect(client.tasks.get(unseenTask.task_id)).resolves.toEqual(unseenTask);
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("projects an uncached Task point read without advancing the change cursor", async () => {
    const core = new FakeCore();
    const taskResource = core.upsertTask(task("task-point-read", "asset-point-read"));
    const client = createAtlasClient(core);
    const snapshots = vi.fn();
    client.sync.watchSnapshot(snapshots);

    await expect(client.tasks.get(taskResource.task_id)).resolves.toEqual(taskResource);

    expect(client.sync.snapshot().tasks[taskResource.task_id]).toEqual(taskResource);
    expect(snapshots).toHaveBeenLastCalledWith(
      expect.objectContaining({ tasks: { [taskResource.task_id]: taskResource } })
    );
    expect(client.sync.status().lastVersion).toBe(0);
  });

  it("replaces pre-start point-read cache state at the hydration watermark", async () => {
    const core = new FakeCore();
    const cached = core.upsertEntity(entity("asset-deleted-before-hydration"));
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });

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
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });
    await client.sync.start();

    const unseenTask = core.upsertTask(task("task-unseen-before-write", "asset-baseline-write"));
    core.requests = [];
    const written = await client.entities.create({ entity_id: "asset-local-write", entity_type: "asset" });

    expect(client.sync.status().lastVersion).toBe(baseline.metadata.version);
    await expect(client.entities.get(written.entity_id)).resolves.toEqual(written);
    await client.changedSince();
    expect(core.requests.find((request) => request.startsWith("/queries/changed-since?"))).toContain(
      `since_version=${baseline.metadata.version}`
    );
    await expect(client.tasks.get(unseenTask.task_id)).resolves.toEqual(unseenTask);
    expect(client.sync.status().lastVersion).toBe(core.version);
  });

  it("lets changed-since recovery replace a delete marker with a later recreated resource", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-recreated"));
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const watch = vi.fn();
    client.entities.watch("asset-recreated", watch);

    await client.entities.delete(original.entity_id);
    const recreated = core.upsertEntity({ ...entity("asset-recreated"), alias: "back" });
    await client.changedSince();

    expect(watch).toHaveBeenCalledWith(
      recreated,
      expect.objectContaining({ event: "update", id: "asset-recreated", version: recreated.metadata.version })
    );
    await expect(client.entities.get("asset-recreated")).resolves.toEqual(recreated);
  });

  it("does not let stale changed-since recovery resurrect an uncached local delete", async () => {
    const core = new FakeCore();
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const live = core.upsertEntity(entity("asset-delete-race"));
    const watch = vi.fn();
    client.entities.watch(live.entity_id, watch);

    await client.entities.delete(live.entity_id);
    const deleteEvent = core.deleteEvents.at(-1);
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

  it("does not acknowledge a pending local delete from a stale feed delete event", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-stale-delete"));
    const client = createAtlasClient(core, {
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const applyFeedEvent = (
      client as unknown as { engine: { applyEvent(event: FeedEvent): void } }
    ).engine.applyEvent.bind((client as unknown as { engine: object }).engine);
    const watch = vi.fn();
    client.entities.watch(original.entity_id, watch);

    await client.entities.delete(original.entity_id);
    const authoritativeDelete = core.deleteEvents.at(-1);
    if (!authoritativeDelete) throw new Error("fake core did not record delete event");
    core.events = core.events.filter((event) => event.version !== authoritativeDelete.version);
    const recreated = core.upsertEntity({ ...entity(original.entity_id), alias: "authoritative but suppressed" });

    applyFeedEvent({
      event: "delete",
      resource_type: "entity",
      id: original.entity_id,
      version: original.metadata.version
    });
    await client.changedSince();

    expect(client.sync.snapshot().entities[original.entity_id]).toBeUndefined();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0][1]).toMatchObject({ event: "local_delete", id: original.entity_id });
    expect(client.sync.status().lastVersion).toBe(recreated.metadata.version);

    const confirmingDelete = core.deleteEntity(original.entity_id);
    if (!confirmingDelete) throw new Error("fake core did not record confirming delete event");
    applyFeedEvent(confirmingDelete);
    const visible = core.upsertEntity({ ...recreated, alias: "visible after authoritative delete" });
    applyFeedEvent({
      event: "create",
      resource_type: "entity",
      id: visible.entity_id,
      version: visible.metadata.version,
      resource: visible
    });
    expect(client.sync.snapshot().entities[visible.entity_id]).toEqual(visible);
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("rolls back an in-flight local delete when HTTP fails", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-delete-http-failure"));
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "DELETE") {
        throw new Error("delete request failed");
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
    const watch = vi.fn();
    client.entities.watch(original.entity_id, watch);

    await expect(client.entities.delete(` ${original.entity_id} `)).rejects.toThrow("delete request failed");

    expect(client.sync.snapshot().entities[original.entity_id]).toEqual(original);
    expect(watch).not.toHaveBeenCalled();
    const cache = (client as unknown as { engine: { cache: ResourceCache } }).engine.cache;
    expect(cache.pendingDeletes).toEqual(new Set());
    expect(cache.locallyNotifiedDeletes).toEqual(new Set());
  });

  it("does not double-notify when feed delete wins an in-flight local delete", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-feed-delete-wins"));
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "DELETE") {
        const response = await core.fetch(String(url), init);
        await deleteGate;
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
    const watch = vi.fn();
    client.entities.watch(original.entity_id, watch);

    const deletion = client.entities.delete(original.entity_id);
    await vi.waitFor(() => expect(core.deleteEvents).toHaveLength(1));
    const deleteEvent = core.deleteEvents[0];
    core.emit(deleteEvent, { record: false });
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    releaseDelete();

    await expect(deletion).resolves.toBeUndefined();
    expect(watch).toHaveBeenCalledWith(undefined, deleteEvent);
    const cache = (client as unknown as { engine: { cache: ResourceCache } }).engine.cache;
    expect(cache.pendingDeletes).toEqual(new Set());
    expect(cache.locallyNotifiedDeletes).toEqual(new Set());
  });

  it("keeps a newer same-ID recreation visible when it races an in-flight delete", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-feed-recreated"));
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "DELETE") {
        const response = await core.fetch(String(url), init);
        await deleteGate;
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
    const watch = vi.fn();
    client.entities.watch(original.entity_id, watch);

    const deletion = client.entities.delete(original.entity_id);
    await vi.waitFor(() => expect(core.deleteEvents).toHaveLength(1));
    const deleteEvent = core.deleteEvents[0];
    core.emit(deleteEvent, { record: false });
    const recreated = core.createEntity({ entity_id: original.entity_id, entity_type: "asset" });
    core.emit(core.events.at(-1)!, { record: false });
    await vi.waitFor(() => expect(client.sync.snapshot().entities[original.entity_id]).toEqual(recreated));
    releaseDelete();

    await expect(deletion).resolves.toBeUndefined();
    expect(watch).toHaveBeenCalledTimes(2);
    expect(watch.mock.calls[0]).toEqual([undefined, deleteEvent]);
    expect(watch.mock.calls[1]).toEqual([recreated, expect.objectContaining({ event: "create" })]);
    const cache = (client as unknown as { engine: { cache: ResourceCache } }).engine.cache;
    expect(cache.pendingDeletes).toEqual(new Set());
    expect(cache.locallyNotifiedDeletes).toEqual(new Set());
  });

  it("keeps a fresh point read visible after an older delete response arrives", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-point-read-recreated"));
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "DELETE") {
        const response = await core.fetch(String(url), init);
        await deleteGate;
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

    const deletion = client.entities.delete(original.entity_id);
    await vi.waitFor(() => expect(core.deleteEvents).toHaveLength(1));
    const recreated = core.upsertEntity({ ...entity(original.entity_id), alias: "fresh point read" });
    await expect(client.entities.get(original.entity_id, { fresh: true })).resolves.toEqual(recreated);
    releaseDelete();

    await expect(deletion).resolves.toBeUndefined();
    expect(client.sync.snapshot().entities[original.entity_id]).toEqual(recreated);
  });

  it("deletes an updated same-instance resource when the update precedes server deletion", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-update-before-delete"));
    let deleteStarted = false;
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "DELETE") {
        deleteStarted = true;
        await deleteGate;
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
    const watch = vi.fn();
    client.entities.watch(original.entity_id, watch);

    const deletion = client.entities.delete(original.entity_id);
    await vi.waitFor(() => expect(deleteStarted).toBe(true));
    const updated = await client.entities.update(original.entity_id, { alias: "updated before delete" });
    expect(updated.metadata.created_at).toBe(original.metadata.created_at);
    releaseDelete();

    await expect(deletion).resolves.toBeUndefined();
    expect(client.sync.snapshot().entities[original.entity_id]).toBeUndefined();
    expect(watch).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({
        event: "local_delete",
        id: original.entity_id,
        previous_version: updated.metadata.version
      })
    );
  });

  it("keeps a recreated hydration entry after an older delete finishes", () => {
    const cache = new ResourceCache();
    const original = entity("asset-hydrated-recreated");
    cache.cacheResource("entity", original.entity_id, original);
    const deletion = cache.beginLocalDelete("entity", original.entity_id);
    const recreated = { ...original, alias: "hydrated recreation", metadata: metadata(2) };

    cache.replaceHydratedResources({ entities: [recreated], tasks: [], objects: [] });

    expect(cache.finishLocalDelete(deletion)).toBeUndefined();
    expect(cache.value("entity", original.entity_id)).toEqual(recreated);
  });

  it("keeps an overlapping successful delete when the older request fails", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-overlapping-deletes"));
    let deleteAttempts = 0;
    let failFirstDelete!: () => void;
    const firstDeleteGate = new Promise<void>((resolve) => {
      failFirstDelete = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          await firstDeleteGate;
          throw new Error("older delete failed");
        }
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
    const watch = vi.fn();
    client.entities.watch(original.entity_id, watch);

    const failingDelete = client.entities.delete(original.entity_id);
    await vi.waitFor(() => expect(deleteAttempts).toBe(1));
    await expect(client.entities.delete(original.entity_id)).resolves.toBeUndefined();
    failFirstDelete();
    await expect(failingDelete).rejects.toThrow("older delete failed");

    expect(client.sync.snapshot().entities[original.entity_id]).toBeUndefined();
    expect(watch).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledWith(undefined, expect.objectContaining({ event: "local_delete" }));
  });

  it("enforces instance-token preconditions and omits the header when no token is supplied", async () => {
    const core = new FakeCore();
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: core.fetch });
    const tokenized = await client.entities.create(
      { entity_id: "asset-token-precondition", entity_type: "asset" },
      { instanceToken: "expected-token" }
    );

    await expect(client.entities.delete(tokenized.entity_id, { instanceToken: "wrong-token" })).rejects.toMatchObject({
      status: 412,
      errorCode: "PRECONDITION_FAILED"
    });
    expect(core.entities.has(tokenized.entity_id)).toBe(true);

    await expect(
      client.entities.delete(tokenized.entity_id, { instanceToken: "expected-token" })
    ).resolves.toBeUndefined();
    const tokenizedObject = await client.objects.create(
      { object_id: "object-token-precondition" },
      { instanceToken: "expected-object-token" }
    );
    await expect(
      client.objects.delete(tokenizedObject.object_id, { instanceToken: "wrong-object-token" })
    ).rejects.toMatchObject({ status: 412, errorCode: "PRECONDITION_FAILED" });
    expect(core.objects.has(tokenizedObject.object_id)).toBe(true);
    await expect(
      client.objects.delete(tokenizedObject.object_id, { instanceToken: "expected-object-token" })
    ).resolves.toBeUndefined();
    const tokenless = await client.entities.create({ entity_id: "asset-tokenless-delete", entity_type: "asset" });
    await expect(client.entities.delete(tokenless.entity_id)).resolves.toBeUndefined();
    expect(
      core.requestHeaders.find((request) => request.path === `/entities/${tokenless.entity_id}`)?.instanceToken
    ).toBeNull();
  });

  it("drains paginated full-dataset hydration responses", async () => {
    const core = new FakeCore();
    core.fullLimitPerType = 1;
    core.upsertEntity(entity("asset-page-1"));
    core.upsertEntity(entity("asset-page-2"));
    core.upsertTask(task("task-hydrate-1", "asset-page-1"));
    core.upsertTask(task("task-hydrate-2", "asset-page-2"));
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });

    await client.sync.start();

    expect(
      core.requests.some((request) => request.startsWith("/queries/full?") && request.includes("entity_cursor="))
    ).toBe(true);
    expect(
      core.requests.some((request) => request.startsWith("/queries/full?") && request.includes("task_cursor="))
    ).toBe(true);
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
            has_more_entities: false,
            has_more_objects: false,
            next_task_cursor: "later-task-page"
          });
        }
        expect(parsed.searchParams.get("task_cursor")).toBe("later-task-page");
        return Response.json({
          entities: [],
          tasks: [laterPageTask],
          objects: [],
          version: snapshotVersion,
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false
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
      return Response.json({
        entities: [],
        tasks: [],
        objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });

    await expect(client.sync.start()).rejects.toThrow("Atlas response failed validation for GET /queries/full");
    expect(client.sync.snapshot()).toEqual({ entities: {}, tasks: {}, objects: {} });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid full-dataset version watermark %s",
    async (version) => {
      const core = new FakeCore();
      const fetchImpl: typeof fetch = async (url, init) => {
        if (new URL(String(url)).pathname !== "/queries/full") return core.fetch(String(url), init);
        return Response.json({
          entities: [],
          tasks: [],
          objects: [],
          version,
          has_more_entities: false,
          has_more_tasks: false,
          has_more_objects: false
        });
      };
      const client = new AtlasClient({
        baseUrl: "http://atlas.test",
        fetch: fetchImpl,
        sync: "all",
        pollIntervalMs: 0
      });

      await expect(client.sync.start()).rejects.toThrow("Atlas response failed validation for GET /queries/full");
    }
  );

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
        has_more_tasks: false,
        has_more_objects: false,
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
        next_task_cursor: `task-cursor-${fullDatasetRequests}`,
        has_more_objects: false
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
        next_entity_cursor: fullDatasetRequests <= 100 ? `cursor-${fullDatasetRequests}` : undefined,
        has_more_tasks: false,
        has_more_objects: false
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
    const partial = { ...entity("asset-partial-hydration"), metadata: metadata(1) };
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
        next_task_cursor: `task-cursor-${fullDatasetRequests}`,
        has_more_objects: false
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
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });

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
    const client = createAtlasClient(core, {
      sync: "all",
      pollIntervalMs: 60_000
    });

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
    const client = createAtlasClient(core, {
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

  it("returns pure live cache snapshots after paginated hydration", async () => {
    const core = new FakeCore();
    core.fullLimitPerType = 1;
    const firstEntity = core.upsertEntity(entity("asset-snapshot-1"));
    const secondEntity = core.upsertEntity(entity("asset-snapshot-2"));
    const firstTask = core.upsertTask(task("task-snapshot-1", firstEntity.entity_id));
    const secondTask = core.upsertTask(task("task-snapshot-2", secondEntity.entity_id));
    const cachedObject = core.upsertObject(object("object-snapshot"));
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });

    await client.sync.start();
    const requestCount = core.requests.length;
    const first = client.sync.snapshot();
    const second = client.sync.snapshot();

    expect(first).toEqual({
      entities: { [firstEntity.entity_id]: firstEntity, [secondEntity.entity_id]: secondEntity },
      tasks: { [firstTask.task_id]: firstTask, [secondTask.task_id]: secondTask },
      objects: { [cachedObject.object_id]: { ...cachedObject, extra: {} } }
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

  it("preserves own __proto__ data properties while cloning cached resources", () => {
    const cache = new ResourceCache();
    const extra = JSON.parse('{"__proto__":{"sentinel":true}}') as Record<string, { sentinel: boolean }>;
    const detail = { ...object("object-proto-key"), extra, metadata: metadata(1) };

    expect(cache.cacheResource("object", detail.object_id, detail, { detail: true })).toBe(true);
    const cached = cache.objectDetail(detail.object_id);

    expect(cached).toBeDefined();
    expect(Object.getPrototypeOf(cached?.extra)).toBe(Object.prototype);
    expect(Object.hasOwn(cached?.extra ?? {}, "__proto__")).toBe(true);
    expect(Reflect.get(cached?.extra ?? {}, "__proto__")).toEqual({ sentinel: true });
  });

  it("preserves snapshot references and version guards across object detail upgrades", () => {
    const cache = new ResourceCache();
    const cachedEntity = { ...entity("asset-detail-reference"), metadata: metadata(1) };
    const summary = { ...object("object-detail-upgrade"), metadata: metadata(2) };
    cache.cacheResource("entity", cachedEntity.entity_id, cachedEntity);
    cache.cacheResource("object", summary.object_id, summary);
    const beforeDetail = cache.snapshot();
    const detail = { ...summary, extra: { nested: { confidence: 0.91 } } };

    expect(cache.objectDetail(summary.object_id)).toBeUndefined();

    expect(cache.cacheResource("object", detail.object_id, detail, { detail: true })).toBe(true);
    const afterDetail = cache.snapshot();

    expect(afterDetail).not.toBe(beforeDetail);
    expect(afterDetail.entities).toBe(beforeDetail.entities);
    expect(afterDetail.objects).not.toBe(beforeDetail.objects);
    expect(cache.value("object", detail.object_id)).toBe(afterDetail.objects[detail.object_id]);
    expect(cache.entry("object", detail.object_id)).toMatchObject({ version: 2, detail: true });
    expect(cache.objectDetail(detail.object_id)).toBe(afterDetail.objects[detail.object_id]);
    expect(afterDetail.objects[detail.object_id]).toMatchObject({ extra: detail.extra });
    expect(Object.isFrozen(Reflect.get(afterDetail.objects[detail.object_id], "extra").nested)).toBe(true);

    const stale = { ...summary, type: "stale", metadata: metadata(1) };
    expect(cache.cacheResource("object", stale.object_id, stale, { detail: true })).toBe(false);
    expect(cache.cacheResource("object", summary.object_id, summary)).toBe(false);
    expect(cache.cacheResource("object", detail.object_id, detail, { detail: true })).toBe(false);
    expect(cache.snapshot()).toBe(afterDetail);
    expect(cache.value("object", detail.object_id)).toMatchObject({ type: summary.type, extra: detail.extra });
  });

  it("projects feed, recovery, remote-delete, and local-delete changes through snapshots", async () => {
    const core = new FakeCore();
    const client = createAtlasClient(core, {
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const snapshots = vi.fn(() => client.sync.snapshot());
    client.watch({ filter: "all" }, snapshots);

    const fedEntity = core.upsertEntity(entity("asset-snapshot-feed"));
    core.emit(
      {
        event: "create",
        resource_type: "entity",
        id: fedEntity.entity_id,
        version: fedEntity.metadata.version,
        resource: fedEntity
      },
      { record: false }
    );
    await vi.waitFor(() =>
      expect(snapshots).toHaveReturnedWith(expect.objectContaining({ entities: { [fedEntity.entity_id]: fedEntity } }))
    );

    const recoveredTask = core.upsertTask(task("task-snapshot-recovered", fedEntity.entity_id));
    await client.changedSince();
    expect(snapshots).toHaveReturnedWith(
      expect.objectContaining({ tasks: expect.objectContaining({ [recoveredTask.task_id]: recoveredTask }) })
    );

    core.deleteEntity(fedEntity.entity_id);
    await client.changedSince();
    expect(client.sync.snapshot().entities).not.toHaveProperty(fedEntity.entity_id);
  });

  it("does not let a stale write response regress a newer cached resource", async () => {
    const core = new FakeCore();
    const original = core.upsertEntity(entity("asset-stale-write"));
    let resolveWrite!: (response: Response) => void;
    const staleWrite = new Promise<Response>((resolve) => {
      resolveWrite = resolve;
    });
    const fetchImpl: typeof fetch = (url, init) => {
      if (new URL(String(url)).pathname === `/entities/${original.entity_id}` && init?.method === "PATCH")
        return staleWrite;
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
    core.emit(
      {
        event: "update",
        resource_type: "entity",
        id: newer.entity_id,
        version: newer.metadata.version,
        resource: newer
      },
      { record: false }
    );
    await vi.waitFor(() => expect(client.sync.snapshot().entities[original.entity_id]).toEqual(newer));

    resolveWrite(Response.json(original));
    await expect(write).resolves.toEqual(original);
    expect(client.sync.snapshot().entities[original.entity_id]).toEqual(newer);
  });

  it("does not let a delayed Task response regress a newer feed state", async () => {
    const core = new FakeCore();
    let releaseCreate!: (response: Response) => void;
    let createResponse: Response | undefined;
    const delayedCreate = new Promise<Response>((resolve) => {
      releaseCreate = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/tasks" && init?.method === "POST") {
        createResponse = await core.fetch(String(url), init);
        return delayedCreate;
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

    const create = client.tasks.create(
      { asset_id: "asset-task-response-race", command: "fixture.queued", input: {} },
      { idempotencyKey: "task-response-race" }
    );
    await vi.waitFor(() => expect(core.tasks.size).toBe(1));
    const pending = [...core.tasks.values()][0];
    const progressed = core.updateTask(pending.task_id, { status: "in_progress", started_at: pending.updated_at });
    core.emit(
      {
        event: "update",
        resource_type: "task",
        id: progressed.task_id,
        version: progressed.metadata.version,
        resource: progressed
      },
      { record: false }
    );
    await vi.waitFor(() => expect(client.sync.snapshot().tasks[progressed.task_id]).toEqual(progressed));

    if (!createResponse) throw new Error("fake Core did not produce the delayed Task response");
    releaseCreate(createResponse);
    await expect(create).resolves.toMatchObject({ task_id: progressed.task_id, status: "pending" });
    expect(client.sync.snapshot().tasks[progressed.task_id]).toEqual(progressed);
  });

  it("does not let a stale fresh Task read regress a newer feed state", async () => {
    const core = new FakeCore();
    const pending = core.upsertTask(task("task-read-response-race", "asset-task-response-race"));
    let releaseRead!: (response: Response) => void;
    let readResponse: Response | undefined;
    const delayedRead = new Promise<Response>((resolve) => {
      releaseRead = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === `/tasks/${pending.task_id}` && init?.method === "GET") {
        readResponse = await core.fetch(String(url), init);
        return delayedRead;
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

    const read = client.tasks.get(pending.task_id, { fresh: true });
    await vi.waitFor(() => expect(readResponse).toBeDefined());
    const progressed = core.updateTask(pending.task_id, { status: "in_progress", started_at: pending.updated_at });
    core.emit(
      {
        event: "update",
        resource_type: "task",
        id: progressed.task_id,
        version: progressed.metadata.version,
        resource: progressed
      },
      { record: false }
    );
    await vi.waitFor(() => expect(client.sync.snapshot().tasks[progressed.task_id]).toEqual(progressed));

    if (!readResponse) throw new Error("fake Core did not produce the delayed Task read response");
    releaseRead(readResponse);
    await expect(read).resolves.toMatchObject({ task_id: pending.task_id, status: "pending" });
    expect(client.sync.snapshot().tasks[progressed.task_id]).toEqual(progressed);
  });

  it("routes immutable Task updates by asset without exposing cached mutations", async () => {
    const core = new FakeCore();
    const original = core.upsertTask(task("task-owned-previous", "asset-old"));
    const client = createAtlasClient(core, {
      WebSocket: core.attachWebSocketGlobal(),
      sync: "all",
      pollIntervalMs: 0
    });
    await client.sync.start();
    const cached = await client.tasks.get(original.task_id);
    Reflect.set(cached, "asset_id", "asset-caller-mutation");
    const watch = vi.fn();
    client.watch({ filter: "tasks_for_asset", asset_id: "asset-old" }, watch);

    const progressed = core.upsertTask({ ...original, status: "in_progress", progress: 0.5 });
    core.emit(
      {
        event: "update",
        resource_type: "task",
        id: progressed.task_id,
        version: progressed.metadata.version,
        resource: progressed
      },
      { record: false }
    );

    await vi.waitFor(() => {
      expect(watch).toHaveBeenCalledWith(
        progressed,
        expect.objectContaining({ event: "update", id: progressed.task_id })
      );
    });
    expect(client.sync.snapshot().tasks[original.task_id].asset_id).toBe("asset-old");
  });

  it("requires canonical cache identity and normalizes watcher filters", async () => {
    const cache = new ResourceCache();
    const cached = entity("asset-cache-canonical");
    expect(() => cache.cacheResource("entity", " asset-cache-canonical ", cached)).toThrow("does not match cache id");
    expect(cache.cacheResource("entity", "asset-cache-canonical", cached)).toBe(true);
    expect(cache.value("entity", "asset-cache-canonical")).toEqual(cached);
    expect(cache.snapshot().entities).toEqual({ [cached.entity_id]: cached });

    const core = new FakeCore();
    const client = createAtlasClient(core, { sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const applyFeedEvent = (
      client as unknown as { engine: { applyEvent(event: FeedEvent): void } }
    ).engine.applyEvent.bind((client as unknown as { engine: object }).engine);
    const entityWatch = vi.fn();
    const taskWatch = vi.fn();
    client.watch({ filter: "id", resource_type: "entity", id: " asset-watch-canonical " }, entityWatch);
    client.watch({ filter: "tasks_for_asset", asset_id: " asset-watch-canonical " }, taskWatch);

    const watchedEntity = core.upsertEntity(entity("asset-watch-canonical"));
    applyFeedEvent(core.events.at(-1)!);
    const watchedTask = core.upsertTask(task("task-watch-canonical", "asset-watch-canonical"));
    applyFeedEvent(core.events.at(-1)!);

    expect(entityWatch).toHaveBeenCalledWith(
      watchedEntity,
      expect.objectContaining({ resource_type: "entity", id: "asset-watch-canonical" })
    );
    expect(taskWatch).toHaveBeenCalledWith(
      watchedTask,
      expect.objectContaining({ resource_type: "task", id: "task-watch-canonical" })
    );
  });
});
