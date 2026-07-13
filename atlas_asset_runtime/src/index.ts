import type {
  AtlasClient,
  EntityCheckInMinimalTask,
  EntityCheckInOptions,
  EntityCheckInResponse,
  JSONValue,
  TaskCompleteOptions,
  TaskFailOptions,
  TaskLifecycleOptions,
  TaskResource,
  TaskStatusOptions
} from "@the-drunken-coder/atlas-sdk";

const DEFAULT_CHECK_IN_INTERVAL_MS = 5_000;
const TASK_PAGE_SIZE = 20;
const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 10_000;

export type AtlasAssetClient = Pick<AtlasClient, "handshake"> & {
  entities: {
    checkIn(id: string, options: EntityCheckInOptions<"minimal">): Promise<EntityCheckInResponse<EntityCheckInMinimalTask>>;
  };
  tasks: {
    acknowledge(id: string, options?: TaskLifecycleOptions): Promise<TaskResource>;
    complete(id: string, options?: TaskCompleteOptions): Promise<TaskResource>;
    fail(id: string, options?: TaskFailOptions): Promise<TaskResource>;
    setStatus(id: string, status: "acknowledged", options?: TaskStatusOptions): Promise<TaskResource>;
  };
};

export type AssetCheckInReport = Pick<EntityCheckInOptions<"minimal">, "components" | "status" | "telemetry">;

export type AssetTaskContext = {
  task: EntityCheckInMinimalTask;
  signal: AbortSignal;
  reportProgress(progress: number, message?: string): Promise<void>;
};

export type AssetTaskHandler = (context: AssetTaskContext) => Promise<Record<string, JSONValue> | void>;

export type AtlasAssetRuntimeOptions = {
  entityId: string;
  handlers?: Readonly<Record<string, AssetTaskHandler>>;
  checkIn?: () => AssetCheckInReport | Promise<AssetCheckInReport>;
  checkInIntervalMs?: number;
  onError?: (error: unknown) => void;
};

export type AtlasAssetRuntimeStatus = "stopped" | "starting" | "running" | "stopping";

export class AtlasAssetRuntime {
  private readonly client: AtlasAssetClient;
  private readonly entityId: string;
  private readonly handlers: ReadonlyMap<string, AssetTaskHandler>;
  private readonly report?: AtlasAssetRuntimeOptions["checkIn"];
  private readonly checkInIntervalMs: number;
  private readonly onError?: (error: unknown) => void;
  private state: AtlasAssetRuntimeStatus = "stopped";
  private handshakeComplete = false;
  private handshakePromise?: Promise<void>;
  private controller?: AbortController;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private loopPromise?: Promise<void>;
  private cycleTail: Promise<void> = Promise.resolve();
  private externalSignal?: AbortSignal;
  private externalAbort?: () => void;

  constructor(client: AtlasAssetClient, options: AtlasAssetRuntimeOptions) {
    if (!client || typeof client.handshake !== "function") throw new TypeError("client must be AtlasClient-compatible");
    const entityId = options.entityId.trim();
    if (!entityId) throw new TypeError("entityId must not be empty");
    const entries = Object.entries(options.handlers ?? {});
    if (entries.some(([command, handler]) => !command.trim() || command !== command.trim() || typeof handler !== "function")) {
      throw new TypeError("handlers must map non-empty command IDs to functions");
    }
    const interval = options.checkInIntervalMs ?? DEFAULT_CHECK_IN_INTERVAL_MS;
    if (!Number.isFinite(interval) || interval <= 0) throw new TypeError("checkInIntervalMs must be a positive finite number");

    this.client = client;
    this.entityId = entityId;
    this.handlers = new Map(entries);
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
    const cycle = this.cycleTail.catch(() => undefined).then(() => this.runCheckIn(report, signal));
    this.cycleTail = cycle;
    return cycle;
  }

