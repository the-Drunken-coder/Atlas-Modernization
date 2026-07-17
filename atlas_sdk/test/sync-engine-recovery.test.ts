import { describe, expect, it, vi } from "vitest";
import { AtlasClient } from "../src";
import { type ChangedSinceResponse, changedSinceToEvents } from "../src/types.js";
import { entity, FakeCore, metadata, object, task } from "./support/fake-core.js";

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

  it("serves recovered object details from the changed-since cache", async () => {
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
    expect(core.requests).toEqual([]);
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
    expect(watch).toHaveBeenCalledWith(
      updated,
      expect.objectContaining({ event: "recovered", resource_type: "task", id: "task-polled" })
    );
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
      has_more_entities: false,
      has_more_tasks: false,
      has_more_objects: false,
      has_more_deleted_entities: false,
      has_more_deleted_tasks: false,
      has_more_deleted_objects: false,
      version: 5
    };

    expect(changedSinceToEvents(response).map((event) => event.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it("drains paginated changed-since responses before advancing the high-water mark", async () => {
    const core = new FakeCore();
    core.changedSinceLimitPerType = 1;
    let releaseSecondPage!: () => void;
    let secondPageStarted = false;
    const secondPage = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });
    const fetchImpl: typeof fetch = async (url, init) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/queries/changed-since" && requestUrl.searchParams.has("task_cursor")) {
        secondPageStarted = true;
        await secondPage;
      }
      return core.fetch(String(url), init);
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: "all", pollIntervalMs: 0 });
    await client.sync.start();
    const initialVersion = client.sync.status().lastVersion;
    const watch = vi.fn();
    client.watch({ filter: "type", resource_type: "task" }, watch);

    const first = core.upsertTask(task("task-page-1", "asset-1"));
    const second = core.upsertTask(task("task-page-2", "asset-1"));
    const recovery = client.changedSince();
    await vi.waitFor(() => expect(secondPageStarted).toBe(true));
    expect(client.sync.status().lastVersion).toBe(initialVersion);
    releaseSecondPage();
    await recovery;

    expect(
      core.requests.some((request) => request.startsWith("/queries/changed-since?") && request.includes("task_cursor="))
    ).toBe(true);
    expect(watch).toHaveBeenCalledWith(
      first,
      expect.objectContaining({ id: "task-page-1", version: first.metadata.version })
    );
    expect(watch).toHaveBeenCalledWith(
      second,
      expect.objectContaining({ id: "task-page-2", version: second.metadata.version })
    );
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
        has_more_objects: false,
        has_more_deleted_entities: false,
        has_more_deleted_tasks: false,
        has_more_deleted_objects: false,
        version: 0
      });
    };
    const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl, sync: false, pollIntervalMs: 0 });

    await expect(client.changedSince()).rejects.toThrow("Atlas changed-since pagination repeated entity_cursor");
    expect(changedSinceRequests).toBe(2);
  });
});
