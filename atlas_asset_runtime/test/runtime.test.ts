import type {
  CommandManifest,
  EntityCheckInOptions,
  RuntimeContextOptions,
  RuntimeTaskDeliveryResponse,
  TaskResource
} from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  AssetTaskFailure,
  type AtlasAssetClient,
  AtlasAssetRuntime,
  type ExecutionModule,
  SafetyBarrierError
} from "../src/index.js";

describe("AtlasAssetRuntime", () => {
  it("requires handlers to match the advertised manifest", () => {
    const { client } = fakeClient();
    expect(() => new AtlasAssetRuntime(client, { entityId: "", manifest: [] })).toThrow("entityId");
    expect(
      () => new AtlasAssetRuntime(client, { entityId: "asset-1", manifest: [manifestEntry("queued.move")] })
    ).toThrow("requires a handler");
    expect(
      () => new AtlasAssetRuntime(client, { entityId: "asset-1", manifest: [], handlers: { hidden: async () => {} } })
    ).toThrow("not advertised");
    const duplicate = manifestEntry("queued.move");
    expect(
      () =>
        new AtlasAssetRuntime(client, {
          entityId: "asset-1",
          manifest: [duplicate, { ...duplicate, description: "Duplicate" }],
          handlers: { "queued.move": async () => {} }
        })
    ).toThrow("unique");
  });

  it("establishes every safe state before publishing readiness", async () => {
    const order: string[] = [];
    const { client } = fakeClient([], order);
    const modules: ExecutionModule[] = [
      { id: "mobility", establishSafeState: async () => void order.push("safe:mobility") },
      { id: "sensor", establishSafeState: async () => void order.push("safe:sensor") }
    ];
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1", executionModules: modules });

    await runtime.start();

    expect(order.indexOf("begin")).toBeLessThan(order.indexOf("safe:mobility"));
    expect(order.indexOf("safe:mobility")).toBeLessThan(order.indexOf("ready"));
    expect(order.indexOf("safe:sensor")).toBeLessThan(order.indexOf("ready"));
    expect(client.runtime.ready).toHaveBeenCalledWith(
      "asset-1",
      { runtime_id: expect.stringMatching(/^runtime-/), manifest: [] },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    await runtime.stop();
  });

  it("does not become ready when the safety barrier fails", async () => {
    const { client } = fakeClient();
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      executionModules: [{ id: "mobility", establishSafeState: async () => Promise.reject(new Error("not stopped")) }]
    });

    await expect(runtime.start()).rejects.toEqual(expect.any(SafetyBarrierError));
    expect(client.runtime.ready).not.toHaveBeenCalled();
    expect(client.runtime.tasks).not.toHaveBeenCalled();
    expect(runtime.status).toBe("stopped");
  });

  it("stays ready and retries when delivery fails after startup", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    const onError = vi.fn();
    client.runtime.tasks.mockRejectedValueOnce(new Error("delivery unavailable"));
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1", onError });

    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.status).toBe("running");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "delivery unavailable" }));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.runtime.tasks).toHaveBeenCalledTimes(2);
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when its lifecycle signal is aborted after startup", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    const lifecycle = new AbortController();
    const handlerAborted = deferred<void>();
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: {
        "immediate.observe": ({ signal }) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                handlerAborted.resolve();
                resolve();
              },
              { once: true }
            );
          })
      }
    });

    await runtime.start({ signal: lifecycle.signal });
    await vi.waitFor(() => expect(client.tasks.start).toHaveBeenCalledOnce());
    lifecycle.abort(new Error("process stopping"));

    await handlerAborted.promise;
    await vi.waitFor(() => expect(runtime.status).toBe("stopped"));
    expect(client.tasks.complete).not.toHaveBeenCalled();
    expect(client.tasks.fail).not.toHaveBeenCalled();
  });

  it("polls for immediate Tasks created after startup", async () => {
    vi.useFakeTimers();
    const pending = task("immediate-late", "immediate.observe");
    const { client, emit } = fakeClient();
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler }
    });

    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.tasks.start).not.toHaveBeenCalled();

      emit(pending);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(client.tasks.start).toHaveBeenCalledWith("immediate-late", expect.anything());
      expect(handler).toHaveBeenCalledOnce();
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for immediate handler cleanup before stop resolves", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    const cleanupStarted = deferred<void>();
    const cleanupFinished = deferred<void>();
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: {
        "immediate.observe": ({ signal }) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                cleanupStarted.resolve();
                void cleanupFinished.promise.then(() => resolve());
              },
              { once: true }
            );
          })
      }
    });

    await runtime.start();
    await vi.waitFor(() => expect(client.tasks.start).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });

    await cleanupStarted.promise;
    expect(stopped).toBe(false);
    expect(runtime.status).toBe("stopping");
    cleanupFinished.resolve();
    await stopping;
    expect(runtime.status).toBe("stopped");
  });

  it("aborts stalled check-in network work during stop", async () => {
    const { client } = fakeClient();
    const requestStarted = deferred<void>();
    client.entities.checkIn.mockImplementationOnce(
      async (_id: string, options?: EntityCheckInOptions): Promise<Record<string, never>> => {
        requestStarted.resolve();
        await rejectOnAbort(options?.signal);
        return {};
      }
    );
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    await runtime.start();
    const checkIn = runtime.checkIn();
    await requestStarted.promise;
    const stopping = runtime.stop();

    await expect(checkIn).rejects.toThrow();
    await stopping;
    expect(runtime.status).toBe("stopped");
  });

  it("retries queued delivery after acknowledgement fails", async () => {
    vi.useFakeTimers();
    const pending = task("queued-1", "queued.move");
    const { client } = fakeClient([pending]);
    const onError = vi.fn();
    const handler = vi.fn(async () => undefined);
    client.tasks.acknowledge.mockRejectedValueOnce(new Error("acknowledgement unavailable"));
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("queued.move")],
      handlers: { "queued.move": handler },
      onError
    });

    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "acknowledgement unavailable" }));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.tasks.acknowledge).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledOnce();

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs queued work serially while immediate work overlaps", async () => {
    const queuedOne = task("queued-1", "queued.move");
    const queuedTwo = task("queued-2", "queued.move");
    const immediateOne = task("immediate-1", "immediate.observe");
    const immediateTwo = task("immediate-2", "immediate.observe");
    const { client } = fakeClient([queuedOne, queuedTwo, immediateOne, immediateTwo]);
    const queuedGate = deferred<void>();
    const immediateGate = deferred<void>();
    const order: string[] = [];
    let queuedActive = 0;
    let maxQueuedActive = 0;
    let immediateActive = 0;
    const manifest: CommandManifest = [
      manifestEntry("queued.move", "queued", true),
      manifestEntry("immediate.observe", "immediate")
    ];
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest,
      handlers: {
        "queued.move": async ({ task, reportProgress }) => {
          queuedActive++;
          maxQueuedActive = Math.max(maxQueuedActive, queuedActive);
          order.push(`run:${task.task_id}`);
          if (task.task_id === "queued-1") {
            await reportProgress(0.5);
            await queuedGate.promise;
          }
          queuedActive--;
          return { ok: true };
        },
        "immediate.observe": async ({ task }) => {
          immediateActive++;
          order.push(`run:${task.task_id}`);
          await immediateGate.promise;
          immediateActive--;
        }
      }
    });

    await runtime.start();
    await vi.waitFor(() => {
      expect(order).toContain("run:queued-1");
      expect(immediateActive).toBe(2);
    });
    expect(order).not.toContain("run:queued-2");
    expect(client.tasks.progress).toHaveBeenCalledWith(
      "queued-1",
      { progress: 0.5 },
      expect.objectContaining({ runtimeId: expect.stringMatching(/^runtime-/) })
    );

    immediateGate.resolve();
    queuedGate.resolve();
    await vi.waitFor(() => expect(order).toContain("run:queued-2"));
    await vi.waitFor(() => expect(client.tasks.complete).toHaveBeenCalledTimes(4));
    expect(maxQueuedActive).toBe(1);
    expect(startOrder(client, "immediate")).toEqual(["immediate-1", "immediate-2"]);
    await runtime.stop();
  });

  it("aborts local execution when Core delivers cancellation", async () => {
    vi.useFakeTimers();
    const runningTask = task("immediate-1", "immediate.observe");
    const { client, emit } = fakeClient([runningTask]);
    const aborted = deferred<void>();
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate", false, true)],
      handlers: {
        "immediate.observe": ({ signal }) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                resolve();
              },
              { once: true }
            );
          })
      }
    });

    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.tasks.start).toHaveBeenCalledWith("immediate-1", expect.anything());
      emit({
        ...runningTask,
        status: "cancelled",
        cancellation: { code: "requested", message: "Operator cancelled" },
        finished_at: "2026-08-19T12:00:01Z",
        updated_at: "2026-08-19T12:00:01Z"
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await aborted.promise;
      expect(client.tasks.complete).not.toHaveBeenCalled();
      expect(client.tasks.fail).not.toHaveBeenCalled();
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts local execution when Core fences the runtime", async () => {
    vi.useFakeTimers();
    const runningTask = task("immediate-1", "immediate.observe");
    const { client, emit } = fakeClient([runningTask]);
    const aborted = deferred<void>();
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: {
        "immediate.observe": ({ signal }) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                resolve();
              },
              { once: true }
            );
          })
      }
    });

    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.tasks.start).toHaveBeenCalledWith("immediate-1", expect.anything());
      emit({
        ...runningTask,
        status: "failed",
        failure: { code: "asset_restarted", message: "A new runtime replaced this one" },
        finished_at: "2026-08-19T12:00:01Z",
        updated_at: "2026-08-19T12:00:01Z"
      });
      await vi.advanceTimersByTimeAsync(5_000);

      await aborted.promise;
      expect(client.tasks.complete).not.toHaveBeenCalled();
      expect(client.tasks.fail).not.toHaveBeenCalled();
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not execute a Task that Core fails during start", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client, emit } = fakeClient([pending]);
    const handler = vi.fn(async () => undefined);
    const failed: TaskResource = {
      ...pending,
      status: "failed",
      failure: { code: "immediate_start_timeout", message: "The start window expired" },
      finished_at: "2026-08-19T12:01:00Z",
      updated_at: "2026-08-19T12:01:00Z"
    };
    client.tasks.start.mockImplementationOnce(async () => {
      emit(failed);
      return failed;
    });
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler }
    });

    await runtime.start();
    await vi.waitFor(() => expect(client.tasks.start).toHaveBeenCalledOnce());
    expect(handler).not.toHaveBeenCalled();
    expect(client.tasks.complete).not.toHaveBeenCalled();
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("reports typed precondition failures", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: {
        "immediate.observe": async () => {
          throw new AssetTaskFailure("precondition_failed", "Camera is unavailable");
        }
      }
    });

    await runtime.start();
    await vi.waitFor(() =>
      expect(client.tasks.fail).toHaveBeenCalledWith(
        "immediate-1",
        expect.objectContaining({
          failure: { code: "precondition_failed", message: "Camera is unavailable" }
        })
      )
    );
    await runtime.stop();
  });

  it("reconciles the next immediate Task when an earlier start fails", async () => {
    const first = task("immediate-1", "immediate.observe");
    const second = task("immediate-2", "immediate.observe");
    const { client } = fakeClient([first, second]);
    client.tasks.start.mockRejectedValueOnce(new Error("start rejected"));
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async () => undefined }
    });

    await runtime.start();

    await vi.waitFor(() => expect(startOrder(client, "immediate")).toEqual(["immediate-1", "immediate-2"]));
    expect(client.tasks.fail).toHaveBeenCalledWith(
      "immediate-1",
      expect.objectContaining({ failure: expect.objectContaining({ code: "execution_failed" }) })
    );
    await runtime.stop();
  });

  it("creates a fresh runtime fence on each process start", async () => {
    const { client } = fakeClient();
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    await runtime.start();
    await runtime.stop();
    await runtime.start();
    const runtimeIds = client.runtime.begin.mock.calls.map((call) => call[1].runtime_id);

    expect(runtimeIds).toHaveLength(2);
    expect(new Set(runtimeIds).size).toBe(2);
    await runtime.stop();
  });
});

