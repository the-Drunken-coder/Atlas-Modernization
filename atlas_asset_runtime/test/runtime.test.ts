import type {
  EntityCheckInMinimalTask,
  EntityCheckInOptions,
  EntityCheckInResponse,
  TaskResource
} from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AssetCheckInReport, type AtlasAssetClient, AtlasAssetRuntime } from "../src/index.js";

type CheckIn = (
  id: string,
  options: EntityCheckInOptions<"minimal">
) => Promise<EntityCheckInResponse<EntityCheckInMinimalTask>>;

afterEach(() => {
  vi.useRealTimers();
});

describe("AtlasAssetRuntime", () => {
  it("validates configuration while allowing telemetry-only runtimes", () => {
    const client = fakeClient();
    expect(() => new AtlasAssetRuntime(client, { entityId: "", handlers: {} })).toThrow("entityId");
    expect(() => new AtlasAssetRuntime(client, { entityId: "asset-1", handlers: { "": async () => {} } })).toThrow(
      "handlers"
    );
    expect(() => new AtlasAssetRuntime(client, { entityId: "asset-1", checkInIntervalMs: 0 })).toThrow(
      "checkInIntervalMs"
    );
    expect(() => new AtlasAssetRuntime(client, { entityId: "asset-1", checkInIntervalMs: 2_147_483_648 })).toThrow(
      "no greater than 2147483647"
    );
    expect(
      () => new AtlasAssetRuntime(client, { entityId: "asset-1", checkInIntervalMs: 2_147_483_647 })
    ).not.toThrow();
    expect(() => new AtlasAssetRuntime(client, { entityId: "asset-1" })).not.toThrow();
  });

  it("lazily handshakes and preserves the caller's check-in report", async () => {
    const client = fakeClient();
    const report: AssetCheckInReport = {
      status: "ready",
      components: { custom_mode: "survey" },
      telemetry: { latitude: 38 }
    };
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    await runtime.checkIn(report);
    await runtime.checkIn(report);

    expect(client.handshake).toHaveBeenCalledTimes(1);
    expect(client.entities.checkIn).toHaveBeenCalledTimes(2);
    expect(client.entities.checkIn).toHaveBeenCalledWith("asset-1", {
      ...report,
      fields: "minimal",
      statusFilter: ["pending"],
      limit: 20
    });
  });

  it("does not mutate command tasks in telemetry-only mode", async () => {
    const client = fakeClient(vi.fn<CheckIn>().mockResolvedValue(page([command("task-1", "move")], true, "next")));
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    await runtime.checkIn();

    expect(client.entities.checkIn).toHaveBeenCalledTimes(1);
    expect(client.tasks.acknowledge).not.toHaveBeenCalled();
    expect(client.tasks.complete).not.toHaveBeenCalled();
    expect(client.tasks.fail).not.toHaveBeenCalled();
    expect(client.tasks.setStatus).not.toHaveBeenCalled();
  });

  it("acknowledges, reports progress, and completes commands sequentially", async () => {
    const tasks = [command("task-1", "move"), command("task-2", "move")];
    const client = fakeClient(vi.fn<CheckIn>().mockResolvedValue(page(tasks)));
    const order: string[] = [];
    client.tasks.acknowledge.mockImplementation(async (id) => {
      order.push(`ack:${id}`);
      return taskResource(id);
    });
    client.tasks.setStatus.mockImplementation(async (id) => {
      order.push(`progress:${id}`);
      return taskResource(id);
    });
    client.tasks.complete.mockImplementation(async (id) => {
      order.push(`complete:${id}`);
      return taskResource(id);
    });
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      handlers: {
        move: async ({ task, reportProgress }) => {
          order.push(`run:${task.task_id}`);
          await reportProgress(50, "moving");
          return { ok: true };
        }
      }
    });

    await runtime.checkIn();

    expect(order).toEqual([
      "ack:task-1",
      "run:task-1",
      "progress:task-1",
      "complete:task-1",
      "ack:task-2",
      "run:task-2",
      "progress:task-2",
      "complete:task-2"
    ]);
    expect(client.tasks.complete).toHaveBeenCalledWith("task-1", { result: { ok: true } });
    expect(client.tasks.setStatus).toHaveBeenCalledWith("task-1", "acknowledged", { progress: 50, message: "moving" });
  });

  it("fails handler errors and unsupported commands but skips non-command tasks", async () => {
    const client = fakeClient(
      vi
        .fn<CheckIn>()
        .mockResolvedValue(
          page([
            command("throws", "move"),
            command("unknown", "dance"),
            command("prototype", "toString"),
            { task_id: "plain", status: "pending" }
          ])
        )
    );
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      handlers: { move: async () => Promise.reject(new Error("motor jammed")) }
    });

    await runtime.checkIn();

    expect(client.tasks.acknowledge).toHaveBeenCalledTimes(1);
    expect(client.tasks.fail).toHaveBeenNthCalledWith(1, "throws", { error: { message: "motor jammed" } });
    expect(client.tasks.fail).toHaveBeenNthCalledWith(2, "unknown", {
      error: { code: "unsupported_command", command_id: "dance" }
    });
    expect(client.tasks.fail).toHaveBeenNthCalledWith(3, "prototype", {
      error: { code: "unsupported_command", command_id: "toString" }
    });
    expect(client.tasks.fail).not.toHaveBeenCalledWith("plain", expect.anything());
  });

  it("drains advancing cursors and ignores duplicate task IDs", async () => {
    const checkIn = vi
      .fn<CheckIn>()
      .mockResolvedValueOnce(page([command("task-1", "move")], true, "next"))
      .mockResolvedValueOnce(page([command("task-1", "move"), command("task-2", "move")]));
    const client = fakeClient(checkIn);
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1", handlers: { move: handler } });

    await runtime.checkIn();

    expect(checkIn).toHaveBeenNthCalledWith(2, "asset-1", expect.objectContaining({ taskCursor: "next" }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(client.tasks.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("rejects pagination that cannot advance", async () => {
    const client = fakeClient(vi.fn<CheckIn>().mockResolvedValue(page([], true)));
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1", handlers: { move: async () => undefined } });
    await expect(runtime.checkIn()).rejects.toThrow("pagination did not advance");
  });

  it("serializes concurrent manual cycles", async () => {
    const first = deferred<EntityCheckInResponse<EntityCheckInMinimalTask>>();
    const checkIn = vi
      .fn<CheckIn>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(page([]));
    const client = fakeClient(checkIn);
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    const one = runtime.checkIn();
    const two = runtime.checkIn();
    await vi.waitFor(() => expect(checkIn).toHaveBeenCalledTimes(1));
    first.resolve(page([]));
    await Promise.all([one, two]);

    expect(checkIn).toHaveBeenCalledTimes(2);
  });

  it("waits for an active manual cycle and rejects new work while stopping", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const client = fakeClient(vi.fn<CheckIn>().mockResolvedValue(page([command("task-1", "wait")])));
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      handlers: {
        wait: async () => {
          entered.resolve();
          await release.promise;
        }
      }
    });

    const checking = runtime.checkIn();
    await entered.promise;
    const stopping = runtime.stop();
    await expect(runtime.checkIn()).rejects.toThrow("stopping");
    expect(runtime.status).toBe("stopping");
    expect(client.tasks.complete).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([checking, stopping]);

    expect(client.tasks.complete).toHaveBeenCalledWith("task-1", undefined);
    expect(runtime.status).toBe("stopped");
  });

  it("starts once, retries background failures, and stops idempotently", async () => {
    vi.useFakeTimers();
    const checkIn = vi
      .fn<CheckIn>()
      .mockResolvedValueOnce(page([]))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(page([]));
    const client = fakeClient(checkIn);
    const onError = vi.fn();
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1", checkInIntervalMs: 1_000, onError });

    await Promise.all([runtime.start(), runtime.start()]);
    expect(runtime.status).toBe("running");
    expect(client.handshake).toHaveBeenCalledTimes(1);
    expect(checkIn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));
    await vi.advanceTimersByTimeAsync(250);
    expect(checkIn).toHaveBeenCalledTimes(3);
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(runtime.status).toBe("stopped");
  });

  it("cancels an active handler without failing its acknowledged task", async () => {
    const entered = deferred<void>();
    const client = fakeClient(vi.fn<CheckIn>().mockResolvedValue(page([command("task-1", "wait")])));
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      handlers: {
        wait: async ({ signal }) => {
          entered.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("cancelled locally");
        }
      }
    });

    const starting = runtime.start();
    await entered.promise;
    await runtime.stop();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(client.tasks.acknowledge).toHaveBeenCalledWith("task-1");
    expect(client.tasks.fail).not.toHaveBeenCalled();
    expect(client.tasks.complete).not.toHaveBeenCalled();
    expect(runtime.status).toBe("stopped");
  });

  it("stops when its external signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const runtime = new AtlasAssetRuntime(fakeClient(), { entityId: "asset-1" });
    await runtime.start({ signal: controller.signal });
    controller.abort();
    await vi.waitFor(() => expect(runtime.status).toBe("stopped"));
  });

  it("handshakes again after a stopped runtime restarts", async () => {
    const client = fakeClient();
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    await runtime.start();
    await runtime.stop();
    await runtime.start();
    await runtime.stop();

    expect(client.handshake).toHaveBeenCalledTimes(2);
  });
});

