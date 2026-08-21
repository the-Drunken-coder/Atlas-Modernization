import {
  AtlasAPIError,
  AtlasTransportError,
  type CommandManifest,
  type EntityCheckInOptions,
  type JSONValue,
  type RuntimeContextOptions,
  type RuntimeTaskDeliveryResponse,
  type TaskCompleteOptions,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssetTaskFailure,
  type AssetTaskHandler,
  type AtlasAssetClient,
  AtlasAssetRuntime,
  type ExecutionModule,
  SafetyBarrierError
} from "../src/index.js";

afterEach(() => vi.useRealTimers());

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

  it("copies caller-owned manifest and execution module arrays", async () => {
    const { client } = fakeClient();
    const manifest: CommandManifest = [manifestEntry("immediate.observe", "immediate")];
    const establishSafeState = vi.fn(async () => undefined);
    const modules: ExecutionModule[] = [{ id: "mobility", establishSafeState }];
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest,
      handlers: { "immediate.observe": async () => undefined },
      executionModules: modules
    });

    manifest[0]!.command = "changed.after-construction";
    modules.length = 0;
    await runtime.start();

    expect(establishSafeState).toHaveBeenCalledOnce();
    expect(client.runtime.ready).toHaveBeenCalledWith(
      "asset-1",
      expect.objectContaining({ manifest: [expect.objectContaining({ command: "immediate.observe" })] }),
      expect.anything()
    );
    await runtime.stop();
  });

  it("does not publish running after the lifecycle aborts during readiness", async () => {
    const controller = new AbortController();
    const { client } = fakeClient();
    client.runtime.ready.mockImplementation(async () => {
      controller.abort();
      return undefined;
    });
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    await expect(runtime.start({ signal: controller.signal })).rejects.toThrow();

    expect(runtime.status).toBe("stopped");
  });

  it("stays ready and retries when delivery fails after startup", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    const onError = vi.fn();
    client.runtime.tasks.mockRejectedValueOnce(new Error("delivery unavailable"));
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1", onError });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.status).toBe("running");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "delivery unavailable" }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.runtime.tasks).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("retries completion without rerunning the handler or releasing later queued work", async () => {
    vi.useFakeTimers();
    const first = task("queued-1", "queued.move");
    const second = task("queued-2", "queued.move");
    const { client } = fakeClient([first, second]);
    const onError = vi.fn();
    const handledTaskIDs: string[] = [];
    const handler = vi.fn<AssetTaskHandler>(async ({ task }) => {
      handledTaskIDs.push(task.task_id);
      return { ok: true };
    });
    client.tasks.complete.mockRejectedValueOnce(new AtlasTransportError("completion unavailable"));
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("queued.move")],
      handlers: { "queued.move": handler },
      onError
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledOnce();
    expect(client.tasks.complete).toHaveBeenCalledTimes(1);
    expect(client.tasks.fail).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "completion unavailable" }));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handledTaskIDs).toEqual(["queued-1", "queued-2"]);
    expect(client.tasks.complete).toHaveBeenCalledTimes(3);
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("retries failure reporting without rerunning the handler", async () => {
    vi.useFakeTimers();
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    const onError = vi.fn();
    const handler = vi.fn(async () => Promise.reject(new AssetTaskFailure("precondition_failed", "blocked")));
    client.tasks.fail.mockRejectedValueOnce(new AtlasTransportError("failure reporting unavailable"));
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler },
      onError
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledOnce();
    expect(client.tasks.fail).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "failure reporting unavailable" }));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(handler).toHaveBeenCalledOnce();
    expect(client.tasks.fail).toHaveBeenCalledTimes(2);
    expect(client.tasks.complete).not.toHaveBeenCalled();
    await runtime.stop();
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

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.tasks.start).not.toHaveBeenCalled();

    emit(pending);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(client.tasks.start).toHaveBeenCalledWith("immediate-late", expect.anything());
    expect(handler).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("keeps polling for delivery while accepted Task reconciliation is stalled", async () => {
    vi.useFakeTimers();
    const first = task("immediate-1", "immediate.observe");
    const second = task("immediate-2", "immediate.observe");
    const { client, emit } = fakeClient([first]);
    const reconciliationStarted = deferred<void>();
    client.tasks.get.mockImplementation(async (_id: string, options?: { signal?: AbortSignal }) => {
      reconciliationStarted.resolve();
      return rejectOnAbort(options?.signal);
    });
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async ({ signal }) => rejectOnAbort(signal) }
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.tasks.start).toHaveBeenCalledWith("immediate-1", expect.anything());

    emit(second);
    await vi.advanceTimersByTimeAsync(5_000);
    await reconciliationStarted.promise;

    expect(client.tasks.start).toHaveBeenCalledWith("immediate-2", expect.anything());
    await runtime.stop();
  });

  it("rejects a delivered Task assigned to another Asset", async () => {
    const foreign = { ...task("foreign-1", "immediate.observe"), asset_id: "asset-2" };
    const { client } = fakeClient();
    const onError = vi.fn();
    client.runtime.tasks.mockResolvedValue({ tasks: [foreign] });
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler },
      onError
    });

    await runtime.start();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("asset-2") }))
    );

    expect(handler).not.toHaveBeenCalled();
    expect(client.tasks.acknowledge).not.toHaveBeenCalled();
    expect(client.tasks.start).not.toHaveBeenCalled();
    expect(client.tasks.complete).not.toHaveBeenCalled();
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("holds the Core runtime fence until immediate handler cleanup settles", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    let replacementAuthorized = false;
    client.runtime.stop.mockImplementationOnce(async () => {
      replacementAuthorized = true;
    });
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
    expect(client.runtime.stop).not.toHaveBeenCalled();
    expect(replacementAuthorized).toBe(false);
    cleanupFinished.resolve();
    await stopping;
    expect(client.runtime.stop).toHaveBeenCalledOnce();
    expect(replacementAuthorized).toBe(true);
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

  it("aborts telemetry collection and waits for its cleanup during stop", async () => {
    const { client } = fakeClient();
    const reportStarted = deferred<AbortSignal>();
    const reportStopped = deferred<void>();
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      checkIn: ({ signal }) =>
        new Promise((resolve) => {
          reportStarted.resolve(signal);
          signal.addEventListener(
            "abort",
            () => {
              reportStopped.resolve();
              resolve({ status: "stopped" });
            },
            { once: true }
          );
        })
    });

    await runtime.start();
    const checkIn = runtime.checkIn();
    const signal = await reportStarted.promise;
    const stopping = runtime.stop();

    await reportStopped.promise;
    expect(signal.aborted).toBe(true);
    await expect(checkIn).rejects.toThrow();
    await stopping;
    expect(client.entities.checkIn).not.toHaveBeenCalled();
    expect(runtime.status).toBe("stopped");
  });

  it("retries queued delivery after acknowledgement fails", async () => {
    vi.useFakeTimers();
    const pending = task("queued-1", "queued.move");
    const { client } = fakeClient([pending]);
    const onError = vi.fn();
    const handler = vi.fn(async () => undefined);
    client.tasks.acknowledge.mockRejectedValueOnce(new AtlasTransportError("acknowledgement unavailable"));
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("queued.move")],
      handlers: { "queued.move": handler },
      onError
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "acknowledgement unavailable" }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.tasks.acknowledge).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();

    await runtime.stop();
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
    client.tasks.start.mockRejectedValueOnce(new AtlasAPIError("start rejected", 400, {}));
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

  it("compensates when readiness may have committed before its response was lost", async () => {
    const { client } = fakeClient();
    const responseLost = new Error("ready response lost");
    client.runtime.ready.mockRejectedValueOnce(responseLost);
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    await expect(runtime.start()).rejects.toBe(responseLost);

    const runtimeId = client.runtime.begin.mock.calls[0]?.[1].runtime_id;
    expect(runtimeId).toMatch(/^runtime-/);
    expect(client.runtime.stop).toHaveBeenCalledWith("asset-1", { runtime_id: runtimeId });
    expect(runtime.status).toBe("stopped");
  });

  it("orders Core deactivation after an in-flight readiness request settles", async () => {
    const order: string[] = [];
    const readinessStarted = deferred<void>();
    const finishReadiness = deferred<void>();
    const { client } = fakeClient();
    client.runtime.ready.mockImplementationOnce(async () => {
      order.push("ready:start");
      readinessStarted.resolve();
      await finishReadiness.promise;
      order.push("ready:end");
    });
    client.runtime.stop.mockImplementationOnce(async () => void order.push("stop"));
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    const startResult = runtime.start().then(
      () => undefined,
      (error: unknown) => error
    );
    await readinessStarted.promise;
    const stopping = runtime.stop();

    expect(client.runtime.stop).not.toHaveBeenCalled();
    finishReadiness.resolve();
    expect(await startResult).toBeInstanceOf(Error);
    await stopping;
    expect(order).toEqual(["ready:start", "ready:end", "stop"]);
    expect(runtime.status).toBe("stopped");
  });

  it("shares failed-start compensation with an overlapping stop", async () => {
    const startupError = new Error("ready response lost");
    const duplicateError = new Error("duplicate stop failed");
    const compensationStarted = deferred<void>();
    const finishCompensation = deferred<void>();
    const { client } = fakeClient();
    client.runtime.ready.mockRejectedValueOnce(startupError);
    client.runtime.stop
      .mockImplementationOnce(async () => {
        compensationStarted.resolve();
        await finishCompensation.promise;
      })
      .mockRejectedValueOnce(duplicateError);
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    const starting = runtime.start();
    await compensationStarted.promise;
    const stopping = runtime.stop();

    expect(client.runtime.stop).toHaveBeenCalledOnce();
    const startResult = expect(starting).rejects.toBe(startupError);
    finishCompensation.resolve();
    await startResult;
    await expect(stopping).resolves.toBeUndefined();
    expect(client.runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.status).toBe("stopped");
  });

  it("blocks a replacement generation until overlapping stop cleanup settles", async () => {
    const startupError = new Error("ready response lost");
    const readinessStarted = deferred<void>();
    const failReadiness = deferred<void>();
    const reportStarted = deferred<void>();
    const cleanupStarted = deferred<void>();
    const finishCleanup = deferred<void>();
    const compensationStarted = deferred<void>();
    const finishCompensation = deferred<void>();
    const { client } = fakeClient();
    client.runtime.ready.mockImplementationOnce(async () => {
      readinessStarted.resolve();
      await failReadiness.promise;
      throw startupError;
    });
    client.runtime.stop.mockImplementationOnce(async () => {
      compensationStarted.resolve();
      await finishCompensation.promise;
    });
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      checkIn: ({ signal }) =>
        new Promise((resolve) => {
          reportStarted.resolve();
          signal.addEventListener(
            "abort",
            () => {
              cleanupStarted.resolve();
              void finishCleanup.promise.then(() => resolve({}));
            },
            { once: true }
          );
        })
    });

    const starting = runtime.start();
    await readinessStarted.promise;
    const checkIn = runtime.checkIn().then(
      () => undefined,
      (error: unknown) => error
    );
    await reportStarted.promise;
    failReadiness.resolve();
    await compensationStarted.promise;
    const stopping = runtime.stop();
    await cleanupStarted.promise;
    finishCompensation.resolve();
    await expect(starting).rejects.toBe(startupError);

    const replacement = runtime.start();
    try {
      await expect(replacement).rejects.toThrow("Atlas asset runtime is stopping");
      expect(client.runtime.begin).toHaveBeenCalledOnce();
    } finally {
      finishCleanup.resolve();
      await Promise.allSettled([checkIn, stopping, replacement]);
    }

    expect(client.runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.status).toBe("stopped");
    await runtime.start();
    const runtimeIds = client.runtime.begin.mock.calls.map((call) => call[1].runtime_id);
    expect(runtimeIds).toHaveLength(2);
    expect(new Set(runtimeIds).size).toBe(2);
    await runtime.stop();
  });

  it("retries the exact runtime registration after an ambiguous transport failure", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient();
    client.runtime.begin.mockRejectedValueOnce(new AtlasTransportError("registration response lost"));
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    const starting = runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.runtime.begin).toHaveBeenCalledOnce();
    expect(client.runtime.ready).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await starting;
    expect(client.runtime.begin).toHaveBeenCalledTimes(2);
    expect(client.runtime.begin.mock.calls[0]?.[1]).toEqual(client.runtime.begin.mock.calls[1]?.[1]);
    expect(runtime.status).toBe("running");
    await runtime.stop();
  });

  it("returns both startup and compensation failures", async () => {
    const { client } = fakeClient();
    const startupError = new Error("ready response lost");
    const compensationError = new Error("stop unavailable");
    client.runtime.ready.mockRejectedValueOnce(startupError);
    client.runtime.stop.mockRejectedValueOnce(compensationError);
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });

    try {
      await runtime.start();
      throw new Error("start unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([startupError, compensationError]);
    }
    expect(runtime.status).toBe("stopping");
    const runtimeId = client.runtime.begin.mock.calls[0]?.[1].runtime_id;
    await runtime.stop();
    expect(client.runtime.stop.mock.calls.map((call) => call[1].runtime_id)).toEqual([runtimeId, runtimeId]);
    expect(runtime.status).toBe("stopped");
  });

  it("retains the runtime fence until Core confirms stop", async () => {
    const { client } = fakeClient();
    const stopError = new Error("stop response lost");
    const runtime = new AtlasAssetRuntime(client, { entityId: "asset-1" });
    await runtime.start();
    client.runtime.stop.mockRejectedValueOnce(stopError);
    const runtimeId = client.runtime.begin.mock.calls[0]?.[1].runtime_id;

    await expect(runtime.stop()).rejects.toBe(stopError);
    expect(runtime.status).toBe("stopping");
    await runtime.stop();
    expect(client.runtime.stop.mock.calls.map((call) => call[1].runtime_id)).toEqual([runtimeId, runtimeId]);
    expect(runtime.status).toBe("stopped");
  });

  it("wakes acknowledged queued work after a provisional head becomes terminal", async () => {
    vi.useFakeTimers();
    const first = task("queued-1", "queued.move");
    const second = task("queued-2", "queued.move");
    const { client, transition, emit } = fakeClient([first, second]);
    client.runtime.tasks
      .mockResolvedValueOnce({ tasks: [first] })
      .mockResolvedValueOnce({ tasks: [second] })
      .mockResolvedValue({ tasks: [] });
    client.tasks.acknowledge.mockImplementation(async (id: string, options?: { signal?: AbortSignal }) => {
      const acknowledged = transition(id, "acknowledged");
      if (id === first.task_id) return rejectOnAbort(options?.signal);
      return acknowledged;
    });
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("queued.move")],
      handlers: { "queued.move": handler }
    });

    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(handler).not.toHaveBeenCalled();
      emit({
        ...transition(first.task_id, "cancelled"),
        cancellation: { code: "requested", message: "stop" }
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledOnce();
      expect(client.tasks.start).toHaveBeenCalledWith(second.task_id, expect.anything());
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves Core queue order below JavaScript millisecond resolution", async () => {
    const earlier = { ...task("queued-z", "queued.move"), created_at: "2026-08-19T12:00:00.000001Z" };
    const later = { ...task("queued-a", "queued.move"), created_at: "2026-08-19T12:00:00.000002Z" };
    const { client } = fakeClient([earlier, later]);
    client.runtime.tasks.mockResolvedValueOnce({ tasks: [earlier, later] }).mockResolvedValue({ tasks: [] });
    const executionOrder: string[] = [];
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("queued.move")],
      handlers: { "queued.move": async ({ task }) => void executionOrder.push(task.task_id) }
    });

    await runtime.start();
    await vi.waitFor(() => expect(executionOrder).toHaveLength(2));
    expect(client.tasks.acknowledge.mock.calls.map((call) => call[0])).toEqual([earlier.task_id, later.task_id]);
    expect(executionOrder).toEqual([earlier.task_id, later.task_id]);
    await runtime.stop();
  });

  it("reconciles deterministic Start response failures without delaying physical execution", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client, transition } = fakeClient([pending]);
    client.tasks.start.mockImplementationOnce(async (id: string) => {
      transition(id, "in_progress");
      throw new TypeError("Atlas response did not include a valid resource ETag");
    });
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler }
    });

    await runtime.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(client.tasks.start).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("reconciles a committed Start response with the wrong Task ID", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client, transition } = fakeClient([pending]);
    client.tasks.start.mockImplementationOnce(async (id: string) => {
      transition(id, "in_progress");
      throw new TypeError("Atlas task response ID did not match the requested Task");
    });
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler }
    });

    await runtime.start();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(client.tasks.start).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("retries branded transport errors from AtlasClient-compatible implementations", async () => {
    vi.useFakeTimers();
    class CompatibleTransportError extends Error {
      readonly code = "ATLAS_TRANSPORT_ERROR";
    }
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    client.tasks.start.mockRejectedValueOnce(new CompatibleTransportError("start response lost"));
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler }
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.tasks.start).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.tasks.start).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("retries branded API errors from AtlasClient-compatible implementations", async () => {
    vi.useFakeTimers();
    class CompatibleAPIError extends Error {
      readonly code = "ATLAS_API_ERROR";
      readonly status = 503;
    }
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    client.tasks.start.mockRejectedValueOnce(new CompatibleAPIError("Core unavailable"));
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler }
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.tasks.start).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.tasks.start).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("retries transient authoritative reads after deterministic lifecycle failures", async () => {
    vi.useFakeTimers();
    const pending = task("immediate-1", "immediate.observe");
    const { client, transition } = fakeClient([pending]);
    client.tasks.start.mockImplementationOnce(async (id: string) => {
      transition(id, "in_progress");
      throw new TypeError("Atlas response failed validation");
    });
    client.tasks.get.mockRejectedValueOnce(new AtlasTransportError("authoritative read unavailable"));
    const handler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": handler }
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.tasks.start).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(client.tasks.fail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.tasks.start).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it.each([
    [
      "cyclic",
      () => {
        const output: Record<string, unknown> = {};
        output["cycle".repeat(150_000)] = output;
        return output;
      }
    ],
    ["non-finite number", () => ({ value: Number.POSITIVE_INFINITY })],
    ["negative zero", () => ({ value: -0 })],
    ["nested undefined", () => ({ value: undefined })],
    ["nested function", () => ({ value: () => "ignored" })],
    ["nested symbol", () => ({ value: Symbol("ignored") })],
    ["toJSON transformation", () => ({ reading: 1, toJSON: () => ({ reading: 2 }) })],
    ["nested toJSON transformation", () => ({ value: { reading: 1, toJSON: () => ({ reading: 2 }) } })],
    ["boxed primitive", () => Object(1)],
    ["non-record object", () => new Map([["value", 1]])],
    ["non-enumerable property", () => Object.defineProperty({ value: 1 }, "secret", { value: 2 })],
    [
      "symbol-keyed property",
      () => Object.defineProperty({ value: 1 }, Symbol("ignored"), { value: 2, enumerable: true })
    ],
    ["sparse array", () => Array(1)]
  ])("fails %s handler output without attempting completion", async (_label, output) => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async () => output() as never }
    });

    await runtime.start();
    await vi.waitFor(() => expect(client.tasks.fail).toHaveBeenCalledOnce());
    expect(client.tasks.complete).not.toHaveBeenCalled();
    expect(client.tasks.fail).toHaveBeenCalledWith(
      pending.task_id,
      expect.objectContaining({
        failure: {
          code: "execution_failed",
          message: "Task handler returned output that JSON cannot preserve"
        }
      })
    );
    await runtime.stop();
  });

  it.each([2 ** 53, 2 ** 54, 1e20])("completes exactly representable integer output %s", async (value) => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async () => ({ value }) }
    });

    await runtime.start();
    await vi.waitFor(() => expect(client.tasks.complete).toHaveBeenCalledOnce());
    expect(client.tasks.complete).toHaveBeenCalledWith(pending.task_id, expect.objectContaining({ output: { value } }));
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("copies dense array indices into a prototype-free snapshot", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    const originalToJSON = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const output = Object.defineProperty([], "0", {
      get() {
        Object.defineProperty(Array.prototype, "toJSON", {
          configurable: true,
          value: () => ["changed"]
        });
        return 1;
      }
    });
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async () => output }
    });

    try {
      await runtime.start();
      await vi.waitFor(() => expect(client.tasks.complete).toHaveBeenCalledOnce());
      const completed = client.tasks.complete.mock.calls[0]![1].output;
      expect(Array.isArray(completed)).toBe(true);
      expect(Object.getPrototypeOf(completed)).toBeNull();
      expect(JSON.stringify(completed)).toBe("[1]");
      expect(client.tasks.fail).not.toHaveBeenCalled();
    } finally {
      if (originalToJSON === undefined) Reflect.deleteProperty(Array.prototype, "toJSON");
      else Object.defineProperty(Array.prototype, "toJSON", originalToJSON);
      await runtime.stop();
    }
  });

  it("copies deeply nested JSON output without using the call stack", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    let output: JSONValue = 1;
    for (let depth = 0; depth < 2_500; depth++) output = [output];
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async () => output }
    });

    await runtime.start();
    await vi.waitFor(() => expect(client.tasks.complete).toHaveBeenCalledOnce());
    let completed = client.tasks.complete.mock.calls[0]![1].output;
    for (let depth = 0; depth < 2_500; depth++) {
      if (!Array.isArray(completed)) throw new Error("Task output lost its nested array shape");
      completed = completed[0];
    }
    expect(completed).toBe(1);
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("snapshots stateful handler output before reporting completion", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    let reads = 0;
    const output = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        reads++;
        if (reads > 1) throw new Error("output was read twice");
        return 1;
      }
    });
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async () => output as never }
    });

    await runtime.start();
    await vi.waitFor(() => expect(client.tasks.complete).toHaveBeenCalledOnce());
    expect(reads).toBe(1);
    expect(client.tasks.complete).toHaveBeenCalledWith(
      pending.task_id,
      expect.objectContaining({ output: { value: 1 } })
    );
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("enumerates proxy output once while creating its snapshot", async () => {
    const pending = task("immediate-1", "immediate.observe");
    const { client } = fakeClient([pending]);
    let enumerations = 0;
    const output = new Proxy(
      { value: 1 },
      {
        ownKeys(target) {
          enumerations++;
          if (enumerations > 1) throw new Error("output was enumerated twice");
          return Reflect.ownKeys(target);
        }
      }
    );
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async () => output }
    });

    await runtime.start();
    await vi.waitFor(() => expect(client.tasks.complete).toHaveBeenCalledOnce());
    expect(enumerations).toBe(1);
    expect(client.tasks.complete).toHaveBeenCalledWith(
      pending.task_id,
      expect.objectContaining({ output: { value: 1 } })
    );
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("keeps lost queued acknowledgements in authoritative local order", async () => {
    vi.useFakeTimers();
    const first = task("queued-1", "queued.move");
    const second = task("queued-2", "queued.move");
    const { client, transition } = fakeClient([first, second]);
    client.runtime.tasks.mockResolvedValueOnce({ tasks: [first, second] }).mockResolvedValue({ tasks: [] });
    let firstAttempts = 0;
    client.tasks.acknowledge.mockImplementation(async (id: string) => {
      const acknowledged = transition(id, "acknowledged");
      if (id === first.task_id && firstAttempts++ === 0) throw new AtlasTransportError("ack response lost");
      return acknowledged;
    });
    const executionOrder: string[] = [];
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("queued.move")],
      handlers: { "queued.move": async ({ task }) => void executionOrder.push(task.task_id) }
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.tasks.acknowledge.mock.calls.map((call) => call[0])).toEqual(["queued-1", "queued-2"]);
    expect(executionOrder).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(executionOrder).toEqual(["queued-1", "queued-2"]);
    expect(client.tasks.acknowledge.mock.calls.filter((call) => call[0] === "queued-1")).toHaveLength(2);
    expect(client.tasks.start.mock.calls.map((call) => call[0])).toEqual(["queued-1", "queued-2"]);
    await runtime.stop();
  });

  it("starts immediate work without waiting for a slow queued acknowledgement", async () => {
    const queued = task("queued-1", "queued.move");
    const immediate = task("immediate-1", "immediate.observe");
    const { client, transition } = fakeClient([queued, immediate]);
    client.runtime.tasks.mockResolvedValueOnce({ tasks: [queued, immediate] }).mockResolvedValue({ tasks: [] });
    const acknowledgement = deferred<void>();
    client.tasks.acknowledge.mockImplementation(async (id: string) => {
      await acknowledgement.promise;
      return transition(id, "acknowledged");
    });
    const immediateHandler = vi.fn(async () => undefined);
    const queuedHandler = vi.fn(async () => undefined);
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("queued.move"), manifestEntry("immediate.observe", "immediate")],
      handlers: { "queued.move": queuedHandler, "immediate.observe": immediateHandler }
    });

    await runtime.start();
    await vi.waitFor(() => expect(immediateHandler).toHaveBeenCalledOnce());
    expect(queuedHandler).not.toHaveBeenCalled();

    acknowledgement.resolve();
    await vi.waitFor(() => expect(queuedHandler).toHaveBeenCalledOnce());
    await runtime.stop();
  });

  it("retries committed Start and Progress writes without repeating physical execution", async () => {
    vi.useFakeTimers();
    const pending = task("immediate-1", "immediate.observe");
    const { client, transition, emit } = fakeClient([pending]);
    let loseStart = true;
    let loseProgress = true;
    let loseCompletion = true;
    client.tasks.start.mockImplementation(async (id: string) => {
      const started = transition(id, "in_progress");
      if (loseStart) {
        loseStart = false;
        throw new AtlasTransportError("start response lost");
      }
      return started;
    });
    client.tasks.progress.mockImplementation(async (id: string, request: { progress: number }) => {
      const progressed = { ...transition(id, "in_progress"), progress: request.progress };
      emit(progressed);
      if (loseProgress) {
        loseProgress = false;
        throw new AtlasTransportError("progress response lost");
      }
      return progressed;
    });
    client.tasks.complete.mockImplementation(async (id: string) => {
      const completed = transition(id, "completed");
      if (loseCompletion) {
        loseCompletion = false;
        throw new AtlasTransportError("completion response lost");
      }
      return completed;
    });
    const handler = vi.fn(async ({ reportProgress }: { reportProgress(progress: number): Promise<void> }) => {
      await reportProgress(0.5);
      return { result: "done" };
    });
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate", true)],
      handlers: { "immediate.observe": handler }
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(handler).toHaveBeenCalledOnce();
    expect(client.tasks.start).toHaveBeenCalledTimes(2);
    expect(client.tasks.progress).toHaveBeenCalledTimes(2);
    expect(client.tasks.complete).toHaveBeenCalled();
    expect(client.tasks.fail).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("isolates reconciliation failures and caps reads at eight", async () => {
    vi.useFakeTimers();
    const delivered = Array.from({ length: 9 }, (_, index) => task(`immediate-${index + 1}`, "immediate.observe"));
    const { client } = fakeClient(delivered);
    client.runtime.tasks.mockResolvedValueOnce({ tasks: delivered }).mockResolvedValue({ tasks: [] });
    const releaseReads = deferred<void>();
    const firstBatchStarted = deferred<void>();
    let activeReads = 0;
    let maximumReads = 0;
    let readCount = 0;
    client.tasks.get.mockImplementation(async (id: string) => {
      readCount++;
      if (id === "immediate-1") throw new Error("isolated reconciliation failure");
      activeReads++;
      maximumReads = Math.max(maximumReads, activeReads);
      if (readCount === 8) firstBatchStarted.resolve();
      await releaseReads.promise;
      activeReads--;
      return taskWithStatus(task(id, "immediate.observe"), "in_progress", "2026-08-19T12:00:01Z");
    });
    const onError = vi.fn();
    const runtime = new AtlasAssetRuntime(client, {
      entityId: "asset-1",
      manifest: [manifestEntry("immediate.observe", "immediate")],
      handlers: { "immediate.observe": async ({ signal }) => rejectOnAbort(signal) },
      onError
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.tasks.start).toHaveBeenCalledTimes(9);

    await vi.advanceTimersByTimeAsync(5_000);
    await firstBatchStarted.promise;
    expect(readCount).toBe(8);
    expect(maximumReads).toBeLessThanOrEqual(8);

    releaseReads.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(readCount).toBe(9);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "isolated reconciliation failure" }));
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
    const updatedAt = "2026-08-19T12:00:01Z";
    const updated = taskWithStatus(current, status, updatedAt);
    tasks.set(id, updated);
    return updated;
  };
  const client = {
    handshake: vi.fn(async (_options?: { signal?: AbortSignal }) => void order.push("handshake")),
    entities: { checkIn: vi.fn(async (_id: string, _options?: EntityCheckInOptions) => ({})) },
    runtime: {
      begin: vi.fn(async (_assetId: string, _request: { runtime_id: string }) => void order.push("begin")),
      stop: vi.fn(async (_assetId: string, _request: { runtime_id: string }) => void order.push("stop")),
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
      progress: vi.fn(async (id: string, request: { progress: number }) => {
        const progressed = { ...transition(id, "in_progress"), progress: request.progress };
        tasks.set(id, progressed);
        return progressed;
      }),
      complete: vi.fn(async (id: string, _options: TaskCompleteOptions) => transition(id, "completed")),
      fail: vi.fn(async (id: string) => transition(id, "failed"))
    }
  };
  return {
    client: client as unknown as AtlasAssetClient & typeof client,
    transition,
    emit: (value: TaskResource) => {
      tasks.set(value.task_id, value);
    }
  };
}