function fakeClient(initialTasks: TaskResource[] = [], order: string[] = []) {
  const tasks = new Map(initialTasks.map((task) => [task.task_id, task]));
  const response = (): RuntimeTaskDeliveryResponse => {
    let queuedReleased = false;
    let immediateReleased = false;
    const deliverable = [...tasks.values()].filter((task) => {
      if (task.status !== "pending") return false;
      if (task.command.startsWith("immediate")) {
        if (immediateReleased) return false;
        immediateReleased = true;
        return true;
      }
      if (queuedReleased) return false;
      queuedReleased = true;
      return true;
    });
    return { tasks: deliverable };
  };
  const transition = (id: string, status: TaskResource["status"]): TaskResource => {
    const current = tasks.get(id) ?? task(id, id.startsWith("queued") ? "queued.move" : "immediate.observe");
    const updated = { ...current, status };
    tasks.set(id, updated);
    return updated;
  };
  const client = {
    handshake: vi.fn(async (_options?: { signal?: AbortSignal }) => void order.push("handshake")),
    entities: { checkIn: vi.fn(async (_id: string, _options?: EntityCheckInOptions) => ({})) },
    runtime: {
      begin: vi.fn(async (_assetId: string, _request: { runtime_id: string }) => void order.push("begin")),
      ready: vi.fn(
        async (_assetId: string, _request: { runtime_id: string; manifest: CommandManifest }) =>
          void order.push("ready")
      ),
      tasks: vi.fn(async (_assetId: string, _options: RuntimeContextOptions) => response())
    },
    tasks: {
      get: vi.fn(async (id: string) => {
        const current = tasks.get(id);
        if (!current) throw new Error(`Task ${id} not found`);
        return current;
      }),
      acknowledge: vi.fn(async (id: string) => transition(id, "acknowledged")),
      start: vi.fn(async (id: string) => transition(id, "in_progress")),
      progress: vi.fn(async (id: string) => transition(id, "in_progress")),
      complete: vi.fn(async (id: string) => transition(id, "completed")),
      fail: vi.fn(async (id: string) => transition(id, "failed"))
    }
  };
  return {
    client: client as unknown as AtlasAssetClient & typeof client,
    emit: (value: TaskResource) => {
      tasks.set(value.task_id, value);
    }
  };
}

function manifestEntry(
  command: string,
  scheduling: "queued" | "immediate" = "queued",
  supportsProgress = false,
  supportsCancel = false
) {
  return {
    command,
    description: `Runs ${command}`,
    scheduling,
    supports_cancel: supportsCancel,
    supports_progress: supportsProgress
  } as const;
}

function task(taskId: string, command: string, status: TaskResource["status"] = "pending"): TaskResource {
  return {
    task_id: taskId,
    asset_id: "asset-1",
    command,
    input: { value: taskId },
    status,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z"
  };
}

function startOrder(client: ReturnType<typeof fakeClient>["client"], prefix: string): string[] {
  return client.tasks.start.mock.calls.map((call) => call[0]).filter((id) => id.startsWith(prefix));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rejectOnAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    const fail = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}
