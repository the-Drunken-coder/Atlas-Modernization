import {
  ATLAS_PROTOCOL_REVISION,
  type CommandDefinition,
  type EntityResource,
  type FeedEvent,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entityFixture, metadataFixture, styleFixture, taskFixture } from "../../test/fixtures.js";
import { createSdkDataSource } from "./data-source.js";
import type { UiGeometry } from "./geometry.js";
import type { AtlasSnapshot } from "./store.js";

type RuntimeManifestChangeReason = "runtime_manifest_changed";
type TestEntityFeedEvent = FeedEvent & { change_reason?: RuntimeManifestChangeReason };

const config = {
  atlasBaseUrl: "https://core.test",
  protocolRevision: "rev",
  defaultMapSourceId: "openstreetmap-default",
  placeSearch: { provider: "maptiler" as const, unavailableReason: "missing key" },
  mapSources: [
    { id: "openstreetmap-default", label: "OpenStreetMap Default", style: styleFixture("openstreetmap-default") }
  ]
};
const holdPositionCommand: CommandDefinition = {
  command: "fixture.queued",
  name: "Fixture queued",
  description: "Hold here.",
  input_schema: "atlas.fixture.FixtureInput"
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function entity(id: string, version = 1): EntityResource {
  return entityFixture({ entity_id: id, alias: id, metadata: metadataFixture(version) });
}

function task(id: string, assetId: string, version = 1): TaskResource {
  const timestamp = `2026-06-20T00:00:0${version}Z`;
  return taskFixture({
    task_id: id,
    asset_id: assetId,
    input: { value: id },
    created_at: timestamp,
    updated_at: timestamp
  });
}

describe("sdk data source", () => {
  it("hydrates every page once and exposes the final SDK cache snapshot", async () => {
    const firstEntity = entity("asset-1", 1);
    const secondEntity = entity("asset-2", 2);
    const firstTask = task("task-1", firstEntity.entity_id, 3);
    const secondTask = task("task-2", secondEntity.entity_id, 4);
    const hydrationVersion = 3;
    const requestedUrls: string[] = [];
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === "https://core.test/protocol/revision") {
          return Response.json({ protocol_revision: ATLAS_PROTOCOL_REVISION });
        }
        if (url === "https://core.test/queries/full") {
          return Response.json({
            version: hydrationVersion,
            entities: [firstEntity],
            tasks: [firstTask],
            objects: [],
            has_more_entities: true,
            has_more_tasks: true,
            has_more_objects: false,
            next_entity_cursor: "next-entities",
            next_task_cursor: "next-tasks"
          });
        }
        if (
          url.includes("/queries/full?") &&
          url.includes("entity_cursor=next-entities") &&
          url.includes("task_cursor=next-tasks")
        ) {
          return Response.json({
            version: hydrationVersion,
            entities: [secondEntity],
            tasks: [secondTask],
            objects: [],
            has_more_entities: false,
            has_more_tasks: false,
            has_more_objects: false
          });
        }
        if (url === `https://core.test/queries/changed-since?since_version=${hydrationVersion}`) {
          return Response.json({
            version: 4,
            events: [
              {
                event: "update",
                resource_type: "task",
                id: secondTask.task_id,
                version: 4,
                resource: secondTask
              }
            ],
            has_more: false
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    const dataSource = createSdkDataSource(config);
    expect(dataSource.health?.()).toEqual({ running: false, healthy: false, degraded: false });

    await dataSource.start();

    expect(requestedUrls.filter((url) => url.includes("/queries/full"))).toHaveLength(2);
    expect(requestedUrls).toContain(`https://core.test/queries/changed-since?since_version=${hydrationVersion}`);
    expect(dataSource.snapshot()).toEqual({
      entities: { [firstEntity.entity_id]: firstEntity, [secondEntity.entity_id]: secondEntity },
      tasks: { [firstTask.task_id]: firstTask, [secondTask.task_id]: secondTask }
    });
    expect(dataSource.health?.()).toEqual({ running: true, healthy: true, degraded: false });

    dataSource.dispose();

    expect(dataSource.health?.()).toEqual({ running: false, healthy: false, degraded: false });
  });

  it("reports and clears startup errors across retry and dispose", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const core = new TestCore();
    const secret = "startup-userinfo-secret";
    let failRevision = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (failRevision && new URL(String(input)).pathname === "/protocol/revision") {
          return Promise.resolve(
            Response.json(
              { error_code: "CORE_UNAVAILABLE", message: `Core unavailable: https://user:${secret}@core.test` },
              { status: 503 }
            )
          );
        }
        return core.fetch(String(input), init);
      })
    );

    const dataSource = createSdkDataSource(config);
    await expect(dataSource.start()).rejects.toThrow();
    const health = dataSource.health?.();
    expect(health).toMatchObject({ error: { source: "startup" } });
    expect(health?.error?.message).toContain("Core unavailable");
    expect(health?.error?.message).toContain("[redacted]");
    expect(health?.error?.message).not.toContain(secret);

    dataSource.dispose();
    expect(dataSource.health?.()).not.toHaveProperty("error");

    failRevision = false;
    await dataSource.start();
    expect(dataSource.health?.()).not.toHaveProperty("error");

    dataSource.dispose();
    expect(dataSource.health?.()).not.toHaveProperty("error");
  });

  it("does not restore a stale startup error after dispose", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const core = new TestCore();
    let rejectRevision!: (cause: unknown) => void;
    const pendingRevision = new Promise<Response>((_resolve, reject) => {
      rejectRevision = reject;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/protocol/revision") return pendingRevision;
      return core.fetch(String(input), init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const dataSource = createSdkDataSource(config);
    const start = dataSource.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    dataSource.dispose();
    rejectRevision(new Error("late startup failure"));

    await expect(start).rejects.toThrow("late startup failure");
    expect(dataSource.health?.()).not.toHaveProperty("error");
  });

  it("keeps snapshots current through the slow changed-since poll when WebSocket connections are blocked", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", BlockedWebSocket);
    const core = new TestCore();
    const original = core.upsertEntity(entity("asset-poll"));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init))
    );
    const dataSource = createSdkDataSource(config);
    const snapshots = vi.fn();
    dataSource.watch(snapshots);

    const start = dataSource.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;
    const updated = core.upsertEntity({ ...original, alias: "Recovered by poll" });
    core.requests = [];

    await vi.advanceTimersByTimeAsync(119_999);
    expect(core.requests.filter((request) => request.startsWith("/queries/changed-since"))).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(snapshots).toHaveBeenLastCalledWith({ entities: { [updated.entity_id]: updated }, tasks: {} })
    );
    expect(core.requests.filter((request) => request.startsWith("/queries/changed-since"))).toHaveLength(1);
    expect(dataSource.health?.()).toMatchObject({
      running: true,
      degraded: true,
      error: { source: "live-sync", message: "Atlas Core feed connection failed" }
    });

    dataSource.dispose();
    core.requests = [];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(core.requests).toHaveLength(0);
  });

  it("publishes a replacement snapshot when polling recovers an expired cursor", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", BlockedWebSocket);
    const core = new TestCore();
    const retained = core.upsertEntity(entity("asset-retained"));
    const deleted = core.upsertEntity(entity("asset-deleted"));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init))
    );
    const dataSource = createSdkDataSource(config);
    const snapshots = vi.fn();
    dataSource.watch(snapshots);

    const start = dataSource.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;
    snapshots.mockClear();

    const updated = core.upsertEntity({ ...retained, alias: "Recovered after cursor expiry" });
    core.deleteEntity(deleted.entity_id);
    core.minRetainedVersion = updated.metadata.version;

    await vi.advanceTimersByTimeAsync(120_000);
    await vi.waitFor(() =>
      expect(snapshots).toHaveBeenLastCalledWith({
        entities: { [updated.entity_id]: updated },
        tasks: {},
        runtimeManifestVersions: { [updated.entity_id]: updated.metadata.version }
      })
    );

    expect(core.requests).toContain(`/queries/changed-since?since_version=${deleted.metadata.version}`);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(dataSource.snapshot()).toEqual({
      entities: { [updated.entity_id]: updated },
      tasks: {},
      runtimeManifestVersions: { [updated.entity_id]: updated.metadata.version }
    });
    expect(dataSource.health?.()).toMatchObject({ running: true, degraded: true });
    dataSource.dispose();
  });

  it("recovers missed changes through changed-since after the feed reconnects", async () => {
    vi.useFakeTimers();
    const core = new TestCore();
    const original = core.upsertEntity(entity("asset-reconnect"));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init))
    );
    vi.stubGlobal("WebSocket", core.attachWebSocketGlobal());
    const dataSource = createSdkDataSource(config);
    const snapshots = vi.fn();
    dataSource.watch(snapshots);

    const start = dataSource.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;
    const firstSocket = [...core.sockets][0];
    expect(firstSocket).toBeDefined();

    firstSocket?.close();
    const updated = core.upsertEntity({ ...original, alias: "Recovered after reconnect" });
    core.requests = [];

    await vi.advanceTimersByTimeAsync(999);
    expect(core.feedConnections).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() =>
      expect(snapshots).toHaveBeenLastCalledWith({ entities: { [updated.entity_id]: updated }, tasks: {} })
    );
    expect(core.feedConnections).toBe(2);
    expect(core.requests.some((request) => request.startsWith("/queries/changed-since"))).toBe(true);
    expect(dataSource.health?.()).toEqual({ running: true, healthy: true, degraded: false });

    dataSource.dispose();
  });

  it("publishes the runtime-manifest signal with its Entity snapshot", async () => {
    const core = new TestCore();
    const original = core.upsertEntity(entity("asset-runtime-signal"));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init))
    );
    vi.stubGlobal("WebSocket", core.attachWebSocketGlobal());
    const dataSource = createSdkDataSource(config);
    const snapshots: Array<{ version: number; signal?: number }> = [];
    dataSource.watch((snapshot) => {
      const updated = snapshot.entities[original.entity_id];
      if (updated) {
        snapshots.push({
          version: updated.metadata.version,
          signal: snapshot.runtimeManifestVersions?.[updated.entity_id]
        });
      }
    });

    await dataSource.start();
    snapshots.length = 0;
    const updated = core.publishEntity({ ...original }, "runtime_manifest_changed");

    await vi.waitFor(() =>
      expect(snapshots).toContainEqual({ version: updated.metadata.version, signal: updated.metadata.version })
    );
    expect(dataSource.snapshot().runtimeManifestVersions).toEqual({ [updated.entity_id]: updated.metadata.version });

    dataSource.dispose();
  });

  it("removes deleted entities from the runtime-manifest signal map", async () => {
    const core = new TestCore();
    const deleted = core.upsertEntity(entity("asset-deleted-signal"));
    const retained = core.upsertEntity(entity("asset-retained-signal"));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init))
    );
    vi.stubGlobal("WebSocket", core.attachWebSocketGlobal());
    const dataSource = createSdkDataSource(config);
    dataSource.watch(() => undefined);

    await dataSource.start();
    const updatedDeleted = core.publishEntity({ ...deleted }, "runtime_manifest_changed");
    const updatedRetained = core.publishEntity({ ...retained }, "runtime_manifest_changed");
    await vi.waitFor(() =>
      expect(dataSource.snapshot().runtimeManifestVersions).toEqual({
        [updatedDeleted.entity_id]: updatedDeleted.metadata.version,
        [updatedRetained.entity_id]: updatedRetained.metadata.version
      })
    );

    core.publishDelete(updatedDeleted.entity_id);
    await vi.waitFor(() =>
      expect(dataSource.snapshot().runtimeManifestVersions).toEqual({
        [updatedRetained.entity_id]: updatedRetained.metadata.version
      })
    );

    core.publishDelete(updatedRetained.entity_id);
    await vi.waitFor(() => expect(dataSource.snapshot().runtimeManifestVersions).toBeUndefined());
    dataSource.dispose();
  });

  it("invalidates changed entities once when recovery installs a reason-less hydrated snapshot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", BlockedWebSocket);
    const core = new TestCore();
    const original = core.upsertEntity(entity("asset-hydrated-runtime"));
    let detailed = {
      ...original,
      command_manifest: []
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === `/entities/${original.entity_id}`) return Promise.resolve(Response.json(detailed));
        return core.fetch(String(input), init);
      })
    );
    const dataSource = createSdkDataSource(config);
    const snapshots: AtlasSnapshot[] = [];
    dataSource.watch((snapshot) => snapshots.push(snapshot));

    const start = dataSource.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;
    snapshots.length = 0;

    const hydrated = core.upsertEntity({ ...original, alias: "Recovered after hydration" });
    core.minRetainedVersion = hydrated.metadata.version;
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.waitFor(() =>
      expect(snapshots).toContainEqual({
        entities: { [hydrated.entity_id]: hydrated },
        tasks: {},
        runtimeManifestVersions: { [hydrated.entity_id]: hydrated.metadata.version }
      })
    );
    const snapshotsAfterHydration = snapshots.length;

    detailed = { ...hydrated, command_manifest: [] };
    await expect(dataSource.loadEntityDetails?.(hydrated.entity_id)).resolves.toEqual(detailed);
    await vi.waitFor(() => expect(snapshots).toHaveLength(snapshotsAfterHydration));
    expect(dataSource.snapshot().runtimeManifestVersions).toEqual({
      [hydrated.entity_id]: hydrated.metadata.version
    });

    dataSource.dispose();
  });

  it("loads the Protocol-validated catalog from Core's direct endpoint", async () => {
    const core = new TestCore();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => core.fetch(String(input), init))
    );
    const dataSource = createSdkDataSource(config);

    await expect(dataSource.loadCommandCatalog()).resolves.toEqual(core.catalog);
    expect(core.requests).toEqual(["/command-catalog"]);
  });

  it("rejects an invalid command catalog from Core", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ command: "broken" }]))
    );
    const dataSource = createSdkDataSource(config);

    await expect(dataSource.loadCommandCatalog()).rejects.toThrow("Atlas response failed validation");
  });

  it("loads the selected Asset detail fresh for its current runtime manifest", async () => {
    const detailed = {
      ...entity("asset-1", 3),
      command_manifest: [
        {
          command: "fixture.queued",
          description: "Runs the fixture.",
          scheduling: "queued" as const,
          supports_cancel: true,
          supports_progress: true
        }
      ]
    };
    const fetchMock = vi.fn(async () => Response.json(detailed));
    vi.stubGlobal("fetch", fetchMock);
    const dataSource = createSdkDataSource(config);

    await expect(dataSource.loadEntityDetails?.("asset-1")).resolves.toEqual(detailed);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://core.test/entities/asset-1",
      expect.objectContaining({ method: "GET", credentials: "include" })
    );
  });

  it("forwards an Entity detail abort signal through the SDK transport", async () => {
    const detailed = entity("asset-1", 3);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(detailed));
    vi.stubGlobal("fetch", fetchMock);
    const dataSource = createSdkDataSource(config);
    const controller = new AbortController();

    await expect(dataSource.loadEntityDetails?.("asset-1", controller.signal)).resolves.toEqual(detailed);
    const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(requestSignal).toHaveProperty("aborted", true);
  });

  it("routes command and geometry writes through SDK cache notifications", async () => {
    const calls: Array<{ input: unknown; init: RequestInit }> = [];
    const createdTask = task("task-created", "asset-1", 2);
    const updatedGeometry: UiGeometry = { type: "Point", coordinates: [-74.2, 40.1] };
    const updatedEntity = { ...entity("asset-1", 3), components: { geometry: updatedGeometry } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit) => {
        calls.push({ input, init });
        if (String(input) === "https://core.test/tasks") {
          return Response.json(createdTask, { status: 201, headers: { ETag: '"v2"' } });
        }
        if (String(input) === "https://core.test/entities/asset-1") return Response.json(updatedEntity);
        throw new Error(`Unexpected request: ${String(input)}`);
      })
    );
    const dataSource = createSdkDataSource(config);
    const snapshots = vi.fn();
    dataSource.watch(snapshots);

    await expect(
      dataSource.submitCommand({
        assetId: "asset-1",
        command: holdPositionCommand,
        input: { value: "5" },
        idempotencyKey: "tasking-1"
      })
    ).resolves.toEqual(createdTask);
    expect(snapshots).toHaveBeenLastCalledWith({ entities: {}, tasks: { [createdTask.task_id]: createdTask } });
    expect(calls[0].input).toBe("https://core.test/tasks");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "include" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      asset_id: "asset-1",
      command: "fixture.queued",
      input: { value: "5" }
    });
    expect(new Headers(calls[0].init.headers).get("Idempotency-Key")).toBe("tasking-1");

    await expect(dataSource.updateGeometry("asset-1", updatedGeometry, 2)).resolves.toEqual(updatedEntity);
    expect(snapshots).toHaveBeenLastCalledWith({
      entities: { [updatedEntity.entity_id]: updatedEntity },
      tasks: { [createdTask.task_id]: createdTask }
    });
    expect(calls[1].init.headers).toEqual(expect.any(Headers));
    expect(new Headers(calls[1].init.headers).get("If-Match")).toBe('"v2"');
  });

  it("aborts a pending command request through the SDK transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          })
      )
    );
    const dataSource = createSdkDataSource(config);
    const controller = new AbortController();
    const request = dataSource.submitCommand({
      assetId: "asset-1",
      command: holdPositionCommand,
      input: { value: "abort" },
      idempotencyKey: "tasking-abort",
      signal: controller.signal
    });

    controller.abort();

    await expect(request).rejects.toBeDefined();
  });

  it("dispatches auth-expired for Core session failures", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: false, error_code: "UNAUTHORIZED", message: "Login is required" }, { status: 401 })
      )
    );

    const dataSource = createSdkDataSource(config);
    await expect(
      dataSource.submitCommand({
        assetId: "asset-1",
        command: holdPositionCommand,
        input: { value: "auth" },
        idempotencyKey: "tasking-auth"
      })
    ).rejects.toMatchObject({
      status: 401,
      errorCode: "UNAUTHORIZED"
    });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "atlas-auth-expired" }));
  });

  it("does not dispatch auth-expired for non-session 401 shapes", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: false, error_code: "SOMETHING_ELSE", message: "Invalid API key" }, { status: 401 })
      )
    );

    const dataSource = createSdkDataSource(config);
    await expect(
      dataSource.submitCommand({
        assetId: "asset-1",
        command: holdPositionCommand,
        input: { value: "auth" },
        idempotencyKey: "tasking-auth"
      })
    ).rejects.toMatchObject({
      status: 401,
      errorCode: "SOMETHING_ELSE"
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("does not let an old request expire a newer session", async () => {
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const authWindow = new EventTarget();
    const dispatchEvent = vi.spyOn(authWindow, "dispatchEvent");
    vi.stubGlobal("window", authWindow);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pendingResponse)
    );

    const dataSource = createSdkDataSource(config);
    const request = dataSource.submitCommand({
      assetId: "asset-1",
      command: holdPositionCommand,
      input: { value: "old-session" },
      idempotencyKey: "tasking-old-session"
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    window.dispatchEvent(new Event("atlas-auth-session-changed"));
    resolveResponse(Response.json({ success: false, error_code: "UNAUTHORIZED" }, { status: 401 }));

    await expect(request).rejects.toMatchObject({ status: 401, errorCode: "UNAUTHORIZED" });
    expect(dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "atlas-auth-expired" }));
  });
});