function taskWithStatus(task: TaskResource, status: TaskResource["status"], timestamp: string): TaskResource {
  switch (status) {
    case "pending":
      return { ...task, status, updated_at: timestamp };
    case "acknowledged":
      return { ...task, status, acknowledged_at: task.acknowledged_at ?? timestamp, updated_at: timestamp };
    case "in_progress":
      return {
        ...task,
        status,
        acknowledged_at: task.acknowledged_at ?? timestamp,
        started_at: task.started_at ?? timestamp,
        updated_at: timestamp
      };
    case "completed":
      return {
        ...task,
        status,
        acknowledged_at: task.acknowledged_at ?? timestamp,
        started_at: task.started_at ?? timestamp,
        finished_at: timestamp,
        updated_at: timestamp
      };
    case "failed":
      return {
        ...task,
        status,
        failure: task.failure ?? { code: "execution_failed", message: "fixture failure" },
        finished_at: timestamp,
        updated_at: timestamp
      };
    case "cancelled":
      return {
        ...task,
        status,
        cancellation: task.cancellation ?? { code: "requested", message: "fixture cancellation" },
        finished_at: timestamp,
        updated_at: timestamp
      };
  }
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

function task(taskId: string, command: string): TaskResource {
  return {
    task_id: taskId,
    asset_id: "asset-1",
    command,
    input: { value: taskId },
    status: "pending",
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
