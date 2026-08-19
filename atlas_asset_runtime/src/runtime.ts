import {
  type AtlasClient,
  type AtlasSubscription,
  type CommandManifest,
  type CommandManifestEntry,
  type EntityCheckInOptions,
  isCommandManifest,
  type JSONValue,
  type RuntimeContextOptions,
  type RuntimeTaskDeliveryResponse,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { ExecutionModule } from "./execution-module.js";
import { establishSafetyBarrier } from "./safety-barrier.js";

const DEFAULT_CHECK_IN_INTERVAL_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type AtlasAssetClient = Pick<AtlasClient, "handshake" | "subscribe" | "watch"> & {
  sync: Pick<AtlasClient["sync"], "start" | "stop">;
  entities: {
    checkIn(id: string, options?: EntityCheckInOptions): Promise<unknown>;
  };
  runtime: {
    begin(assetId: string, request: { runtime_id: string }, options?: { signal?: AbortSignal }): Promise<void>;
    ready(
      assetId: string,
      request: { runtime_id: string; manifest: CommandManifest },
      options?: { signal?: AbortSignal }
    ): Promise<void>;
    tasks(assetId: string, options: RuntimeContextOptions): Promise<RuntimeTaskDeliveryResponse>;
  };
  tasks: {
    acknowledge(id: string, options: RuntimeContextOptions): Promise<TaskResource>;
    start(id: string, options: RuntimeContextOptions): Promise<TaskResource>;
    progress(id: string, request: { progress: number }, options: RuntimeContextOptions): Promise<TaskResource>;
    complete(id: string, options: RuntimeContextOptions & { output?: JSONValue }): Promise<TaskResource>;
    fail(
      id: string,
      options: RuntimeContextOptions & {
        failure: { code: "execution_failed" | "unsupported_command"; message: string };
      }
    ): Promise<TaskResource>;
  };
};

export type AssetCheckInReport = Pick<EntityCheckInOptions, "components" | "status" | "telemetry">;

export type AssetTaskContext = {
  task: TaskResource;
  signal: AbortSignal;
  reportProgress(progress: number): Promise<void>;
};

export type AssetTaskHandler = (context: AssetTaskContext) => Promise<JSONValue | void>;

export type AtlasAssetRuntimeOptions = {
  entityId: string;
  manifest?: CommandManifest;
  handlers?: Readonly<Record<string, AssetTaskHandler>>;
  executionModules?: readonly ExecutionModule[];
  checkIn?: () => AssetCheckInReport | Promise<AssetCheckInReport>;
  checkInIntervalMs?: number;
  onError?: (error: unknown) => void;
};

export type AtlasAssetRuntimeStatus = "stopped" | "starting" | "running" | "stopping";

type AcceptedTask = {
  task: TaskResource;
  command: CommandManifestEntry;
  controller: AbortController;
};

export class AtlasAssetRuntime {
  private readonly client: AtlasAssetClient;
  private readonly entityId: string;
  private readonly manifest: CommandManifest;
  private readonly commands: ReadonlyMap<string, CommandManifestEntry>;
  private readonly handlers: ReadonlyMap<string, AssetTaskHandler>;
  private readonly executionModules: readonly ExecutionModule[];
  private readonly report?: AtlasAssetRuntimeOptions["checkIn"];
  private readonly checkInIntervalMs: number;
  private readonly onError?: (error: unknown) => void;
  private state: AtlasAssetRuntimeStatus = "stopped";
  private runtimeId?: string;
  private controller?: AbortController;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private checkInLoop?: Promise<void>;
  private checkInTail: Promise<void> = Promise.resolve();
  private deliveryTail: Promise<void> = Promise.resolve();
  private queuedTail: Promise<void> = Promise.resolve();
  private readonly accepted = new Map<string, AcceptedTask>();
  private queued: AcceptedTask[] = [];
  private unwatch?: () => void;

  constructor(client: AtlasAssetClient, options: AtlasAssetRuntimeOptions) {
    if (!client || typeof client.handshake !== "function") throw new TypeError("client must be AtlasClient-compatible");
    this.entityId = requireIdentifier("entityId", options.entityId);
    const manifest = options.manifest ?? [];
    if (!isCommandManifest(manifest)) throw new TypeError("manifest must satisfy the Atlas Protocol Command Manifest");
    const handlers = new Map(Object.entries(options.handlers ?? {}));
    const commands = new Map(manifest.map((entry) => [entry.command, entry]));
    if (commands.size !== manifest.length) throw new TypeError("manifest Commands must be unique");
    for (const command of commands.keys()) {
      if (typeof handlers.get(command) !== "function") {
        throw new TypeError(`manifest Command ${command} requires a handler`);
      }
    }
    for (const command of handlers.keys()) {
      if (!commands.has(command)) throw new TypeError(`handler Command ${command} is not advertised in the manifest`);
    }
    const executionModules = options.executionModules ?? [];
    const moduleIds = executionModules.map((module) => requireIdentifier("execution module id", module.id));
    if (new Set(moduleIds).size !== moduleIds.length) throw new TypeError("execution module ids must be unique");
    const interval = options.checkInIntervalMs ?? DEFAULT_CHECK_IN_INTERVAL_MS;
    if (!Number.isFinite(interval) || interval <= 0 || interval > MAX_TIMER_DELAY_MS) {
      throw new TypeError(`checkInIntervalMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
    }

    this.client = client;
    this.manifest = manifest;
    this.commands = commands;
    this.handlers = handlers;
    this.executionModules = executionModules;
    this.report = options.checkIn;
    this.checkInIntervalMs = interval;
    this.onError = options.onError;
  }

  get status(): AtlasAssetRuntimeStatus {
    return this.state;
  }

  checkIn(report?: AssetCheckInReport): Promise<void> {
    if (this.state === "stopping") return Promise.reject(new Error("Atlas asset runtime is stopping"));
    const signal = this.controller?.signal;
    const cycle = this.checkInTail
      .catch(() => undefined)
      .then(async () => {
        signal?.throwIfAborted();
        await this.client.handshake();
        const body = report ?? (await this.report?.()) ?? {};
        signal?.throwIfAborted();
        await this.client.entities.checkIn(this.entityId, body);
      });
    this.checkInTail = cycle;
    return cycle;
  }

  start(options?: { signal?: AbortSignal }): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.state === "stopping") return Promise.reject(new Error("Atlas asset runtime is stopping"));
    this.state = "starting";
    const controller = new AbortController();
    this.controller = controller;
    const externalAbort = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", externalAbort, { once: true });
    if (options?.signal?.aborted) externalAbort();
    const start = this.startRuntime(controller).finally(() => {
      options?.signal?.removeEventListener("abort", externalAbort);
      if (this.startPromise === start) this.startPromise = undefined;
    });
    this.startPromise = start;
    return start;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    const stop = this.stopRuntime().finally(() => {
      if (this.stopPromise === stop) this.stopPromise = undefined;
    });
    this.stopPromise = stop;
    return stop;
  }

  private async startRuntime(controller: AbortController): Promise<void> {
    try {
      controller.signal.throwIfAborted();
      await this.client.handshake();
      const runtimeId = createRuntimeId();
      this.runtimeId = runtimeId;
      this.clearAcceptedWork();
      await this.client.runtime.begin(this.entityId, { runtime_id: runtimeId }, { signal: controller.signal });
      await establishSafetyBarrier(this.executionModules, controller.signal);
      await this.client.runtime.ready(
        this.entityId,
        { runtime_id: runtimeId, manifest: this.manifest },
        { signal: controller.signal }
      );
      const subscription = this.taskSubscription();
      this.unwatch = this.client.watch(subscription, (task) => this.onTaskChange(task));
      await this.client.subscribe(subscription);
      await this.client.sync.start();
      controller.signal.throwIfAborted();
      await this.requestDelivery();
      this.state = "running";
      this.checkInLoop = this.runCheckInLoop(controller.signal);
      void this.checkInLoop.catch((error) => this.reportError(error));
    } catch (error) {
      if (this.controller === controller && this.state !== "stopping") {
        this.controller = undefined;
        this.runtimeId = undefined;
        this.unwatch?.();
        this.unwatch = undefined;
        this.state = "stopped";
      }
      throw error;
    }
  }

  private async stopRuntime(): Promise<void> {
    this.state = "stopping";
    this.controller?.abort();
    this.clearAcceptedWork();
    this.unwatch?.();
    this.unwatch = undefined;
    this.client.sync.stop();
    await Promise.allSettled([
      this.startPromise,
      this.checkInLoop,
      this.checkInTail,
      this.deliveryTail,
      this.queuedTail
    ]);
    this.checkInLoop = undefined;
    this.controller = undefined;
    this.runtimeId = undefined;
    this.state = "stopped";
  }

  private taskSubscription(): Extract<AtlasSubscription, { filter: "tasks_for_asset" }> {
    return { filter: "tasks_for_asset", asset_id: this.entityId };
  }

  private onTaskChange(task: TaskResource | undefined): void {
    if (!task) return;
    if (task.status === "cancelled") {
      this.cancelLocalTask(task.task_id);
      return;
    }
    if (task.status === "pending") void this.requestDelivery().catch((error) => this.reportError(error));
  }

  private requestDelivery(): Promise<void> {
    const delivery = this.deliveryTail.catch(() => undefined).then(() => this.deliver());
    this.deliveryTail = delivery;
    return delivery;
  }

  private async deliver(): Promise<void> {
    const runtimeId = this.runtimeId;
    const signal = this.controller?.signal;
    if (!runtimeId || !signal || signal.aborted) return;
    const response = await this.client.runtime.tasks(this.entityId, { runtimeId, signal });
    for (const task of response.tasks) {
      signal.throwIfAborted();
      if (this.accepted.has(task.task_id) || task.status !== "pending") continue;
      const command = this.commands.get(task.command);
      const handler = this.handlers.get(task.command);
      if (!command || !handler) {
        await this.client.tasks.fail(task.task_id, {
          runtimeId,
          signal,
          failure: { code: "unsupported_command", message: `Runtime does not advertise ${task.command}` }
        });
        continue;
      }
      const accepted = { task, command, controller: new AbortController() };
      this.accepted.set(task.task_id, accepted);
      if (command.scheduling === "immediate") {
        void this.execute(accepted, handler, false).catch((error) => this.reportError(error));
        continue;
      }
      await this.client.tasks.acknowledge(task.task_id, { runtimeId, signal });
      this.queued.push(accepted);
      this.scheduleQueuedWork();
    }
  }

  private scheduleQueuedWork(): void {
    const run = this.queuedTail
      .catch(() => undefined)
      .then(async () => {
        for (;;) {
          const accepted = this.queued.shift();
          if (!accepted) return;
          const handler = this.handlers.get(accepted.task.command);
          if (!handler || accepted.controller.signal.aborted) continue;
          await this.execute(accepted, handler, true);
        }
      });
    this.queuedTail = run;
    void run.catch((error) => this.reportError(error));
  }

  private async execute(accepted: AcceptedTask, handler: AssetTaskHandler, queued: boolean): Promise<void> {
    const runtimeId = this.runtimeId;
    const runtimeSignal = this.controller?.signal;
    if (!runtimeId || !runtimeSignal || runtimeSignal.aborted || accepted.controller.signal.aborted) return;
    const signal = AbortSignal.any([runtimeSignal, accepted.controller.signal]);
    try {
      await this.client.tasks.start(accepted.task.task_id, { runtimeId, signal });
      if (!queued) void this.requestDelivery().catch((error) => this.reportError(error));
      const output = await handler({
        task: accepted.task,
        signal,
        reportProgress: async (progress) => {
          if (!accepted.command.supports_progress)
            throw new Error(`${accepted.task.command} does not support progress`);
          if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
            throw new RangeError("progress must be between 0 and 1");
          }
          signal.throwIfAborted();
          await this.client.tasks.progress(accepted.task.task_id, { progress }, { runtimeId, signal });
        }
      });
      signal.throwIfAborted();
      await this.client.tasks.complete(accepted.task.task_id, {
        runtimeId,
        signal,
        ...(output === undefined ? {} : { output })
      });
    } catch (error) {
      if (!signal.aborted) {
        await this.client.tasks.fail(accepted.task.task_id, {
          runtimeId,
          signal,
          failure: { code: "execution_failed", message: normalizeError(error) }
        });
      }
    } finally {
      this.accepted.delete(accepted.task.task_id);
      void this.requestDelivery().catch((error) => this.reportError(error));
    }
  }

  private cancelLocalTask(taskId: string): void {
    const accepted = this.accepted.get(taskId);
    if (!accepted) return;
    accepted.controller.abort(new Error("Task cancelled"));
    this.queued = this.queued.filter((item) => item.task.task_id !== taskId);
    this.accepted.delete(taskId);
  }

  private clearAcceptedWork(): void {
    for (const accepted of this.accepted.values()) accepted.controller.abort(new Error("Runtime stopped"));
    this.accepted.clear();
    this.queued = [];
  }

  private async runCheckInLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await delay(this.checkInIntervalMs, signal);
      if (signal.aborted) return;
      try {
        await this.checkIn();
      } catch (error) {
        if (!signal.aborted) this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Observer failures do not alter execution state.
    }
  }
}

function createRuntimeId(): string {
  return `runtime-${crypto.randomUUID()}`;
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized !== value) throw new TypeError(`${name} must be a trimmed non-empty string`);
  return normalized;
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Execution failed";
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