  start(options?: { signal?: AbortSignal }): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.state === "stopping") return Promise.reject(new Error("Atlas asset runtime is stopping"));

    this.state = "starting";
    const controller = new AbortController();
    this.controller = controller;
    this.attachExternalSignal(options?.signal, controller);
    const start = this.startRuntime(controller);
    this.startPromise = start;
    void start
      .finally(() => {
        if (this.startPromise === start) this.startPromise = undefined;
      })
      .catch(() => undefined);
    return start;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stop = this.stopRuntime();
    this.stopPromise = stop;
    void stop
      .finally(() => {
        if (this.stopPromise === stop) this.stopPromise = undefined;
      })
      .catch(() => undefined);
    return stop;
  }

  private async stopRuntime(): Promise<void> {
    this.state = "stopping";
    this.controller?.abort();
    this.detachExternalSignal();
    await Promise.allSettled([this.startPromise, this.loopPromise, this.cycleTail].filter((promise): promise is Promise<void> => promise !== undefined));
    this.loopPromise = undefined;
    this.controller = undefined;
    this.handshakeComplete = false;
    this.state = "stopped";
  }

  private async startRuntime(controller: AbortController): Promise<void> {
    try {
      controller.signal.throwIfAborted();
      await this.ensureHandshake();
      controller.signal.throwIfAborted();
      await this.checkIn();
      controller.signal.throwIfAborted();
      this.state = "running";
      const loop = this.runLoop(controller.signal);
      this.loopPromise = loop;
      void loop
        .finally(() => {
          if (this.loopPromise === loop) this.loopPromise = undefined;
        })
        .catch(() => undefined);
    } catch (error) {
      if (this.controller === controller) {
        this.detachExternalSignal();
        this.controller = undefined;
        if (this.state !== "stopping") {
          this.handshakeComplete = false;
          this.state = "stopped";
        }
      }
      throw error;
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let retryDelay = INITIAL_RETRY_DELAY_MS;
    let nextDelay = this.checkInIntervalMs;
    try {
      while (!signal.aborted) {
        await delay(nextDelay, signal);
        if (signal.aborted) break;
        try {
          await this.checkIn();
          retryDelay = INITIAL_RETRY_DELAY_MS;
          nextDelay = this.checkInIntervalMs;
        } catch (error) {
          if (signal.aborted) break;
          this.reportError(error);
          nextDelay = retryDelay;
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        }
      }
    } finally {
      if (this.controller?.signal === signal && this.state === "running") {
        this.detachExternalSignal();
        this.controller = undefined;
        this.handshakeComplete = false;
        this.state = "stopped";
      }
    }
  }

  private async runCheckIn(providedReport: AssetCheckInReport | undefined, signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    await this.ensureHandshake();
    signal?.throwIfAborted();
    const report = providedReport ?? (await this.report?.()) ?? {};
    signal?.throwIfAborted();
    const handled = new Set<string>();
    let taskCursor: string | undefined;
    do {
      const response = await this.client.entities.checkIn(this.entityId, {
        ...report,
        fields: "minimal",
        statusFilter: ["pending"],
        limit: TASK_PAGE_SIZE,
        ...(taskCursor ? { taskCursor } : {})
      });
      signal?.throwIfAborted();
      for (const task of response.tasks) {
        if (handled.has(task.task_id)) continue;
        handled.add(task.task_id);
        await this.dispatch(task, signal);
        signal?.throwIfAborted();
      }
      if (!response.has_more_tasks) return;
      if (!response.next_task_cursor || response.next_task_cursor === taskCursor) {
        throw new Error("Atlas check-in task pagination did not advance");
      }
      taskCursor = response.next_task_cursor;
    } while (true);
  }

  private async dispatch(task: EntityCheckInMinimalTask, signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (!task.command_id) return;
    const handler = this.handlers.get(task.command_id);
    if (!handler) {
      signal?.throwIfAborted();
      await this.client.tasks.fail(task.task_id, { error: { code: "unsupported_command", command_id: task.command_id } });
      return;
    }

    await this.client.tasks.acknowledge(task.task_id);
    signal?.throwIfAborted();
    let result: Record<string, JSONValue> | void;
    try {
      result = await handler({
        task,
        signal: signal ?? neverAbortedSignal(),
        reportProgress: async (progress, message) => {
          if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new RangeError("progress must be between 0 and 100");
          signal?.throwIfAborted();
          await this.client.tasks.setStatus(task.task_id, "acknowledged", {
            progress,
            ...(message === undefined ? {} : { message })
          });
          signal?.throwIfAborted();
        }
      });
    } catch (error) {
      if (signal?.aborted) return;
      await this.client.tasks.fail(task.task_id, { error: normalizeError(error) });
      return;
    }
    signal?.throwIfAborted();
    await this.client.tasks.complete(task.task_id, result === undefined ? undefined : { result });
  }

  private attachExternalSignal(signal: AbortSignal | undefined, controller: AbortController): void {
    if (!signal) return;
    this.externalSignal = signal;
    this.externalAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", this.externalAbort, { once: true });
    if (signal.aborted) controller.abort(signal.reason);
  }

  private async ensureHandshake(): Promise<void> {
    if (this.handshakeComplete) return;
    if (!this.handshakePromise) {
      const handshake = this.client.handshake();
      this.handshakePromise = handshake;
      void handshake
        .finally(() => {
          if (this.handshakePromise === handshake) this.handshakePromise = undefined;
        })
        .catch(() => undefined);
    }
    await this.handshakePromise;
    this.handshakeComplete = true;
  }

  private detachExternalSignal(): void {
    if (this.externalSignal && this.externalAbort) this.externalSignal.removeEventListener("abort", this.externalAbort);
    this.externalSignal = undefined;
    this.externalAbort = undefined;
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // An observer must not stop the runtime.
    }
  }
}

let idleSignal: AbortSignal | undefined;

function neverAbortedSignal(): AbortSignal {
  return (idleSignal ??= new AbortController().signal);
}

function normalizeError(error: unknown): Record<string, JSONValue> {
  return { message: error instanceof Error ? error.message : String(error) };
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
