import {
  type AtlasClient,
  type CommandManifest,
  type CommandManifestEntry,
  type EntityCheckInOptions,
  isCommandManifest,
  type JSONValue,
  type TaskResource
} from "@the-drunken-coder/atlas-sdk";
import type { ExecutionModule } from "./execution-module.js";
import { establishSafetyBarrier } from "./safety-barrier.js";

const DEFAULT_CHECK_IN_INTERVAL_MS = 5_000;
const TASK_RECONCILIATION_INTERVAL_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type AssetTaskFailureCode = "precondition_failed" | "execution_failed";

export class AssetTaskFailure extends Error {
  constructor(
    readonly code: AssetTaskFailureCode,
    message: string
  ) {
    super(message);
    this.name = "AssetTaskFailure";
  }
}

export type AtlasAssetClient = Pick<AtlasClient, "handshake"> & {
  entities: {
    checkIn(id: string, options?: EntityCheckInOptions): Promise<unknown>;
  };
  runtime: Pick<AtlasClient["runtime"], "begin" | "ready" | "tasks">;
  tasks: Pick<AtlasClient["tasks"], "get" | "acknowledge" | "start" | "progress" | "complete" | "fail">;
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

type TerminalTaskUpdate =
  | { kind: "complete"; output?: JSONValue }
  | { kind: "fail"; failure: { code: AssetTaskFailureCode; message: string } };

type ExternalAbortRegistration = {
  controller: AbortController;
  signal: AbortSignal;
  listener: () => void;
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
  private deliveryLoop?: Promise<void>;
  private checkInTail: Promise<void> = Promise.resolve();
  private deliveryTail: Promise<void> = Promise.resolve();
  private queuedTail: Promise<void> = Promise.resolve();
  private readonly accepted = new Map<string, AcceptedTask>();
  private readonly executions = new Set<Promise<void>>();
  private queued: AcceptedTask[] = [];
  private externalAbort?: ExternalAbortRegistration;

  constructor(client: AtlasAssetClient, options: AtlasAssetRuntimeOptions) {
    if (!client || typeof client.handshake !== "function") throw new TypeError("client must be AtlasClient-compatible");
    this.entityId = requireIdentifier("entityId", options.entityId);
    const manifest = (options.manifest ?? []).map((entry) => ({ ...entry }));
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
    const executionModules = [...(options.executionModules ?? [])];
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
        await this.client.handshake({ signal });
        const body = report ?? (await this.report?.()) ?? {};
        signal?.throwIfAborted();
        await this.client.entities.checkIn(this.entityId, { ...body, signal });
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
    const externalSignal = options?.signal;
    if (externalSignal) {
      const listener = () => {
        controller.abort(externalSignal.reason);
        if (this.controller === controller && this.state === "running") {
          void this.stop().catch((error) => this.reportError(error));
        }
      };
      this.externalAbort = { controller, signal: externalSignal, listener };
      externalSignal.addEventListener("abort", listener, { once: true });
      if (externalSignal.aborted) listener();
    }
    const start = this.startRuntime(controller).finally(() => {
      if (this.state !== "running") this.detachExternalAbort(controller);
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
      await this.client.handshake({ signal: controller.signal });
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
      controller.signal.throwIfAborted();
      this.state = "running";
      this.deliveryLoop = this.runDeliveryLoop(controller.signal);
      void this.deliveryLoop.catch((error) => this.reportError(error));
      this.checkInLoop = this.runCheckInLoop(controller.signal);
      void this.checkInLoop.catch((error) => this.reportError(error));
    } catch (error) {
      if (this.controller === controller && this.state !== "stopping") {
        controller.abort(error);
        this.clearAcceptedWork();
        this.controller = undefined;
        this.runtimeId = undefined;
        this.state = "stopped";
      }
      throw error;
    }
  }

  private async stopRuntime(): Promise<void> {
    this.state = "stopping";
    const controller = this.controller;
    this.detachExternalAbort(controller);
    controller?.abort();
    this.clearAcceptedWork();
    await Promise.allSettled([
      this.startPromise,
      this.checkInLoop,
      this.deliveryLoop,
      this.checkInTail,
      this.deliveryTail,
      this.queuedTail,
      ...this.executions
    ]);
    this.checkInLoop = undefined;
    this.deliveryLoop = undefined;
    this.controller = undefined;
    this.runtimeId = undefined;
    this.state = "stopped";
  }

  private detachExternalAbort(controller?: AbortController): void {
    const registration = this.externalAbort;
    if (!registration || (controller && registration.controller !== controller)) return;
    registration.signal.removeEventListener("abort", registration.listener);
    this.externalAbort = undefined;
  }

  private onTaskChange(task: TaskResource | undefined): void {
    if (!task) return;
    if (isTerminalTaskStatus(task.status)) {
      this.abortLocalTask(task.task_id, `Task became ${task.status}`);
      return;
    }
    if (task.status === "pending") void this.requestDelivery().catch((error) => this.reportError(error));
  }

  private requestDelivery(): Promise<void> {
    const delivery = this.deliveryTail.catch(() => undefined).then(() => this.deliver());
    this.deliveryTail = delivery;
    return delivery;
  }

  private async runDeliveryLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.reconcileAcceptedTasks(signal);
      } catch (error) {
        if (!signal.aborted) this.reportError(error);
      }
      try {
        await this.requestDelivery();
      } catch (error) {
        if (!signal.aborted) this.reportError(error);
      }
      await delay(TASK_RECONCILIATION_INTERVAL_MS, signal);
    }
  }

  private async reconcileAcceptedTasks(signal: AbortSignal): Promise<void> {
    for (const taskId of this.accepted.keys()) {
      signal.throwIfAborted();
      const task = await this.client.tasks.get(taskId, { fresh: true, signal });
      this.onTaskChange(task);
    }
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
      if (command.scheduling === "immediate") {
        this.accepted.set(task.task_id, accepted);
        void this.executeTracked(accepted, handler, false).catch((error) => this.reportError(error));
        continue;
      }
      await this.client.tasks.acknowledge(task.task_id, { runtimeId, signal });
      this.accepted.set(task.task_id, accepted);
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
          await this.executeTracked(accepted, handler, true);
        }
      });
    this.queuedTail = run;
    void run.catch((error) => this.reportError(error));
  }

  private executeTracked(accepted: AcceptedTask, handler: AssetTaskHandler, queued: boolean): Promise<void> {
    const execution = this.execute(accepted, handler, queued);
    this.executions.add(execution);
    void execution.then(
      () => {
        this.executions.delete(execution);
      },
      () => {
        this.executions.delete(execution);
      }
    );
    return execution;
  }

  private async execute(accepted: AcceptedTask, handler: AssetTaskHandler, queued: boolean): Promise<void> {
    const runtimeId = this.runtimeId;
    const runtimeSignal = this.controller?.signal;
    if (!runtimeId || !runtimeSignal || runtimeSignal.aborted || accepted.controller.signal.aborted) return;
    const signal = AbortSignal.any([runtimeSignal, accepted.controller.signal]);
    let terminalUpdate: TerminalTaskUpdate;
    try {
      const started = await this.client.tasks.start(accepted.task.task_id, { runtimeId, signal });
      if (started.status !== "in_progress") {
        if (isTerminalTaskStatus(started.status)) {
          this.onTaskChange(started);
          return;
        }
        throw new Error(`Core returned ${started.status} after starting ${accepted.task.task_id}`);
      }
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
      terminalUpdate = { kind: "complete", ...(output === undefined ? {} : { output }) };
    } catch (error) {
      if (signal.aborted) return;
      terminalUpdate = {
        kind: "fail",
        failure:
          error instanceof AssetTaskFailure
            ? { code: error.code, message: normalizeError(error) }
            : { code: "execution_failed", message: normalizeError(error) }
      };
    } finally {
      void this.requestDelivery().catch((error) => this.reportError(error));
    }
    await this.reportTerminalUpdate(accepted, terminalUpdate, runtimeId, signal);
  }

  private async reportTerminalUpdate(
    accepted: AcceptedTask,
    update: TerminalTaskUpdate,
    runtimeId: string,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted && this.accepted.has(accepted.task.task_id)) {
      try {
        const task =
          update.kind === "complete"
            ? await this.client.tasks.complete(accepted.task.task_id, {
                runtimeId,
                signal,
                ...(update.output === undefined ? {} : { output: update.output })
              })
            : await this.client.tasks.fail(accepted.task.task_id, {
                runtimeId,
                signal,
                failure: update.failure
              });
        if (!isTerminalTaskStatus(task.status)) {
          throw new Error(`Core returned ${task.status} after reporting ${accepted.task.task_id} terminal`);
        }
        this.onTaskChange(task);
        return;
      } catch (error) {
        if (signal.aborted) return;
        this.reportError(error);
        await delay(TASK_RECONCILIATION_INTERVAL_MS, signal);
      }
    }
  }

  private abortLocalTask(taskId: string, reason: string): void {
    const accepted = this.accepted.get(taskId);
    if (!accepted) return;
    accepted.controller.abort(new Error(reason));
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

function isTerminalTaskStatus(status: TaskResource["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