class TestCore {
  version = 0;
  minRetainedVersion = 0;
  feedConnections = 0;
  readonly catalog = [holdPositionCommand];
  requests: string[] = [];
  readonly sockets = new Set<TestWebSocket>();
  private readonly entities = new Map<string, EntityResource>();
  private readonly events: TestEntityFeedEvent[] = [];

  fetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    this.requests.push(path + url.search);
    if (path === "/protocol/revision") return Response.json({ protocol_revision: ATLAS_PROTOCOL_REVISION });
    if (path === "/command-catalog") return Response.json(this.catalog);
    if (path === "/queries/full") {
      return Response.json({
        version: this.version,
        entities: [...this.entities.values()],
        tasks: [],
        objects: [],
        has_more_entities: false,
        has_more_tasks: false,
        has_more_objects: false
      });
    }
    if (path === "/queries/changed-since") {
      const since = Number(url.searchParams.get("since_version"));
      if (since < this.minRetainedVersion) {
        return Response.json(
          { error_code: "CURSOR_EXPIRED", message: "Changed-since cursor has expired; perform a full hydration" },
          { status: 410 }
        );
      }
      const changed = this.events.filter((event) => event.version > since);
      return Response.json({
        events: changed,
        has_more: false,
        version: this.version
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  attachWebSocketGlobal() {
    const core = this;
    return class BoundTestWebSocket extends TestWebSocket {
      constructor(url: string) {
        super(url, core);
      }
    };
  }

  upsertEntity(value: EntityResource, changeReason?: RuntimeManifestChangeReason): EntityResource {
    const version = ++this.version;
    const updated = { ...value, metadata: { ...value.metadata, version } };
    this.entities.set(updated.entity_id, updated);
    this.events.push({
      event: "update",
      resource_type: "entity",
      id: updated.entity_id,
      version,
      resource: updated,
      ...(changeReason ? { change_reason: changeReason } : {})
    });
    return updated;
  }

  publishEntity(value: EntityResource, changeReason?: RuntimeManifestChangeReason): EntityResource {
    const updated = this.upsertEntity(value, changeReason);
    const event = this.events[this.events.length - 1];
    if (event) this.emit(event);
    return updated;
  }

  deleteEntity(id: string): void {
    if (!this.entities.delete(id)) return;
    const version = ++this.version;
    this.events.push({ event: "delete", resource_type: "entity", id, version });
  }

  publishDelete(id: string): void {
    const previousVersion = this.version;
    this.deleteEntity(id);
    if (this.version === previousVersion) return;
    const event = this.events[this.events.length - 1];
    if (event) this.emit(event);
  }

  private emit(event: FeedEvent): void {
    for (const socket of this.sockets) socket.receive(event);
  }
}

class TestWebSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(
    readonly url: string,
    private readonly core: TestCore
  ) {
    core.feedConnections++;
    core.sockets.add(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatch("open", {});
      this.dispatch("message", { data: JSON.stringify({ type: "hello", protocol_revision: ATLAS_PROTOCOL_REVISION }) });
    });
  }

  send(data: string): void {
    const message = JSON.parse(data) as { action?: string };
    if (message.action === "subscription_barrier") {
      this.receive({ type: "subscriptions_ready", version: this.core.version });
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.core.sockets.delete(this);
    this.dispatch("close", {});
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(value: unknown): void {
    if (this.readyState === 1) this.dispatch("message", { data: JSON.stringify(value) });
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class BlockedWebSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  constructor(readonly url: string) {
    queueMicrotask(() => this.dispatch("error", {}));
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", {});
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