function fakeClient(checkIn: ReturnType<typeof vi.fn<CheckIn>> = vi.fn<CheckIn>().mockResolvedValue(page([]))) {
  return {
    handshake: vi.fn(async () => undefined),
    entities: { checkIn },
    tasks: {
      acknowledge: vi.fn(async (id: string) => taskResource(id)),
      complete: vi.fn(async (id: string) => taskResource(id)),
      fail: vi.fn(async (id: string) => taskResource(id)),
      setStatus: vi.fn(async (id: string) => taskResource(id))
    }
  } satisfies AtlasAssetClient;
}

function command(taskId: string, commandId: string): EntityCheckInMinimalTask {
  return { task_id: taskId, status: "pending", entity_id: "asset-1", command_id: commandId, parameters: { speed: 4 } };
}

function page(
  tasks: EntityCheckInMinimalTask[],
  hasMore = false,
  cursor?: string
): EntityCheckInResponse<EntityCheckInMinimalTask> {
  return {
    entity: {} as EntityCheckInResponse["entity"],
    tasks,
    task_count: tasks.length,
    task_limit: 20,
    has_more_tasks: hasMore,
    ...(cursor ? { next_task_cursor: cursor } : {})
  };
}

function taskResource(id: string): TaskResource {
  return {
    task_id: id,
    entity_id: "asset-1",
    status: "acknowledged",
    components: {},
    metadata: { version: 1 }
  } as TaskResource;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
