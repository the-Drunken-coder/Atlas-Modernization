import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CommandCancelledError } from "../src/operation-errors.js";
import type {
  AtlasCoreOperator,
  DeploymentSnapshot,
  DiagnosticsResult,
  LifecycleOperation,
  LifecycleOperationOptions,
  LifecycleOperationProgress,
  LifecycleOperationResult,
  LogStream,
  PluginActivityReporter,
  PluginDeploymentStatus,
  PluginOperationOutcome,
  UpdateReporter,
  UpdateScope
} from "../src/operator.js";
import { PACKAGE_VERSION } from "../src/package-metadata.js";
import { createInteractiveCLI } from "../src/terminal-ui.js";

class TestTerminal {
  readonly input = new PassThrough() as PassThrough & NodeJS.ReadStream;
  readonly output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  readonly setRawMode = vi.fn((enabled: boolean) => {
    Object.assign(this.input, { isRaw: enabled });
    return this.input;
  });
  #output = "";

  constructor(columns = 100, interactive = true, rows = 40) {
    Object.assign(this.input, {
      isRaw: false,
      isTTY: interactive,
      ref: () => this.input,
      setRawMode: interactive ? this.setRawMode : undefined,
      unref: () => this.input
    });
    Object.assign(this.output, {
      columns,
      isTTY: interactive,
      rows
    });
    this.output.on("data", (data: Buffer) => {
      this.#output += data.toString();
    });
  }

  get raw(): string {
    return this.#output;
  }

  get text(): string {
    return stripAnsi(this.#output);
  }

  write(value: string): void {
    this.input.write(value);
  }

  resize(columns: number, rows = this.output.rows): void {
    Object.assign(this.output, { columns, rows });
    this.output.emit("resize");
  }

  writeWhenVisible(value: string, input: string): void {
    const writeInput = (): void => {
      if (!this.text.includes(value)) return;
      this.output.off("data", writeInput);
      this.write(input);
    };
    this.output.on("data", writeInput);
  }

  async waitFor(value: string): Promise<void> {
    await vi.waitFor(() => expect(this.text).toContain(value), { timeout: 2_000 });
  }

  async waitForRawChange(previousLength: number): Promise<void> {
    await vi.waitFor(() => expect(this.raw.length).toBeGreaterThan(previousLength), { timeout: 2_000 });
  }
}

type TestDeploymentSnapshot = Omit<DeploymentSnapshot, "canReset"> & { canReset?: boolean };

function operator(snapshot: TestDeploymentSnapshot = { status: "ready", detail: "Everything is healthy." }) {
  const normalizedSnapshot = {
    canReset: snapshot.status !== "initializing" && snapshot.status !== "not-initialized",
    ...snapshot
  } satisfies DeploymentSnapshot;
  const update = vi.fn(async (_scope: UpdateScope, _expectedVersion?: string) => undefined);
  return {
    cancelPending: vi.fn(),
    checkForUpdates: vi.fn(async () => ({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.5",
      cliUpdateAvailable: false,
      coreUpdateAvailable: false
    })),
    configureAdminPassword: vi.fn(async () => undefined),
    diagnostics: vi.fn(async (): Promise<DiagnosticsResult> => ({ healthy: true, checks: [] })),
    details: vi.fn(async (_signal?: AbortSignal) => ({
      snapshot: normalizedSnapshot,
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      initializedAt: "2026-08-28T12:00:00.000Z",
      apiEndpoint: "http://127.0.0.1:8000",
      minioEndpoint: "http://127.0.0.1:9001",
      services: [
        {
          id: "api" as const,
          label: "Core API",
          container: "atlas_core_production_api",
          state: "running",
          health: "healthy",
          cpuPercent: "1.00%",
          memoryUsage: "128MiB / 1GiB",
          memoryPercent: "12.50%",
          networkIO: "1MB / 2MB",
          blockIO: "3MB / 4MB",
          processes: "12",
          uptime: "4d 2h",
          restarts: 0
        },
        {
          id: "postgres" as const,
          label: "PostgreSQL",
          container: "atlas_core_production_postgres",
          state: "running",
          health: "healthy",
          cpuPercent: "2.00%",
          memoryUsage: "256MiB / 1GiB",
          memoryPercent: "25.00%",
          networkIO: "2MB / 3MB",
          blockIO: "4MB / 5MB",
          processes: "13",
          uptime: "4d 2h",
          restarts: 0
        },
        {
          id: "minio" as const,
          label: "MinIO",
          container: "atlas_core_production_minio",
          state: "running",
          health: "healthy",
          cpuPercent: "3.00%",
          memoryUsage: "192MiB / 1GiB",
          memoryPercent: "18.75%",
          networkIO: "3MB / 4MB",
          blockIO: "5MB / 6MB",
          processes: "14",
          uptime: "4d 2h",
          restarts: 0
        }
      ]
    })),
    doctor: vi.fn(async () => true),
    init: vi.fn(async () => undefined),
    logs: vi.fn(async () => undefined),
    openLogStream: vi.fn(async (): Promise<LogStream> => emptyLogStream()),
    openPluginLogStream: vi.fn(async (): Promise<LogStream> => emptyLogStream()),
    pluginDisable: vi.fn(
      async (_pluginId: string, _reportActivity?: PluginActivityReporter): Promise<PluginOperationOutcome> => ({
        status: "success"
      })
    ),
    pluginEnable: vi.fn(
      async (_pluginId: string, _reportActivity?: PluginActivityReporter): Promise<PluginOperationOutcome> => ({
        status: "success"
      })
    ),
    pluginLogs: vi.fn(async () => undefined),
    pluginInstall: vi.fn(
      async (
        _pluginId: string,
        _version?: string,
        _reportActivity?: PluginActivityReporter
      ): Promise<PluginOperationOutcome> => ({ status: "success" })
    ),
    pluginRefresh: vi.fn(async () => undefined),
    pluginStatuses: vi.fn(async (_pluginId?: string): Promise<PluginDeploymentStatus[]> => []),
    resumeAfterCancellation: vi.fn(),
    reset: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => normalizedSnapshot),
    start: vi.fn(async () => undefined),
    status: vi.fn(async () => true),
    stop: vi.fn(async (): Promise<void> => {}),
    update,
    updateWithProgress: vi.fn(async (scope: UpdateScope, expectedVersion?: string, report?: UpdateReporter) => {
      report?.({ message: "Applying reviewed update...", stage: "operation" });
      await update(scope, expectedVersion);
    }),
    runLifecycle: vi.fn(
      async (
        operation: LifecycleOperation,
        report?: (progress: LifecycleOperationProgress) => void,
        _options?: LifecycleOperationOptions
      ): Promise<LifecycleOperationResult> => {
        report?.({ message: `${operation} requested`, stage: "operation" });
        return { status: "success", summary: `Atlas Core ${operation} complete.` };
      }
    )
  } satisfies AtlasCoreOperator;
}

function emptyLogStream(): LogStream {
  return {
    service: undefined,
    onLine: () => () => undefined,
    onError: () => () => undefined,
    onClose: (listener) => {
      listener();
      return () => undefined;
    },
    wait: async () => undefined,
    close: async () => undefined
  };
}

function liveLogStream(): LogStream & {
  emit(line: string): void;
  end(): void;
  fail(error: Error): void;
  closed: boolean;
} {
  const listeners = new Set<(line: string) => void>();
  let resolveWait!: () => void;
  let rejectWait!: (error: Error) => void;
  const wait = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  let closed = false;
  return {
    service: undefined,
    onLine(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onError: () => () => undefined,
    onClose: () => () => undefined,
    wait: () => wait,
    close: async () => {
      closed = true;
      resolveWait();
    },
    emit(line) {
      for (const listener of listeners) listener(line);
    },
    end() {
      resolveWait();
    },
    fail(error) {
      rejectWait(error);
    },
    get closed() {
      return closed;
    }
  };
}

describe("Atlas Core terminal UI", () => {
  it("shows the shipped unfiltered action list", async () => {
    const terminal = new TestTerminal();
    const deployment = operator({ status: "ready", detail: "Core API and storage are healthy." });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    expect(terminal.text).toContain("View service health");
    expect(terminal.text).toContain("View logs and diagnostics");
    expect(terminal.text).toContain("Stop Atlas Core");
    expect(terminal.text).toContain("Restart Atlas Core");
    expect(terminal.text).toContain("Manage Plugins");
    expect(terminal.text).toContain("Update Atlas Core");
    expect(terminal.text).toContain("Esc exit");
    expect(terminal.text).not.toContain("Filter:");
    terminal.write("q");
    await menu;

    expect(deployment.snapshot).toHaveBeenCalledOnce();
    expect(deployment.details).not.toHaveBeenCalled();
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("opens Plugin management from the action list", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.pluginStatuses.mockResolvedValue([
      {
        pluginId: "building_scan",
        displayName: "Building Scan",
        lifecycle: "query_only",
        enabled: false,
        packaged: true
      }
    ]);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    for (let index = 0; index < 4; index += 1) {
      terminal.write("\u001b[B");
      await nextInputTurn();
    }
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    expect(deployment.pluginRefresh).not.toHaveBeenCalled();
    expect(deployment.pluginStatuses).toHaveBeenCalledOnce();
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("explains how to populate an empty Plugin catalog", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("No Plugins are installed or available from the verified catalog.");
    expect(terminal.text).toContain("Run atlas-core plugins refresh");
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("runs Plugin installation in the activity screen", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: false,
      installed: false
    };
    deployment.pluginStatuses
      .mockResolvedValueOnce([plugin])
      .mockResolvedValueOnce([{ ...plugin, installed: true, selectedVersion: "1.2.0" }]);
    deployment.pluginInstall.mockImplementation(async (_pluginId, _version, reportActivity) => {
      reportActivity?.({ level: "working", message: "Downloading release", stage: "operation" });
      reportActivity?.({ level: "success", message: "Building Scan 1.2.0 installed.", stage: "operation" });
      return { status: "success" };
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    for (let index = 0; index < 4; index += 1) {
      terminal.write("\u001b[B");
      await nextInputTurn();
    }
    terminal.write("\r");
    await terminal.waitFor("not installed");
    terminal.write("\r");
    await terminal.waitFor("ATLAS CORE > ACTIVITY");
    await terminal.waitFor("Building Scan installed.");
    await terminal.waitFor("Enter return to Plugins");
    expect(deployment.pluginInstall).toHaveBeenCalledWith("building_scan", undefined, expect.any(Function));
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("uses the controlled viewer for Plugin logs and closes its stream", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: true,
      packaged: true,
      installed: true
    };
    const stream = liveLogStream();
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.openPluginLogStream.mockResolvedValue(stream);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    for (let index = 0; index < 4; index += 1) {
      terminal.write("\u001b[B");
      await nextInputTurn();
    }
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("l");
    await terminal.waitFor("ATLAS CORE > PLUGIN LOGS");
    stream.emit("plugin log line");
    await terminal.waitFor("plugin log line");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("returns to Plugin management when opening Plugin logs fails", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: true,
      packaged: true,
      installed: true
    };
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.openPluginLogStream.mockRejectedValue(new Error("fixture Plugin stream failed"));
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("l");
    await terminal.waitFor("Unable to open Plugin logs: fixture Plugin stream failed");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("returns to Plugin management after safe Escape cancellation", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let cancelEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValueOnce([plugin]).mockResolvedValueOnce([plugin]);
    deployment.pluginEnable.mockImplementation(
      async (_pluginId, reportActivity) =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          reportActivity?.({ level: "working", message: "Preparing enable", stage: "operation" });
          cancelEnable = () => {
            reportActivity?.({ level: "failure", message: "Enable cancelled", stage: "operation" });
            reportActivity?.({ level: "success", message: "Previous deployment restored", stage: "rollback" });
            resolve({ previousDeploymentPreserved: true, status: "cancelled" });
          };
        })
    );
    deployment.cancelPending.mockImplementation(() => cancelEnable?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    for (let index = 0; index < 4; index += 1) {
      terminal.write("\u001b[B");
      await nextInputTurn();
    }
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Preparing enable");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce());
    await terminal.waitFor("PLUGIN CATALOG");
    expect(deployment.pluginRefresh).not.toHaveBeenCalled();
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("upgrades Plugin Escape cancellation to exit before cleanup completes", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let finishEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async (_pluginId, reportActivity) =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          reportActivity?.({ level: "working", message: "Preparing enable", stage: "operation" });
          finishEnable = () => resolve({ previousDeploymentPreserved: true, status: "cancelled" });
        })
    );
    deployment.cancelPending.mockImplementation(() => undefined);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);
    let resolved = false;
    const completion = menu.then(
      () => {
        resolved = true;
        return "resolved" as const;
      },
      () => "rejected" as const
    );

    await terminal.waitFor("Manage Plugins");
    for (let index = 0; index < 4; index += 1) {
      terminal.write("\u001b[B");
      await nextInputTurn();
    }
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Preparing enable");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.cancelPending).toHaveBeenCalledOnce());
    terminal.write("\u0003");
    await nextInputTurn();
    terminal.write("\u001b");
    await nextInputTurn();
    finishEnable?.();
    await vi.waitFor(() => expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce());
    const outcome = await Promise.race([
      completion,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500))
    ]);
    if (outcome === "timeout") terminal.input.emit("end");
    expect(await completion).toBe("resolved");

    expect(resolved).toBe(true);
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
  });

  it("cancels and exits after Plugin cleanup on Ctrl-C", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let cancelEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async (_pluginId, reportActivity) =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          reportActivity?.({ level: "working", message: "Preparing enable", stage: "operation" });
          cancelEnable = () => resolve({ previousDeploymentPreserved: true, status: "cancelled" });
        })
    );
    deployment.cancelPending.mockImplementation(() => cancelEnable?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    for (let index = 0; index < 4; index += 1) {
      terminal.write("\u001b[B");
      await nextInputTurn();
    }
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Preparing enable");
    terminal.write("\u0003");
    await expect(menu).resolves.toBeUndefined();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
  });

  it("cancels and exits after Plugin cleanup on process SIGINT", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let finishEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async () =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          finishEnable = () => resolve({ previousDeploymentPreserved: true, status: "cancelled" });
        })
    );
    deployment.cancelPending.mockImplementation(() => finishEnable?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Enable requested");
    process.emit("SIGINT", "SIGINT");
    await expect(menu).resolves.toBeUndefined();
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
  });

  it("shows a committed Plugin change as success after a late cancellation request", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let finishEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async (_pluginId, reportActivity) =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          reportActivity?.({ level: "success", message: "Core API and Building Scan are healthy", stage: "operation" });
          finishEnable = () => {
            reportActivity?.({ level: "success", message: "Building Scan enabled and healthy", stage: "operation" });
            resolve({ status: "success" });
          };
        })
    );
    deployment.cancelPending.mockImplementation(() => finishEnable?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Core API and Building Scan are healthy");
    terminal.write("\u001b");
    await terminal.waitFor("Building Scan enabled.");
    expect(terminal.text).not.toContain("Enable cancelled. The previous deployment is preserved.");
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it.each([
    ["ready", "Running"],
    ["stopped", "Stopped"],
    ["degraded", "Degraded"],
    ["initializing", "Initializing"],
    ["not-initialized", "Not initialized"]
  ] as const)("renders the %s fixture state in the action-list home", async (status, label) => {
    const terminal = new TestTerminal(80, true, 24);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(
      operator({ status, detail: `${label} fixture state.` })
    );

    await terminal.waitFor(label);
    expect(terminal.text).toContain("Deployment");
    terminal.write("q");
    await menu;
  });

  it("offers Retry initialization for resumable initialization and blocks unsafe degraded starts", async () => {
    const initializingTerminal = new TestTerminal(80, true, 24);
    const initializingMenu = createInteractiveCLI(initializingTerminal.input, initializingTerminal.output).runMenu(
      operator({ status: "initializing", detail: "Atlas Core initialization can be resumed." })
    );

    await initializingTerminal.waitFor("Retry initialization");
    expect(initializingTerminal.text).not.toContain("Reset Atlas Core");
    expect(initializingTerminal.text).not.toContain("Start Atlas Core");
    initializingTerminal.write("q");
    await initializingMenu;

    const degradedTerminal = new TestTerminal(80, true, 24);
    const degradedMenu = createInteractiveCLI(degradedTerminal.input, degradedTerminal.output).runMenu(
      operator({ status: "degraded", detail: "The Docker engine does not match this deployment." })
    );

    await degradedTerminal.waitFor("Degraded");
    expect(degradedTerminal.text).toContain("Stop Atlas Core");
    expect(degradedTerminal.text).not.toContain("Start Atlas Core");
    expect(degradedTerminal.text).not.toContain("Retry initialization");
    degradedTerminal.write("q");
    await degradedMenu;
  });

  it("hides reset when the deployment snapshot does not satisfy reset preconditions", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(
      operator({
        status: "degraded",
        canReset: false,
        detail: "Atlas Core update recovery is pending."
      })
    );

    await terminal.waitFor("Degraded");
    expect(terminal.text).not.toContain("Reset Atlas Core");
    terminal.write("q");
    await menu;
  });

  it("renders the running Core version instead of the CLI package version", async () => {
    const terminal = new TestTerminal();
    const deployment = operator({ status: "ready", detail: "Core is running.", coreVersion: "0.1.2" });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    expect(terminal.text).toContain("v0.1.2");
    expect(terminal.text).not.toContain(`v${PACKAGE_VERSION}`);
    terminal.write("q");
    await menu;
  });

  it("fits the action list at the supported 40 by 24 size", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(operator());

    await terminal.waitFor("CHOOSE AN ACTION");
    expect(terminal.text).not.toContain("Action list needs at least");
    const before = terminal.raw.length;
    terminal.write("\u001b[B");
    await terminal.waitForRawChange(before);
    terminal.write("q");
    await menu;
  });

  it("keeps home actions available when a degraded detail exceeds the terminal", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator({
      status: "degraded",
      detail: `Docker preflight failed: ${"x".repeat(64 * 1024)}`
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    expect(terminal.text).not.toContain("Action list needs at least");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledOnce());
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("opens a controlled bounded log viewer and closes the stream on Escape", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const stream = liveLogStream();
    deployment.openLogStream.mockResolvedValue(stream);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("LIVE LOGS");
    const beforeLine = terminal.raw.length;
    stream.emit("a very long diagnostic line that must wrap inside the viewer instead of overlapping the footer");
    await terminal.waitFor("pause/follow");
    await terminal.waitForRawChange(beforeLine);
    expect(terminal.text).toContain("a very long diagnostic line");
    terminal.write("\r");
    await nextInputTurn();
    expect(stream.closed).toBe(false);
    expect(deployment.openLogStream).toHaveBeenCalledOnce();
    terminal.write(" ");
    await terminal.waitFor("PAUSED");
    terminal.write("\u001b[A");
    terminal.write("\u001b[B");
    terminal.write("\u001b[F");
    await terminal.waitFor("FOLLOWING");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    terminal.write("q");
    await menu;
  });

  it("returns to service health when opening logs fails", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    deployment.openLogStream.mockRejectedValue(new Error("fixture log stream failed"));
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\r");
    await terminal.waitFor("ATLAS CORE > STATUS");
    terminal.write("l");
    await terminal.waitFor("Unable to open logs: fixture log stream failed");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(2));
    await terminal.waitFor("ATLAS CORE > STATUS");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("keeps the live log stream open while the terminal is resized", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const stream = liveLogStream();
    deployment.openLogStream.mockResolvedValue(stream);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("LIVE LOGS");
    stream.emit("before resize");
    await terminal.waitFor("before resize");
    const beforeResize = terminal.raw.length;
    terminal.resize(60, 24);
    await terminal.waitForRawChange(beforeResize);
    expect(stream.closed).toBe(false);
    expect(deployment.openLogStream).toHaveBeenCalledOnce();
    stream.emit("after resize");
    await terminal.waitFor("after resize");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    terminal.write("q");
    await menu;
  });

  it("keeps the newest log record visible after shrinking the terminal", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const stream = liveLogStream();
    deployment.openLogStream.mockResolvedValue(stream);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("LIVE LOGS");
    for (let index = 0; index < 18; index += 1) {
      stream.emit(`${String(index).padStart(2, "0")} ${"x".repeat(76)}`);
    }
    stream.emit(`newest ${"y".repeat(74)}`);
    await terminal.waitFor("newest");
    const beforeResize = terminal.raw.length;
    terminal.resize(40, 24);
    await terminal.waitForRawChange(beforeResize);
    await vi.waitFor(() =>
      expect(stripAnsi(terminal.raw.slice(-1200))).toContain(`newest\n${"y".repeat(40)}\n${"y".repeat(34)}`)
    );
    terminal.write("\u001b");
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    terminal.write("q");
    await menu;
  });

  it("ignores log navigation and follow controls while the terminal is narrow", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const stream = liveLogStream();
    deployment.openLogStream.mockResolvedValue(stream);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("LIVE LOGS");
    stream.emit("retained log output");
    await terminal.waitFor("retained log output");

    terminal.resize(36, 24);
    await terminal.waitFor("Resize terminal to at least 40");
    terminal.write("\u001b[C\u001b[A\u001b[B\u001b[F ");
    await nextInputTurn();

    expect(deployment.openLogStream).toHaveBeenCalledOnce();
    expect(stream.closed).toBe(false);
    terminal.resize(80, 24);
    await terminal.waitFor("retained log output");
    expect(deployment.openLogStream).toHaveBeenCalledOnce();
    terminal.write("\u001b");
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    terminal.write("q");
    await menu;
  });

  it("scrolls paused logs by one display row after shrinking the terminal", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const stream = liveLogStream();
    deployment.openLogStream.mockResolvedValue(stream);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("LIVE LOGS");
    const firstRow = `first-${"a".repeat(34)}`;
    const secondRow = `second-${"b".repeat(33)}`;
    stream.emit(`${firstRow}${secondRow}`);
    await terminal.waitFor("first-");
    terminal.resize(40, 5);
    await vi.waitFor(() => expect(stripAnsi(terminal.raw.slice(-400))).toContain(`${secondRow}\n`));
    terminal.write(" ");
    await nextInputTurn();
    const beforeArrow = terminal.raw.length;
    terminal.write("\u001b[A");
    await terminal.waitForRawChange(beforeArrow);
    const rendered = stripAnsi(terminal.raw.slice(-400));
    expect(rendered).toContain(`${firstRow}\n`);
    terminal.write("\u001b");
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    terminal.write("q");
    await menu;
  });

  it("keeps stream failures inside the controlled log viewer", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator();
    const stream = liveLogStream();
    deployment.openLogStream.mockResolvedValue(stream);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("LIVE LOGS");
    stream.fail(new Error(`fixture stream failed ${"x".repeat(65_536)}`));
    await terminal.waitFor("ERROR: fixture stream failed");
    expect(terminal.text).toContain("Esc close");
    expect(terminal.text).not.toContain("x".repeat(100));
    terminal.write("\u001b");
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    terminal.write("q");
    await menu;
  });

  it("marks a normally closed log stream as ended", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const stream = liveLogStream();
    deployment.openLogStream.mockResolvedValue(stream);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("LIVE LOGS");
    stream.emit("final log line");
    await terminal.waitFor("final log line");
    stream.end();
    await terminal.waitFor("ENDED");
    expect(terminal.text).not.toContain("ERROR: ");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    terminal.write("q");
    await menu;
  });

  it("changes the selected log service and reports structured diagnostic failures", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const streams = [liveLogStream(), liveLogStream(), liveLogStream()];
    deployment.openLogStream.mockImplementation(async () => streams.shift() ?? liveLogStream());
    deployment.diagnostics.mockResolvedValue({
      healthy: false,
      checks: [
        { label: "Docker", status: "ok", detail: "fixture healthy" },
        { label: "configuration", status: "failure", detail: "ownership mismatch" }
      ]
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("LIVE LOGS");
    const beforeServiceChange = terminal.raw.length;
    terminal.write("\u001b[C");
    await terminal.waitForRawChange(beforeServiceChange);
    await terminal.waitFor("LIVE LOGS");
    expect(deployment.openLogStream).toHaveBeenCalledWith("api", true);
    await nextInputTurn();
    const beforeLeft = terminal.raw.length;
    terminal.write("\u001b[D");
    await terminal.waitForRawChange(beforeLeft);
    await vi.waitFor(() => expect(deployment.openLogStream).toHaveBeenCalledTimes(3));
    expect(deployment.openLogStream).toHaveBeenLastCalledWith("api", true);
    const beforeClose = terminal.raw.length;
    terminal.write("\u001b");
    await terminal.waitForRawChange(beforeClose);
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    const beforeLogsMenu = terminal.raw.length;
    terminal.write("\u001b[B\r");
    await terminal.waitForRawChange(beforeLogsMenu);
    await terminal.waitFor("Logs and diagnostics");
    for (let index = 0; index < 5; index += 1) terminal.write("\u001b[B");
    terminal.write("\r");
    await terminal.waitFor("DIAGNOSTICS");
    expect(terminal.text).toContain("ownership mismatch");
    expect(terminal.text).toContain("Checks failed.");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(3));
    terminal.write("q");
    await menu;
  });

  it("scrolls long diagnostic failures within a 40x24 viewport", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator();
    const laterCheck = "later runtime check";
    deployment.diagnostics.mockResolvedValue({
      healthy: false,
      checks: [
        {
          label: "configuration",
          status: "failure",
          detail: Array.from({ length: 28 }, (_, index) => `failure detail line ${index + 1}`).join("\n")
        },
        { label: "runtime", status: "ok", detail: laterCheck }
      ]
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B".repeat(5));
    terminal.write("\r");
    await terminal.waitFor("DIAGNOSTICS");
    await terminal.waitFor("failure detail line 1");
    const beforeScroll = terminal.raw.length;
    terminal.write("\u001b[B".repeat(32));
    await terminal.waitForRawChange(beforeScroll);
    expect(stripAnsi(terminal.raw.slice(beforeScroll))).toContain(laterCheck);
    expect(terminal.text).toContain("Enter or Esc back");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("latches repeated diagnostics navigation before reloading the menu", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    deployment.diagnostics.mockResolvedValue({
      healthy: false,
      checks: [
        {
          label: "runtime",
          status: "failure",
          detail: Array.from({ length: 30 }, (_, index) => `diagnostic line ${index + 1}`).join("\n")
        }
      ]
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B".repeat(5));
    terminal.write("\r");
    await terminal.waitFor("DIAGNOSTICS");
    await terminal.waitFor("diagnostic line 1");
    const beforeScroll = terminal.raw.length;
    terminal.write("\u001b[B");
    await terminal.waitForRawChange(beforeScroll);
    let finishSnapshot: ((snapshot: DeploymentSnapshot) => void) | undefined;
    const pendingSnapshot = new Promise<DeploymentSnapshot>((resolve) => {
      finishSnapshot = resolve;
    });
    deployment.snapshot.mockImplementation(async () => await pendingSnapshot);

    terminal.write("\u001b");
    terminal.write("q");
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    await nextInputTurn();
    expect(deployment.snapshot).toHaveBeenCalledTimes(2);
    const beforeMenu = terminal.raw.length;
    finishSnapshot?.({ status: "ready", canReset: true, detail: "Everything is healthy." });
    await terminal.waitForRawChange(beforeMenu);
    await vi.waitFor(() => expect(stripAnsi(terminal.raw.slice(beforeMenu))).toContain("CHOOSE AN ACTION"));
    terminal.write("q");
    await menu;
  });

  it("keeps diagnostics at the top while width or height is undersized", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator();
    const firstDetail = "FIRST_MARKER";
    deployment.diagnostics.mockResolvedValue({
      healthy: false,
      checks: [
        {
          label: "configuration",
          status: "failure",
          detail: [firstDetail, ...Array.from({ length: 27 }, (_, index) => `failure detail line ${index + 2}`)].join(
            "\n"
          )
        },
        { label: "runtime", status: "ok", detail: "later runtime check" }
      ]
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View logs and diagnostics");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B".repeat(5));
    terminal.write("\r");
    await terminal.waitFor("DIAGNOSTICS");
    await terminal.waitFor(firstDetail);

    terminal.resize(36);
    await terminal.waitFor("Resize terminal to at least 40");
    terminal.write("\u001b[B".repeat(12));
    const beforeWidthRestore = terminal.raw.length;
    terminal.resize(40);
    await terminal.waitForRawChange(beforeWidthRestore);
    expect(stripAnsi(terminal.raw.slice(beforeWidthRestore))).toContain(firstDetail);

    terminal.resize(40, 4);
    await nextInputTurn();
    terminal.write("\u001b[B".repeat(12));
    const beforeHeightRestore = terminal.raw.length;
    terminal.resize(40, 24);
    await terminal.waitForRawChange(beforeHeightRestore);
    expect(stripAnsi(terminal.raw.slice(beforeHeightRestore))).toContain(firstDetail);

    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("runs initialization from the not-initialized action-list home", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator({ status: "not-initialized", detail: "Initialize Atlas Core." });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Initialize Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("Atlas Core init complete.");
    expect(deployment.runLifecycle).toHaveBeenCalledWith("init", expect.any(Function));
    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("q");
    await menu;
  });

  it("cancels reset before confirmation without calling the manager", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Reset Atlas Core");
    terminal.write("\u001b[B".repeat(7));
    terminal.write("\r");
    await terminal.waitFor("PostgreSQL and MinIO data");
    await nextInputTurn();
    terminal.write("no\r");
    await terminal.waitFor("Atlas Core reset cancelled.");
    expect(deployment.runLifecycle).not.toHaveBeenCalled();
    terminal.write("q");
    await menu;
  });

  it("confirms reset inside the TUI operation screen", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    deployment.runLifecycle.mockImplementationOnce(async (operation, report, options) => {
      expect(operation).toBe("reset");
      expect(options).toEqual({ resetConfirmed: true });
      report?.({ message: "Deleting credentials and durable data", stage: "operation" });
      return { status: "success", summary: "Atlas Core reset is complete. A new deployment is running." };
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Reset Atlas Core");
    terminal.write("\u001b[B".repeat(7));
    terminal.write("\r");
    await terminal.waitFor("Type yes to continue");
    await nextInputTurn();
    terminal.write("yes\r");
    await vi.waitFor(() =>
      expect(deployment.runLifecycle).toHaveBeenCalledWith("reset", expect.any(Function), { resetConfirmed: true })
    );
    await terminal.waitFor("Atlas Core reset is complete. A new deployment is running.");
    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("q");
    await menu;
  });

  it("does not accept reset input while the confirmation screen is too narrow", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Reset Atlas Core");
    terminal.write("\u001b[B".repeat(7));
    terminal.write("\r");
    await terminal.waitFor("Type yes to continue");
    terminal.resize(36, 24);
    await terminal.waitFor("Resize terminal to at least 40");
    terminal.write("yes\r");
    await nextInputTurn();
    const resetCallsWhileNarrow = deployment.runLifecycle.mock.calls.length;

    if (resetCallsWhileNarrow > 0) {
      terminal.write("q");
    } else {
      terminal.write("\u001b");
      await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
      terminal.resize(80, 24);
      await terminal.waitFor("CHOOSE AN ACTION");
      terminal.write("q");
    }
    await menu;

    expect(resetCallsWhileNarrow).toBe(0);
  });

  it("does not accept reset input while the confirmation screen is too short", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Reset Atlas Core");
    terminal.write("\u001b[B".repeat(7));
    terminal.write("\r");
    await terminal.waitFor("Type yes to continue");
    terminal.write("y");
    await terminal.waitFor("> y");
    terminal.resize(80, 4);
    await terminal.waitFor("Resize terminal to at least");
    terminal.write("yes\r");
    await nextInputTurn();
    expect(deployment.runLifecycle).not.toHaveBeenCalled();
    terminal.resize(80, 24);
    await vi.waitFor(() => expect(stripAnsi(terminal.raw.slice(-500))).toContain("> y"));
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("changes the admin password from the action-list home without an acknowledgement pause", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const password = "correct-horse-battery-staple";
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Change admin password");
    terminal.write("\u001b[B".repeat(6));
    terminal.write("\r");
    await terminal.waitFor("New password");
    terminal.write(password);
    await terminal.waitFor("*".repeat(password.length));
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write(password);
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\r");
    await terminal.waitFor("Atlas Core configure complete.");
    await terminal.waitFor("CHOOSE AN ACTION");

    expect(deployment.runLifecycle).toHaveBeenCalledWith("configure", expect.any(Function), { password });
    expect(terminal.text).not.toContain(password);
    expect(terminal.text).not.toContain("Press Enter to return to Atlas Core.");
    terminal.write("q");
    await menu;
  });

  it("keeps admin password cancellation inside the operation screen", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    let finishConfiguration: (() => void) | undefined;
    deployment.runLifecycle.mockImplementationOnce(
      async (_operation, report) =>
        await new Promise<LifecycleOperationResult>((resolve) => {
          report?.({ message: "Applying the new admin password", stage: "operation" });
          finishConfiguration = () =>
            resolve({
              previousDeploymentPreserved: true,
              status: "cancelled",
              summary: "Change admin password cancelled. The existing deployment state was preserved."
            });
        })
    );
    deployment.cancelPending.mockImplementation(() => finishConfiguration?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Change admin password");
    terminal.write("\u001b[B".repeat(6));
    terminal.write("\r");
    await terminal.waitFor("New password");
    terminal.write("correct-horse-battery-staple");
    await terminal.waitFor("****************************");
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write("correct-horse-battery-staple");
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\r");
    await terminal.waitFor("Applying the new admin password");
    expect(deployment.runLifecycle).toHaveBeenCalledWith("configure", expect.any(Function), {
      password: "correct-horse-battery-staple"
    });
    const beforeCancel = terminal.raw.length;
    terminal.write("\u001b");
    await terminal.waitForRawChange(beforeCancel);
    await vi.waitFor(() => expect(deployment.cancelPending).toHaveBeenCalledOnce());
    await terminal.waitFor("CHOOSE AN ACTION");

    expect(deployment.cancelPending).toHaveBeenCalledOnce();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
    terminal.write("q");
    await menu;
  });

  it("opens health from the action list and preserves it across resize", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("Network I/O");
    expect(deployment.details).toHaveBeenCalledOnce();
    terminal.write("\u001b[C");
    await terminal.waitFor("256MiB / 1GiB");
    terminal.resize(40, 24);
    await terminal.waitFor("ATLAS CORE > STATUS");
    expect(terminal.text).toContain("PostgreSQL");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it.each([
    ["stop", 2, "Stop Atlas Core"],
    ["restart", 3, "Restart Atlas Core"]
  ] as const)("runs the %s operation inside an activity screen", async (operation, moves, label) => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor(label);
    terminal.write("\u001b[B".repeat(moves));
    terminal.write("\r");
    await terminal.waitFor(`Atlas Core ${operation} complete.`);
    expect(deployment.runLifecycle).toHaveBeenCalledWith(operation, expect.any(Function));
    await terminal.waitFor("CHOOSE AN ACTION");
    expect(terminal.text).toContain(`Atlas Core ${operation} complete.`);
    terminal.write("q");
    await menu;
  });

  it("keeps a lifecycle failure visible with its recovery state", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    deployment.runLifecycle.mockResolvedValueOnce({
      status: "failure",
      error: "Docker Compose failed with exit code 1",
      snapshot: {
        status: "degraded",
        canReset: true,
        detail: "Core API is running, but storage is unavailable."
      }
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Stop Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("Docker Compose failed with exit code 1");
    expect(terminal.text).toContain("Degraded");
    expect(terminal.text).toContain("Review service health");
    expect(terminal.text).toContain("when it is safe.");
    const beforeReturn = terminal.raw.length;
    terminal.write("\r");
    await terminal.waitForRawChange(beforeReturn);
    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("q");
    await menu;
  });

  it("returns to the action-list home after Escape cancellation cleanup", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    let finish: (() => void) | undefined;
    deployment.runLifecycle.mockImplementationOnce(
      async (_operation, report) =>
        await new Promise<LifecycleOperationResult>((resolve) => {
          report?.({ message: "Stopping services", stage: "operation" });
          finish = () => {
            report?.({ message: "Safe cleanup complete.", stage: "cleanup" });
            resolve({
              previousDeploymentPreserved: true,
              status: "cancelled",
              summary: "Stop Atlas Core cancelled. The existing deployment state was preserved."
            });
          };
        })
    );
    deployment.cancelPending.mockImplementation(() => finish?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Stop Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("Stopping services");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.cancelPending).toHaveBeenCalledOnce());
    await terminal.waitFor("CHOOSE AN ACTION");
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
    terminal.write("q");
    await menu;
  });

  it("upgrades lifecycle Escape cancellation to exit before cleanup completes", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    let finish: (() => void) | undefined;
    deployment.runLifecycle.mockImplementationOnce(
      async (_operation, report) =>
        await new Promise<LifecycleOperationResult>((resolve) => {
          report?.({ message: "Stopping services", stage: "operation" });
          finish = () =>
            resolve({
              previousDeploymentPreserved: true,
              status: "cancelled",
              summary: "Stop Atlas Core cancelled."
            });
        })
    );
    deployment.cancelPending.mockImplementation(() => undefined);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);
    let resolved = false;
    const completion = menu.then(
      () => {
        resolved = true;
        return "resolved" as const;
      },
      () => "rejected" as const
    );

    await terminal.waitFor("Stop Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("Stopping services");
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.cancelPending).toHaveBeenCalledOnce());
    terminal.write("\u0003");
    await nextInputTurn();
    terminal.write("\u001b");
    await nextInputTurn();
    finish?.();
    await vi.waitFor(() => expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce());
    const outcome = await Promise.race([
      completion,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500))
    ]);
    if (outcome === "timeout") terminal.input.emit("end");
    expect(await completion).toBe("resolved");

    expect(resolved).toBe(true);
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
  });

  it("keeps a lifecycle cleanup failure visible and resumes the operator", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    let finish: (() => void) | undefined;
    deployment.runLifecycle.mockImplementationOnce(
      async (_operation, report) =>
        await new Promise<LifecycleOperationResult>((resolve) => {
          report?.({ message: "Stopping services", stage: "operation" });
          finish = () => resolve({ status: "failure", error: "Cleanup could not stop the services." });
        })
    );
    deployment.cancelPending.mockImplementation(() => finish?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Stop Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("Stopping services");
    terminal.write("\u001b");
    await terminal.waitFor("Cleanup could not stop the services.");
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
    const beforeReturn = terminal.raw.length;
    terminal.write("\r");
    await terminal.waitForRawChange(beforeReturn);
    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("q");
    await menu;
  });

  it("rejects when Ctrl-C cleanup fails during a lifecycle operation", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    let finish: (() => void) | undefined;
    deployment.runLifecycle.mockImplementationOnce(
      async (_operation, report) =>
        await new Promise<LifecycleOperationResult>((resolve) => {
          report?.({ message: "Stopping services", stage: "operation" });
          finish = () => resolve({ status: "failure", error: "Cleanup could not stop the services." });
        })
    );
    deployment.cancelPending.mockImplementation(() => finish?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Stop Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("Stopping services");
    terminal.write("\u0003");

    await expect(menu).rejects.toThrow("Cleanup could not stop the services.");
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
  });

  it("cancels and exits after Ctrl-C cleanup", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    let finish: (() => void) | undefined;
    deployment.runLifecycle.mockImplementationOnce(
      async (_operation, report) =>
        await new Promise<LifecycleOperationResult>((resolve) => {
          report?.({ message: "Stopping services", stage: "operation" });
          finish = () =>
            resolve({ previousDeploymentPreserved: true, status: "cancelled", summary: "Stop Atlas Core cancelled." });
        })
    );
    deployment.cancelPending.mockImplementation(() => finish?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Stop Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("Stopping services");
    terminal.write("\u0003");
    await expect(menu).resolves.toBeUndefined();
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
  });

  it("cancels and exits after process SIGINT cleanup", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    let finish: (() => void) | undefined;
    deployment.runLifecycle.mockImplementationOnce(
      async () =>
        await new Promise<LifecycleOperationResult>((resolve) => {
          finish = () =>
            resolve({ previousDeploymentPreserved: true, status: "cancelled", summary: "Stop Atlas Core cancelled." });
        })
    );
    deployment.cancelPending.mockImplementation(() => finish?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Stop Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("ATLAS CORE > OPERATION");
    process.emit("SIGINT", "SIGINT");
    await expect(menu).resolves.toBeUndefined();
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
  });

  it("does not abandon lifecycle cleanup when terminal input is lost", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    let finish: (() => void) | undefined;
    deployment.runLifecycle.mockImplementationOnce(
      async (_operation, report) =>
        await new Promise<LifecycleOperationResult>((resolve) => {
          report?.({ message: "Stopping services", stage: "operation" });
          finish = () =>
            resolve({ previousDeploymentPreserved: true, status: "cancelled", summary: "Stop Atlas Core cancelled." });
        })
    );
    deployment.cancelPending.mockImplementation(() => finish?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Stop Atlas Core");
    terminal.write("\u001b[B".repeat(2));
    terminal.write("\r");
    await terminal.waitFor("Stopping services");
    terminal.input.emit("end");
    await expect(menu).rejects.toThrow("lost its terminal input");
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
  });

  it("reports a Plugin rollback rejection instead of terminal loss after input ends", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let rejectEnable: ((error: Error) => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async (_pluginId, reportActivity) =>
        await new Promise<PluginOperationOutcome>((_resolve, reject) => {
          reportActivity?.({ level: "working", message: "Preparing enable", stage: "operation" });
          rejectEnable = reject;
        })
    );
    deployment.cancelPending.mockImplementation(() => rejectEnable?.(new Error("Rollback cleanup rejected")));
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Preparing enable");
    terminal.input.emit("end");

    await expect(menu).rejects.toThrow("Rollback cleanup rejected");
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
  });

  it("shows the selected split console and exits without changing anything", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Reset Atlas Core");
    expect(terminal.text).toContain("CHOOSE AN ACTION");
    expect(terminal.text).toContain("Detail");
    expect(terminal.text).toContain("Everything is healthy.");
    expect(terminal.text).toContain("Restart Atlas Core");
    terminal.write("q");
    await menu;

    expect(deployment.snapshot).toHaveBeenCalledOnce();
    expect(deployment.start).not.toHaveBeenCalled();
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("keeps the selected Plugin visible in a bounded catalog viewport", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator();
    const plugins = Array.from({ length: 30 }, (_, index) => ({
      pluginId: `plugin_${index.toString().padStart(2, "0")}`,
      displayName: `Plugin ${index + 1}`,
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    }));
    deployment.pluginStatuses.mockResolvedValue(plugins);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    for (let index = 0; index < 25; index += 1) {
      terminal.write("\u001b[B");
      await nextInputTurn();
    }

    await terminal.waitFor("↑/↓ 26/30");
    expect(stripAnsi(terminal.raw.slice(-2_000))).toContain("Plugin 26");
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("does not accept Plugin actions while the terminal is too short", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    deployment.pluginStatuses.mockResolvedValue([
      {
        pluginId: "building_scan",
        displayName: "Building Scan",
        lifecycle: "query_only",
        enabled: true,
        packaged: true
      }
    ]);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.resize(80, 23);
    await terminal.waitFor("Resize terminal to at least 24 rows");
    terminal.write("\r");
    terminal.write("l");
    await nextInputTurn();

    expect(deployment.pluginDisable).not.toHaveBeenCalled();
    expect(deployment.openPluginLogStream).not.toHaveBeenCalled();
    const beforeRestore = terminal.raw.length;
    terminal.resize(80, 24);
    await terminal.waitForRawChange(beforeRestore);
    expect(stripAnsi(terminal.raw.slice(beforeRestore))).toContain("Building Scan");
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("updates only changed terminal lines when an arrow key moves selection", async () => {
    const terminal = new TestTerminal();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(operator());

    await terminal.waitFor("View service health");
    const before = terminal.raw.length;
    terminal.write("\u001b[B");
    await terminal.waitForRawChange(before);
    const arrowFrame = terminal.raw.slice(before);

    expect(arrowFrame).not.toContain("\u001b[2J");
    expect(arrowFrame).not.toContain("\u001bc");
    terminal.write("q");
    await menu;
  });

  it("uses a compact main menu on a 40 by 24 terminal", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(
      operator({
        status: "degraded",
        detail:
          "Core API, Source Gateway, PostgreSQL, and MinIO are not reporting health. Inspect container status and logs before attempting a restart."
      })
    );

    await terminal.waitFor("Reset Atlas Core");
    expect(terminal.text).toContain("CHOOSE AN ACTION");
    expect(terminal.text).not.toContain("Filter:");
    const before = terminal.raw.length;
    terminal.write("\u001b[B");
    await terminal.waitForRawChange(before);
    terminal.write("q");
    await menu;
  });

  it("hides restart for a stopped deployment", async () => {
    const terminal = new TestTerminal();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(
      operator({ status: "stopped", detail: "Atlas Core is stopped." })
    );

    await terminal.waitFor("Reset Atlas Core");
    expect(terminal.text).toContain("Start Atlas Core");
    expect(terminal.text).not.toContain("Restart Atlas Core");
    terminal.write("q");
    await menu;
  });

  it("blocks hidden main-menu actions when even the compact menu is too tall", async () => {
    const terminal = new TestTerminal(40, true, 10);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Action list needs at least");
    terminal.write("\r");
    await nextInputTurn();
    terminal.write("q");
    await menu;

    expect(deployment.details).not.toHaveBeenCalled();
  });

  it("opens the service status view and moves between services", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("Network I/O");
    terminal.write("\u001b[C");
    await terminal.waitFor("256MiB / 1GiB");
    const beforeBack = terminal.raw.length;
    terminal.write("\r");
    await terminal.waitForRawChange(beforeBack);
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.details).toHaveBeenCalledOnce();
  });

  it("dispatches only one action when Enter repeats before the screen changes", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\u001b[13u\u001b[13u");
    await terminal.waitFor("Network I/O");
    const detailsCallsAfterRepeatedEnter = deployment.details.mock.calls.length;
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(detailsCallsAfterRepeatedEnter).toBe(1);
  });

  it("shows a scrollable status viewport on a 24-row terminal", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("↑/↓ 1-18/19");
    expect(terminal.text).not.toContain("Status needs at least");
    terminal.write("\u001b[B");
    await terminal.waitFor("↑/↓ 2-19/19");
    await terminal.waitFor("Credentials and durable volumes preserved");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.details).toHaveBeenCalledOnce();
  });

  it("keeps wrapped status values reachable through the viewport", async () => {
    const terminal = new TestTerminal(40, true, 30);
    const deployment = operator();
    const baseDetails = await deployment.details();
    const image = `ghcr.io/atlas/core@sha256:${"a".repeat(64)}`;
    deployment.details.mockClear();
    const wrappedDetails = {
      ...baseDetails,
      image,
      services: baseDetails.services.map((service) => ({ ...service, image }))
    };
    deployment.details.mockResolvedValue(wrappedDetails);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledOnce());
    await terminal.waitFor("r refresh");
    expect(terminal.text).not.toContain("Status needs at least");
    terminal.write("\u001b[B".repeat(20));
    await terminal.waitFor("↑/↓ 9-28/28");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("refreshes status automatically", async () => {
    vi.useFakeTimers();
    try {
      const terminal = new TestTerminal(80, true, 24);
      const deployment = operator();
      const baseDetails = await deployment.details();
      deployment.details.mockClear();
      deployment.details.mockResolvedValueOnce(baseDetails).mockResolvedValueOnce({
        ...baseDetails,
        services: baseDetails.services.map((service) =>
          service.id === "api" ? { ...service, cpuPercent: "9.99%" } : service
        )
      });
      const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

      await terminal.waitFor("View service health");
      terminal.write("\r");
      await terminal.waitFor("CPU          1.00%");
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(2));
      await terminal.waitFor("CPU          9.99%");
      terminal.write("\r");
      await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
      terminal.write("q");
      await menu;
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces manual status refreshes", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const baseDetails = await deployment.details();
    let finishRefresh: ((details: typeof baseDetails) => void) | undefined;
    const pendingRefresh = new Promise<typeof baseDetails>((resolve) => {
      finishRefresh = resolve;
    });
    deployment.details.mockClear();
    deployment.details.mockResolvedValueOnce(baseDetails).mockImplementationOnce(() => pendingRefresh);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("CPU          1.00%");
    terminal.write("r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(2));
    terminal.write("r");
    terminal.write("\u001b[B");
    await terminal.waitFor("↑/↓ 2-19/19");
    const callsWhileRefreshWasPending = deployment.details.mock.calls.length;
    finishRefresh?.(baseDetails);
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(callsWhileRefreshWasPending).toBe(2);
  });

  it("serializes status visits and discards a refresh from the previous visit", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const baseDetails = await deployment.details();
    let finishOldRefresh: ((details: typeof baseDetails) => void) | undefined;
    let finishNewVisit: ((details: typeof baseDetails) => void) | undefined;
    const oldRefresh = new Promise<typeof baseDetails>((resolve) => {
      finishOldRefresh = resolve;
    });
    const newVisit = new Promise<typeof baseDetails>((resolve) => {
      finishNewVisit = resolve;
    });
    const staleDetails = {
      ...baseDetails,
      services: baseDetails.services.map((service) =>
        service.id === "api" ? { ...service, cpuPercent: "7.77%" } : service
      )
    };
    const freshDetails = {
      ...baseDetails,
      services: baseDetails.services.map((service) =>
        service.id === "api" ? { ...service, cpuPercent: "9.99%" } : service
      )
    };
    deployment.details.mockClear();
    deployment.details
      .mockResolvedValueOnce(baseDetails)
      .mockImplementationOnce(() => oldRefresh)
      .mockImplementationOnce(() => newVisit);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("CPU          1.00%");
    terminal.write("r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(2));
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    const beforeReopen = terminal.raw.length;
    terminal.write("\r");
    await vi.waitFor(() =>
      expect(stripAnsi(terminal.raw.slice(beforeReopen))).toContain("Loading deployment and Docker statistics...")
    );
    expect(deployment.details).toHaveBeenCalledTimes(2);

    finishOldRefresh?.(staleDetails);
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(3));
    finishNewVisit?.(freshDetails);
    await terminal.waitFor("CPU          9.99%");
    expect(terminal.text).not.toContain("CPU          7.77%");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(3));
    terminal.write("q");
    await menu;
  });

  it("aborts an abandoned refresh before starting a later status visit", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const baseDetails = await deployment.details();
    let abandonedSignal: AbortSignal | undefined;
    deployment.details.mockClear();
    deployment.details
      .mockResolvedValueOnce(baseDetails)
      .mockImplementationOnce(
        async (signal?: AbortSignal) =>
          await new Promise<never>((_resolve, reject) => {
            abandonedSignal = signal;
            signal?.addEventListener("abort", () => reject(new Error("Status refresh was cancelled.")), {
              once: true
            });
          })
      )
      .mockResolvedValueOnce(baseDetails);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("CPU          1.00%");
    terminal.write("r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(2));
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(3));
    expect(abandonedSignal?.aborted).toBe(true);
    await terminal.waitFor("CPU          1.00%");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(3));
    terminal.write("q");
    await menu;
  });

  it.each([40, 80])("keeps a long status error scrollable at %i columns", async (columns) => {
    const terminal = new TestTerminal(columns, true, 24);
    const deployment = operator();
    deployment.details.mockRejectedValueOnce(new Error(`Docker failed: ${"detail ".repeat(400)}END`));
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("r retry");
    expect(terminal.text).not.toContain("END");
    terminal.write("\u001b[B".repeat(100));
    await terminal.waitFor("END");
    await terminal.waitFor("r retry");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("keeps the clamped status scroll position when content expands again", async () => {
    const terminal = new TestTerminal(80, true, 24);
    const deployment = operator();
    const fullDetails = await deployment.details();
    const shortDetails = { ...fullDetails, services: [] };
    deployment.details.mockClear();
    deployment.details
      .mockResolvedValueOnce(fullDetails)
      .mockResolvedValueOnce(shortDetails)
      .mockResolvedValueOnce(fullDetails);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("↑/↓ 1-18/19");
    terminal.write("\u001b[B");
    await terminal.waitFor("↑/↓ 2-19/19");
    terminal.write("r");
    await terminal.waitFor("No Atlas Core containers are running.");
    await nextInputTurn();
    const beforeExpansion = terminal.raw.length;
    terminal.write("r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(3));
    await terminal.waitForRawChange(beforeExpansion);
    await vi.waitFor(() => expect(stripAnsi(terminal.raw.slice(beforeExpansion))).toContain("↑/↓ 1-18/19"));
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("allows toggling an installed independent Plugin without a packaged image", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: false,
      installed: true,
      selectedVersion: "1.0.0"
    };
    deployment.pluginStatuses
      .mockResolvedValueOnce([plugin])
      .mockResolvedValueOnce([{ ...plugin, enabled: true, state: "running", health: "healthy" }]);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    expect(terminal.text).not.toContain("image unavailable");
    terminal.write("\r");
    await terminal.waitFor("Enable requested");
    await terminal.waitFor("Enter return to Plugins");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.pluginEnable).toHaveBeenCalledWith(plugin.pluginId, expect.any(Function));
  });

  it("installs a catalog-only Plugin from the selected row", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: false,
      installed: false,
      availableVersions: ["1.2.0", "1.1.0"]
    };
    deployment.pluginStatuses
      .mockResolvedValueOnce([plugin])
      .mockResolvedValueOnce([{ ...plugin, installed: true, selectedVersion: "1.2.0" }]);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await openPluginManagement(terminal);
    expect(terminal.text).toContain("not installed");
    expect(terminal.text).not.toContain("u update");
    terminal.write("\r");
    await terminal.waitFor("Install requested");
    await terminal.waitFor("Enter return to Plugins");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.pluginInstall).toHaveBeenCalledWith(plugin.pluginId, undefined, expect.any(Function));
  });

  it("reviews and confirms an available Plugin update inside Atlas Core", async () => {
    const terminal = new TestTerminal();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: true,
      packaged: false,
      installed: true,
      selectedVersion: "1.0.0"
    };
    const deployment = Object.assign(operator(), {
      pluginUpdatePlan: vi.fn(async () => ({
        status: "available" as const,
        action: "update" as const,
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        enabled: true,
        restartServices: ["Core API", "Source Gateway", "Building Scan"],
        coreVersion: "0.2.1",
        coreImage: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
      })),
      pluginUpdate: vi.fn(async (_pluginId: string, reportActivity?: PluginActivityReporter) => {
        reportActivity?.({ level: "working", message: "Installing Building Scan 1.1.0", stage: "operation" });
        reportActivity?.({ level: "success", message: "Building Scan updated to 1.1.0", stage: "operation" });
        return { status: "success" as const };
      })
    });
    deployment.pluginStatuses
      .mockResolvedValueOnce([plugin])
      .mockResolvedValueOnce([plugin])
      .mockResolvedValueOnce([{ ...plugin, selectedVersion: "1.1.0" }]);
    const coreBefore = {
      ...(await deployment.details()),
      image: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
    };
    deployment.details.mockResolvedValue(coreBefore);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await openPluginManagement(terminal);
    await terminal.waitFor("Catalog   1.1.0 compatible update");
    expect(terminal.text).toContain("Selected  1.0.0");
    terminal.write("u");
    await terminal.waitFor("REVIEW PLUGIN UPDATE");
    expect(terminal.text).toContain("Current      1.0.0");
    expect(terminal.text).toContain("Target       1.1.0");
    expect(terminal.text).toContain("State        Enabled");
    expect(terminal.text).toContain("Core         0.2.1 remains installed");
    expect(terminal.text).toContain("May restart  Core API, Source Gateway, Building Scan");
    expect(deployment.pluginUpdate).not.toHaveBeenCalled();

    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    await nextInputTurn();
    expect(deployment.pluginUpdate).not.toHaveBeenCalled();
    await terminal.waitFor("Selected  1.0.0");
    terminal.write("u");
    await vi.waitFor(() => expect(deployment.pluginUpdatePlan).toHaveBeenCalledTimes(2));
    await nextInputTurn();

    terminal.write("\r");
    await terminal.waitFor("Installing Building Scan 1.1.0");
    await terminal.waitFor("Building Scan updated to 1.1.0.");
    expect(deployment.pluginUpdate).toHaveBeenCalledWith(
      plugin.pluginId,
      expect.any(Function),
      expect.objectContaining({ currentVersion: "1.0.0", targetVersion: "1.1.0" })
    );
    expect(await deployment.details()).toMatchObject({ coreVersion: coreBefore.coreVersion, image: coreBefore.image });
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(3));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it.each([
    ["current", "Building Scan 1.0.0 is current."],
    ["blocked", "A newer release exists, but it is incompatible with Atlas Core 0.2.1."],
    ["blocked", "The Plugin catalog is expired; refresh it before updating."]
  ] as const)("explains a %s Plugin update plan without offering confirmation", async (status, reason) => {
    const terminal = new TestTerminal();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: false,
      installed: true,
      selectedVersion: "1.0.0"
    };
    const deployment = Object.assign(operator(), {
      pluginUpdatePlan: vi.fn(async () => ({
        status,
        reason,
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        currentVersion: "1.0.0",
        enabled: false,
        restartServices: [],
        coreVersion: "0.2.1",
        coreImage: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
      })),
      pluginUpdate: vi.fn(async () => ({ status: "success" as const }))
    });
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    const coreBefore = {
      ...(await deployment.details()),
      image: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
    };
    deployment.details.mockResolvedValue(coreBefore);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await openPluginManagement(terminal);
    await terminal.waitFor("Selected  1.0.0");
    terminal.write("u");
    await terminal.waitFor(reason);
    expect(terminal.text).toContain("Esc return to Plugins");
    terminal.write("\r");
    await nextInputTurn();
    expect(deployment.pluginUpdate).not.toHaveBeenCalled();
    expect(await deployment.details()).toMatchObject({ coreVersion: coreBefore.coreVersion, image: coreBefore.image });
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("labels a lower revoked-release remediation as a replacement without restart impact", async () => {
    const terminal = new TestTerminal();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: false,
      installed: true,
      selectedVersion: "2.0.0",
      revoked: true
    };
    const deployment = Object.assign(operator(), {
      pluginUpdatePlan: vi.fn(async () => ({
        status: "available" as const,
        action: "replacement" as const,
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        currentVersion: "2.0.0",
        targetVersion: "1.9.0",
        enabled: false,
        restartServices: [],
        coreVersion: "0.2.1",
        coreImage: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
      })),
      pluginUpdate: vi.fn(async () => ({ status: "success" as const }))
    });
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    const coreBefore = {
      ...(await deployment.details()),
      image: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
    };
    deployment.details.mockResolvedValue(coreBefore);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await openPluginManagement(terminal);
    await terminal.waitFor("Selected  2.0.0");
    terminal.write("u");
    await terminal.waitFor("REVIEW PLUGIN REPLACEMENT");
    expect(terminal.text).toContain("Target       1.9.0");
    expect(terminal.text).toContain("State        Disabled");
    expect(terminal.text).toContain("No running Atlas services");
    expect(terminal.text).toContain("permitted replacement");
    terminal.write("\r");
    await terminal.waitFor("Building Scan replaced with 1.9.0.");
    expect(deployment.pluginUpdate).toHaveBeenCalledWith(
      plugin.pluginId,
      expect.any(Function),
      expect.objectContaining({ action: "replacement", currentVersion: "2.0.0", targetVersion: "1.9.0" })
    );
    expect(await deployment.details()).toMatchObject({ coreVersion: coreBefore.coreVersion, image: coreBefore.image });
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it.each([
    {
      name: "candidate failure with restoration",
      error: "candidate health check failed",
      rollbackLevel: "success" as const,
      rollbackMessage: "The previous Plugin release is restored",
      expected: "Update failed: candidate health check failed"
    },
    {
      name: "recovery-required failure",
      error: "candidate health check failed. Recovery is required: restored Core did not become healthy",
      rollbackLevel: "failure" as const,
      rollbackMessage: "Recovery is required. Run atlas-core recover status for the valid next action",
      expected: "Run atlas-core recover status"
    }
  ])(
    "keeps $name and resulting state inside Atlas Core",
    async ({ error, expected, rollbackLevel, rollbackMessage }) => {
      const terminal = new TestTerminal();
      const plugin = {
        pluginId: "building_scan",
        displayName: "Building Scan",
        lifecycle: "query_only" as const,
        enabled: true,
        packaged: false,
        installed: true,
        selectedVersion: "1.0.0"
      };
      const deployment = Object.assign(operator(), {
        pluginUpdatePlan: vi.fn(async () => ({
          status: "available" as const,
          action: "update" as const,
          pluginId: plugin.pluginId,
          displayName: plugin.displayName,
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          enabled: true,
          restartServices: ["Core API", "Source Gateway", "Building Scan"],
          coreVersion: "0.2.1",
          coreImage: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
        })),
        pluginUpdate: vi.fn(async (_pluginId: string, reportActivity?: PluginActivityReporter) => {
          reportActivity?.({ level: "failure", message: `Update stopped: ${error}`, stage: "operation" });
          reportActivity?.({ level: rollbackLevel, message: rollbackMessage, stage: "rollback" });
          throw new Error(error);
        })
      });
      deployment.pluginStatuses.mockResolvedValue([plugin]);
      const before = {
        ...(await deployment.details()),
        image: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
      };
      deployment.details.mockClear();
      deployment.details.mockResolvedValue(before);
      const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

      await openPluginManagement(terminal);
      await terminal.waitFor("Selected  1.0.0");
      terminal.write("u");
      await terminal.waitFor("REVIEW PLUGIN UPDATE");
      terminal.write("\r");
      await terminal.waitFor(expected);
      expect(await deployment.details()).toMatchObject({ coreVersion: before.coreVersion, image: before.image });
      terminal.write("\r");
      await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
      terminal.write("q");
      await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(3));
      terminal.write("q");
      await menu;
    }
  );

  it("cancels a Plugin update only after the previous release is restored", async () => {
    const terminal = new TestTerminal();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: true,
      packaged: false,
      installed: true,
      selectedVersion: "1.0.0"
    };
    let finishCancellation: (() => void) | undefined;
    const deployment = Object.assign(operator(), {
      pluginUpdatePlan: vi.fn(async () => ({
        status: "available" as const,
        action: "update" as const,
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        enabled: true,
        restartServices: ["Core API", "Source Gateway", "Building Scan"],
        coreVersion: "0.2.1",
        coreImage: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
      })),
      pluginUpdate: vi.fn(
        async (_pluginId: string, reportActivity?: PluginActivityReporter) =>
          await new Promise<PluginOperationOutcome>((resolve) => {
            reportActivity?.({ level: "working", message: "Installing Building Scan 1.1.0", stage: "operation" });
            finishCancellation = () => {
              reportActivity?.({ level: "failure", message: "Update cancelled", stage: "operation" });
              reportActivity?.({ level: "working", message: "Restoring previous Plugin release", stage: "rollback" });
              reportActivity?.({ level: "success", message: "Previous Plugin release restored", stage: "rollback" });
              resolve({ previousDeploymentPreserved: true, status: "cancelled" });
            };
          })
      )
    });
    deployment.cancelPending.mockImplementation(() => finishCancellation?.());
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    const coreBefore = {
      ...(await deployment.details()),
      image: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
    };
    deployment.details.mockResolvedValue(coreBefore);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await openPluginManagement(terminal);
    await terminal.waitFor("Selected  1.0.0");
    terminal.write("u");
    await terminal.waitFor("REVIEW PLUGIN UPDATE");
    terminal.write("\r");
    await terminal.waitFor("Installing Building Scan 1.1.0");
    terminal.write("\u001b");
    await terminal.waitFor("Previous Plugin release restored");
    await terminal.waitFor("PLUGIN CATALOG");
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
    expect(await deployment.details()).toMatchObject({ coreVersion: coreBefore.coreVersion, image: coreBefore.image });
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("shows an installed Plugin status error in the details", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.pluginStatuses.mockResolvedValue([
      {
        pluginId: "building_scan",
        displayName: "Building Scan",
        lifecycle: "query_only",
        enabled: false,
        packaged: false,
        installed: true,
        selectedVersion: "1.0.0",
        error: "Plugin catalog expired; refresh before installing, enabling, or updating Plugins."
      }
    ]);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("ERROR: Plugin catalog expired; refresh before installing, enabling, or updating Plugins.");
    expect(terminal.text).toContain("ERROR");
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("shows the selected Plugin revocation reason", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.pluginStatuses.mockResolvedValue([
      {
        pluginId: "building_scan",
        displayName: "Building Scan",
        lifecycle: "query_only",
        enabled: false,
        packaged: false,
        installed: true,
        selectedVersion: "1.0.0",
        revoked: true,
        revocationReason: "security issue"
      }
    ]);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("REVOKED: security issue");
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("keeps Plugin enable progress and completion inside Atlas Core", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let finishEnable: (() => void) | undefined;
    deployment.pluginStatuses
      .mockResolvedValueOnce([plugin])
      .mockResolvedValueOnce([{ ...plugin, enabled: true, state: "running", health: "healthy" }]);
    deployment.pluginEnable.mockImplementation(
      async (_pluginId, reportActivity) =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          reportActivity?.({ level: "working", message: "Pulling Building Scan image", stage: "operation" });
          finishEnable = () => {
            reportActivity?.({ level: "success", message: "Plugin image ready", stage: "operation" });
            reportActivity?.({ level: "success", message: "Building Scan enabled and healthy", stage: "operation" });
            resolve({ status: "success" });
          };
        })
    );
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("ATLAS CORE > ACTIVITY");
    await terminal.waitFor("Pulling Building Scan");
    expect(terminal.text).not.toContain("Press Enter to return to Atlas Core.");
    finishEnable?.();
    await terminal.waitFor("Building Scan enabled.");
    await terminal.waitFor("Enter return to Plugins");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.pluginEnable).toHaveBeenCalledWith(plugin.pluginId, expect.any(Function));
    expect(deployment.resumeAfterCancellation).not.toHaveBeenCalled();
  });

  it("shows Plugin enable failure and completed rollback inside Atlas Core", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(async (_pluginId, reportActivity) => {
      reportActivity?.({
        level: "failure",
        message: "Enable stopped: health wait timed out",
        stage: "operation"
      });
      reportActivity?.({ level: "working", message: "Restoring previous deployment", stage: "rollback" });
      reportActivity?.({ level: "success", message: "Previous deployment restored", stage: "rollback" });
      throw new Error("health wait timed out");
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Previous deployment restored");
    await terminal.waitFor("Enable failed: health wait timed out");
    await terminal.waitFor("Enter return to Plugins");
    await nextInputTurn();
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(3));
    terminal.write("q");
    await menu;
  });

  it("treats Ctrl-C as back after the plugin operation settles", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let finishEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async () =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          finishEnable = () => resolve({ status: "success" });
        })
    );
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Enable requested");
    finishEnable?.();
    await terminal.waitFor("Building Scan enabled.");
    terminal.write("\u0003");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    expect(deployment.cancelPending).not.toHaveBeenCalled();
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("shows Plugin success in a four-row terminal and status in a two-row terminal", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let finishEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async () =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          finishEnable = () => resolve({ status: "success" });
        })
    );
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("ATLAS CORE > ACTIVITY");
    terminal.resize(40, 4);
    finishEnable?.();
    await terminal.waitFor("Building Scan enabled.");
    terminal.resize(40, 2);
    await terminal.waitFor("ACTIVITY SUCCESS");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("shows the Plugin failure reason and recovery state", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let failEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async () =>
        await new Promise<PluginOperationOutcome>((_resolve, reject) => {
          failEnable = () => reject(new Error("health wait timed out"));
        })
    );
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(4));
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("ATLAS CORE > ACTIVITY");
    failEnable?.();
    await terminal.waitFor("Enable failed: health wait timed out");
    await terminal.waitFor("Deployment state: Running");
    await terminal.waitFor("Review Plugin");
    expect(terminal.text.replace(/\s+/gu, " ")).toContain(
      "Review Plugin status or run atlas-core recover status before retrying."
    );
    await terminal.waitFor("Enter return to Plugins");
    await nextInputTurn();
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(3));
    terminal.write("q");
    await menu;
  });

  it("keeps a stopped deployment stopped after a Plugin failure", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator({ status: "stopped", detail: "Atlas Core is stopped." });
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockRejectedValue(new Error("fixture Plugin failure"));
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Manage Plugins");
    terminal.write("\u001b[B".repeat(3));
    await nextInputTurn();
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Enable failed: fixture Plugin failure");
    expect(terminal.text).toContain("while Atlas Core remains stopped");
    expect(terminal.text).not.toContain("Choose Start Atlas Core");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(3));
    terminal.write("q");
    await menu;
  });

  it("renders an intentional narrow-terminal state", async () => {
    const terminal = new TestTerminal(36);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Resize to at least 40 columns.");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledOnce());
    await nextInputTurn();
    terminal.write("q");
    await menu;
  });

  it("blocks a hidden Core update confirmation after the terminal becomes narrow", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI + Atlas Core");
    terminal.write("\u001b[B");
    await terminal.waitFor("return Atlas Core to its prior");
    expect(terminal.text).toContain("running or stopped state on the reviewed image.");
    terminal.write("\r");
    await terminal.waitFor(
      "PostgreSQL, MinIO, credentials, and configuration are preserved. Atlas Core returns to its prior"
    );
    expect(terminal.text).toContain("running or stopped state after the image pull.");
    terminal.resize(36);
    await terminal.waitFor("Resize to at least 40 columns.");
    terminal.write("\r");
    await nextInputTurn();
    const updateCallsAfterHiddenEnter = deployment.update.mock.calls.length;
    if (updateCallsAfterHiddenEnter > 0) {
      await terminal.waitFor("Press Enter to exit.");
      terminal.write("\r");
    } else {
      terminal.write("\u001b");
      await nextInputTurn();
      terminal.write("q");
    }
    await update;

    expect(updateCallsAfterHiddenEnter).toBe(0);
  });

  it("blocks a hidden Plugin update confirmation after the terminal becomes narrow", async () => {
    const terminal = new TestTerminal();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: true,
      packaged: false,
      installed: true,
      selectedVersion: "1.0.0"
    };
    const deployment = Object.assign(operator(), {
      pluginUpdatePlan: vi.fn(async () => ({
        status: "available" as const,
        action: "update" as const,
        pluginId: plugin.pluginId,
        displayName: plugin.displayName,
        currentVersion: "1.0.0",
        targetVersion: "1.1.0",
        enabled: true,
        restartServices: [],
        coreVersion: "0.2.1",
        coreImage: "ghcr.io/the-drunken-coder/atlas-core@sha256:current-core"
      })),
      pluginUpdate: vi.fn(async () => ({ status: "success" as const }))
    });
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await openPluginManagement(terminal);
    terminal.write("u");
    await terminal.waitFor("REVIEW PLUGIN UPDATE");
    terminal.resize(36);
    await terminal.waitFor("Resize to at least 40 columns.");
    terminal.write("\r");
    await nextInputTurn();
    expect(deployment.pluginUpdate).not.toHaveBeenCalled();

    terminal.resize(100, 5);
    await terminal.waitFor("Update review needs at least");
    terminal.write("\r");
    await nextInputTurn();
    expect(deployment.pluginUpdate).not.toHaveBeenCalled();

    terminal.write("\u001b");
    terminal.resize(100, 40);
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("blocks a Core update confirmation when the review is too tall", async () => {
    const terminal = new TestTerminal(40, true, 10);
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI + Atlas Core");
    terminal.write("\u001b[B");
    await terminal.waitFor("Preserve credentials and durable data");
    terminal.write("\r");
    terminal.resize(40, 5);
    await terminal.waitFor("Update review needs at least");
    terminal.write("\r");
    await nextInputTurn();
    const updateCallsAfterHiddenEnter = deployment.update.mock.calls.length;
    terminal.write("\u001b");
    await nextInputTurn();
    terminal.write("q");
    await update;

    expect(updateCallsAfterHiddenEnter).toBe(0);
  });

  it("counts the wrapped run-intent copy in the Core update review height", async () => {
    const terminal = new TestTerminal(40, true, 10);
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI + Atlas Core");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Update review needs at least 11 rows at");
    expect(terminal.text).toContain("this width.");
    terminal.write("\r");
    await nextInputTurn();
    const updateCallsAfterHiddenEnter = deployment.update.mock.calls.length;
    terminal.write("\u001b");
    await nextInputTurn();
    terminal.write("q");
    await update;

    expect(updateCallsAfterHiddenEnter).toBe(0);
  });

  it("opens the admin account from the Configure submenu", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Change admin password");
    terminal.write("\u001b[B".repeat(6));
    terminal.write("\r");
    await terminal.waitFor("New password");
    const beforeCancel = terminal.raw.length;
    terminal.write("\u001b");
    await terminal.waitForRawChange(beforeCancel);
    await nextInputTurn();
    terminal.write("\u001b");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.runLifecycle).not.toHaveBeenCalled();
  });

  it("masks the admin password and never writes its value", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const password = "correct-horse-battery-staple";
    const configuration = createInteractiveCLI(terminal.input, terminal.output).configureAdmin(deployment);

    await terminal.waitFor("New password");
    terminal.write(password);
    await terminal.waitFor("*".repeat(password.length));
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write(password);
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\r");
    await terminal.waitFor("Atlas Core configure complete.");
    await configuration;

    expect(deployment.runLifecycle).toHaveBeenCalledWith("configure", expect.any(Function), { password });
    expect(terminal.text).not.toContain(password);
    expect(terminal.text).not.toContain("Press Enter to return to Atlas Core.");
  });

  it("retains a direct configuration failure when the user retries then cancels", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.runLifecycle.mockResolvedValueOnce({ status: "failure", error: "Password update failed." });
    const configuration = createInteractiveCLI(terminal.input, terminal.output).configureAdmin(deployment);

    await terminal.waitFor("New password");
    terminal.write("x");
    await terminal.waitFor("*");
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write("x");
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\r");
    await terminal.waitFor("Password update failed.");
    await terminal.waitFor("Enter return to Atlas Core");
    await nextInputTurn();
    terminal.write("\r");
    await terminal.waitFor("New password");
    await nextInputTurn();
    terminal.write("\u001b");

    await expect(configuration).rejects.toThrow("Password update failed.");
  });

  it("does not tell a stopped deployment to start after an admin password failure", async () => {
    const terminal = new TestTerminal();
    const deployment = operator({ status: "stopped", detail: "Atlas Core is stopped." });
    deployment.runLifecycle.mockResolvedValueOnce({
      status: "failure",
      error: "Password update failed.",
      snapshot: {
        status: "stopped",
        canReset: true,
        detail: "Atlas Core is stopped. Durable storage is preserved."
      }
    });
    const configuration = createInteractiveCLI(terminal.input, terminal.output).configureAdmin(deployment);

    await terminal.waitFor("New password");
    terminal.write("x");
    await terminal.waitFor("*");
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write("x");
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\r");
    await terminal.waitFor("Password update failed.");
    expect(terminal.text).toContain("admin password change");
    expect(terminal.text).toContain("while Atlas Core is stopped");
    expect(terminal.text).not.toContain("Choose Start Atlas Core");
    const beforeReturn = terminal.raw.length;
    terminal.write("\u001b");
    await terminal.waitForRawChange(beforeReturn);
    await nextInputTurn();
    terminal.write("\u001b");

    await expect(configuration).rejects.toThrow("Password update failed.");
  });

  it("captures password text submitted in the same input chunk", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const password = "correct-horse-battery-staple";
    const configuration = createInteractiveCLI(terminal.input, terminal.output).configureAdmin(deployment);

    await terminal.waitFor("New password");
    terminal.write(`${password}\u001b[13u`);
    await terminal.waitFor("Confirm password");
    terminal.write(`${password}\u001b[13u`);
    await terminal.waitFor("Atlas Core configure complete.");
    await configuration;

    expect(deployment.runLifecycle).toHaveBeenCalledWith("configure", expect.any(Function), { password });
  });

  it("submits the admin password once when confirmation Enter repeats", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const password = "correct-horse-battery-staple";
    let finishConfiguration: (() => void) | undefined;
    const pendingConfiguration = new Promise<LifecycleOperationResult>((resolve) => {
      finishConfiguration = () => resolve({ status: "success", summary: "Atlas Core configure complete." });
    });
    deployment.runLifecycle.mockImplementation(async () => pendingConfiguration);
    const configuration = createInteractiveCLI(terminal.input, terminal.output).configureAdmin(deployment);

    await terminal.waitFor("New password");
    terminal.write(password);
    await terminal.waitFor("*".repeat(password.length));
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write(password);
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\u001b[13u\u001b[13u");
    await vi.waitFor(() => expect(deployment.runLifecycle).toHaveBeenCalled());
    await nextInputTurn();
    const configurationCallsAfterRepeatedEnter = deployment.runLifecycle.mock.calls.length;
    finishConfiguration?.();
    await configuration;

    expect(configurationCallsAfterRepeatedEnter).toBe(1);
  });

  it("accepts a pasted admin password", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const password = "correct-horse-battery-staple";
    const configuration = createInteractiveCLI(terminal.input, terminal.output).configureAdmin(deployment);

    await terminal.waitFor("New password");
    terminal.write(`\u001b[200~${password}\u001b[201~`);
    await terminal.waitFor("*".repeat(password.length));
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write(`\u001b[200~${password}\u001b[201~`);
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\r");
    await terminal.waitFor("Atlas Core configure complete.");
    await configuration;

    expect(deployment.runLifecycle).toHaveBeenCalledWith("configure", expect.any(Function), { password });
    expect(terminal.text).not.toContain(password);
    expect(terminal.text).not.toContain("Press Enter to return to Atlas Core.");
  });

  it("keeps mismatched password confirmation inside the form", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const configuration = createInteractiveCLI(terminal.input, terminal.output).configureAdmin(deployment);

    await terminal.waitFor("New password");
    terminal.write("correct-horse-battery-staple");
    await terminal.waitFor("****************************");
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write("different-admin-password");
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\r");
    await terminal.waitFor("Passwords did not match");
    terminal.write("\u001b");
    await configuration;

    expect(deployment.runLifecycle).not.toHaveBeenCalled();
  });

  it("does not insert Ctrl-letter input into an admin password", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const configuration = createInteractiveCLI(terminal.input, terminal.output).configureAdmin(deployment);

    await terminal.waitFor("New password");
    terminal.write("\u0001");
    await nextInputTurn();
    terminal.write("x");
    await terminal.waitFor("*");
    terminal.write("\r");
    await terminal.waitFor("Confirm password");
    const beforeConfirmation = terminal.raw.length;
    terminal.write("x");
    await terminal.waitForRawChange(beforeConfirmation);
    terminal.write("\r");
    await terminal.waitFor("Atlas Core configure complete.");
    await configuration;

    expect(deployment.runLifecycle).toHaveBeenCalledWith("configure", expect.any(Function), { password: "x" });
  });

  it("does not treat Ctrl-D as the diagnostics shortcut", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View service health");
    terminal.write("\r");
    await terminal.waitFor("Network I/O");
    terminal.write("\u0004");
    await nextInputTurn();
    const doctorCallsAfterCtrlD = deployment.doctor.mock.calls.length;
    if (doctorCallsAfterCtrlD > 0) {
      await terminal.waitFor("Press Enter to return to Atlas Core.");
      terminal.write("\r");
      await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(2));
    }
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(doctorCallsAfterCtrlD).toBe(0);
  });

  it("applies the reviewed CLI and Core update and exits", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI + Atlas Core");
    terminal.write("\u001b[B");
    await terminal.waitFor("Preserve credentials and durable data");
    terminal.write("\r");
    await terminal.waitFor("PostgreSQL, MinIO, credentials, and configuration are preserved");
    terminal.write("\r");
    await terminal.waitFor("Update complete");
    terminal.write("\r");
    await update;

    expect(deployment.update).toHaveBeenCalledWith("all", "0.1.6");
  });

  it("exits after a CLI update selected from the action-list home", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Update Atlas Core");
    terminal.write("\u001b[B".repeat(5));
    terminal.write("\r");
    await terminal.waitFor("Update CLI only");
    terminal.write("\r");
    await terminal.waitFor("The current process exits after npm installs the CLI.");
    terminal.write("\r");
    await terminal.waitFor("Update complete");

    await expect(menu).resolves.toBeUndefined();
    expect(deployment.update).toHaveBeenCalledWith("cli", "0.1.6");
  });

  it("keeps CLI-only subprocess output inside the mounted update screen", async () => {
    const terminal = new TestTerminal();
    const progressUpdate = vi.fn(
      async (
        _scope: "cli" | "all",
        _version: string | undefined,
        report?: (progress: { message: string; stage: "operation" | "cleanup" }) => void
      ) => {
        report?.({ message: "npm install started", stage: "operation" });
        report?.({ message: "npm install completed", stage: "operation" });
      }
    );
    const deployment = Object.assign(operator(), { updateWithProgress: progressUpdate });
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI only");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("npm install completed");
    expect(progressUpdate).toHaveBeenCalledWith("cli", "0.1.6", expect.any(Function));
    expect(terminal.text).not.toContain("Press Enter to exit.");
    terminal.write("\r");
    await update;
  });

  it("dispatches only one reviewed update when Enter repeats before the screen changes", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    let finishUpdate: (() => void) | undefined;
    const pendingUpdate = new Promise<undefined>((resolve) => {
      finishUpdate = () => resolve(undefined);
    });
    deployment.update.mockImplementation(() => pendingUpdate);
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI only");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\u001b[13u\u001b[13u");
    await vi.waitFor(() => expect(deployment.update).toHaveBeenCalled());
    await nextInputTurn();
    const updateCallsAfterRepeatedEnter = deployment.update.mock.calls.length;
    finishUpdate?.();
    await update;

    expect(updateCallsAfterRepeatedEnter).toBe(1);
  });

  it("labels and applies a Core-only update without claiming the CLI will change", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.4",
      latestVersion: "0.1.5",
      cliUpdateAvailable: false,
      coreUpdateAvailable: true
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update Atlas Core");
    expect(terminal.text).not.toContain("install the latest CLI");
    terminal.write("\r");
    await terminal.waitFor("CLI stays at 0.1.5.");
    terminal.write("\r");
    await terminal.waitFor("Core-only update requested");
    expect(terminal.text).not.toContain("CLI + Core update");
    expect(terminal.text).not.toContain("CLI and Core update requested");
    await terminal.waitFor("Update complete");
    expect(terminal.text).not.toContain("Atlas Core CLI 0.1.5 and the Core deployment");
    expect(terminal.text).toContain("Enter exit");
    terminal.write("\r");
    await update;

    expect(deployment.update).toHaveBeenCalledWith("all", "0.1.5");
  });

  it("returns to the main menu after a Core-only update", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.4",
      latestVersion: "0.1.5",
      cliUpdateAvailable: false,
      coreUpdateAvailable: true
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("\u001b[B".repeat(5));
    await nextInputTurn();
    terminal.write("\r");
    await terminal.waitFor("CHOOSE UPDATE");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("Update complete");
    expect(terminal.text).toContain("Enter return to Atlas Core");
    expect(terminal.text).not.toContain("Enter exit");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    await terminal.waitFor("CHOOSE AN ACTION");
    terminal.write("q");
    await menu;
  });

  it("bounds captured update progress", async () => {
    const terminal = new TestTerminal(500, true, 40);
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.4",
      latestVersion: "0.1.5",
      cliUpdateAvailable: false,
      coreUpdateAvailable: true
    });
    deployment.updateWithProgress.mockImplementation(async (_scope, _version, report) => {
      for (let index = 0; index < 250; index += 1) {
        report?.({ message: `progress-${index.toString().padStart(3, "0")}`, stage: "operation" });
      }
      report?.({ message: `oversized ${"x".repeat(2_100)}`, stage: "operation" });
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update Atlas Core");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("Update complete");
    expect(terminal.text).toContain("progress-249");
    expect(terminal.text).toContain("[truncated]");
    expect(stripAnsi(terminal.raw.slice(-12_000))).not.toContain("progress-000");
    terminal.write("\r");
    await update;
  });

  it("propagates an update failure after showing the recovery message", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    deployment.update.mockRejectedValue(new Error("npm install failed"));
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI only");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("The update stopped without deleting Atlas Core data");
    expect(terminal.text).toContain("Resolve the CLI");
    expect(terminal.text).toContain("package or supervision error");
    expect(terminal.text).not.toContain("inspect recovery status");
    terminal.write("\r");

    await expect(update).rejects.toThrow("npm install failed");
  });

  it("describes Core recovery without claiming a Core-only failure changed the CLI", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.4",
      latestVersion: "0.1.5",
      cliUpdateAvailable: false,
      coreUpdateAvailable: true
    });
    deployment.update.mockRejectedValue(new Error("compose up failed"));
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update Atlas Core");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("The update stopped without deleting Atlas Core data");
    expect(terminal.text).toContain("Inspect Core recovery");
    expect(terminal.text).not.toContain("CLI installation may have completed");
    terminal.write("\r");

    await expect(update).rejects.toThrow("compose up failed");
  });

  it("gives CLI recovery guidance when a combined update fails before Core handoff", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    deployment.updateWithProgress.mockImplementation(async (_scope, _version, report) => {
      report?.({ message: "Installing Atlas Core CLI 0.1.6...", stage: "operation" });
      throw new Error("npm install failed");
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI + Atlas Core");
    terminal.write("\u001b[B");
    await terminal.waitFor("Preserve credentials and durable data");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("The update stopped without deleting Atlas Core data");
    expect(terminal.text).toContain("Resolve the CLI");
    expect(terminal.text).toContain("package or supervision error");
    expect(terminal.text).not.toContain("inspect recovery status");
    terminal.write("\r");

    await expect(update).rejects.toThrow("npm install failed");
  });

  it("gives Core recovery guidance after a combined update starts Core handoff", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    deployment.updateWithProgress.mockImplementation(async (_scope, _version, report) => {
      report?.({ message: "Starting Atlas Core deployment update...", phase: "core", stage: "operation" });
      throw new Error("compose up failed");
    });
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update CLI + Atlas Core");
    terminal.write("\u001b[B");
    await terminal.waitFor("Preserve credentials and durable data");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("The update stopped without deleting Atlas Core data");
    expect(terminal.text).toContain("inspect recovery status");
    expect(terminal.text).not.toContain("Resolve the CLI");
    terminal.write("\r");

    await expect(update).rejects.toThrow("compose up failed");
  });

  it("exits with a CLI update failure instead of returning to the old menu", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    deployment.update.mockRejectedValue(new Error("npm install failed"));
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);
    let completion: "pending" | "resolved" | "rejected" = "pending";
    let failure: unknown;
    const completionPromise = menu.then(
      () => {
        completion = "resolved";
      },
      (error: unknown) => {
        completion = "rejected";
        failure = error;
      }
    );

    await terminal.waitFor("Update Atlas Core");
    terminal.write("\u001b[B".repeat(5));
    terminal.write("\r");
    await terminal.waitFor("Update CLI only");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("The update stopped without deleting Atlas Core data");
    await terminal.waitFor("Enter exit");
    await nextInputTurn();
    terminal.write("\r");

    await vi.waitFor(() => expect(completion).not.toBe("pending"), { timeout: 1_000 }).catch(() => undefined);
    if (completion === "pending") {
      terminal.write("q");
      await completionPromise;
    }

    expect(completion).toBe("rejected");
    expect(failure).toEqual(expect.objectContaining({ message: "npm install failed" }));
    expect(deployment.snapshot).toHaveBeenCalledOnce();
  });

  it("returns from an update-check error when Ctrl-C is pressed", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockRejectedValue(new Error("npm is unavailable"));
    let resolved = false;
    const update = createInteractiveCLI(terminal.input, terminal.output)
      .runUpdate(deployment)
      .then(() => {
        resolved = true;
      });

    await terminal.waitFor("Update check failed");
    terminal.write("\u0003");
    await nextInputTurn();
    const resolvedAfterCtrlC = resolved;
    if (!resolved) terminal.write("\u001b");
    await update;

    expect(resolvedAfterCtrlC).toBe(true);
  });

  it("exits when Ctrl-C is pressed during a slow update check", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    let finishUpdateCheck: (() => void) | undefined;
    deployment.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdateCheck = () =>
            resolve({
              cliVersion: "0.1.5",
              coreVersion: "0.1.5",
              latestVersion: "0.1.5",
              cliUpdateAvailable: false,
              coreUpdateAvailable: false
            });
        })
    );
    let exited = false;
    const update = createInteractiveCLI(terminal.input, terminal.output)
      .runUpdate(deployment)
      .then(() => {
        exited = true;
      });

    await terminal.waitFor("Checking npm for the latest release...");
    await vi.waitFor(() => expect(deployment.checkForUpdates).toHaveBeenCalledOnce());
    terminal.write("\u0003");
    await nextInputTurn();
    const exitedAfterCtrlC = exited;
    if (!exited) {
      finishUpdateCheck?.();
      await terminal.waitFor("The CLI and Atlas Core are current.");
      terminal.write("q");
    }
    await update;

    expect(exitedAfterCtrlC).toBe(true);
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
  });

  it("cancels and exits when Ctrl-C is pressed during an update operation", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    let finishUpdate: (() => void) | undefined;
    deployment.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () => resolve(undefined);
        })
    );
    deployment.cancelPending.mockImplementation(() => finishUpdate?.());
    let exited = false;
    const update = createInteractiveCLI(terminal.input, terminal.output)
      .runUpdate(deployment)
      .then(() => {
        exited = true;
      });

    await terminal.waitFor("Update CLI only");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("Applying reviewed update...");
    await vi.waitFor(() => expect(deployment.update).toHaveBeenCalledOnce());
    process.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => expect(exited).toBe(true));
    await update;

    expect(deployment.cancelPending).toHaveBeenCalledOnce();
    expect(terminal.text).not.toContain("Update complete");
  });

  it("returns to the update menu after Escape cancels an update operation", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates
      .mockResolvedValueOnce({
        cliVersion: "0.1.5",
        coreVersion: "0.1.4",
        latestVersion: "0.1.5",
        cliUpdateAvailable: false,
        coreUpdateAvailable: true
      })
      .mockResolvedValueOnce({
        cliVersion: "0.1.5",
        coreVersion: "0.1.5",
        latestVersion: "0.1.5",
        cliUpdateAvailable: false,
        coreUpdateAvailable: false
      });
    let cancelUpdate: (() => void) | undefined;
    deployment.update.mockImplementation(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          cancelUpdate = () => reject(new CommandCancelledError());
        })
    );
    deployment.cancelPending.mockImplementation(() => cancelUpdate?.());
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update Atlas Core");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("Applying reviewed update...");
    await vi.waitFor(() => expect(deployment.update).toHaveBeenCalledOnce());
    terminal.write("\u001b");
    await terminal.waitFor("The CLI and Atlas Core are current.");
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
    terminal.write("q");
    await update;
  });

  it("keeps a Core-only update successful when Escape arrives after the final step", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.4",
      latestVersion: "0.1.5",
      cliUpdateAvailable: false,
      coreUpdateAvailable: true
    });
    let finishUpdate: (() => void) | undefined;
    deployment.updateWithProgress.mockImplementation(
      async (_scope, _expectedVersion, report) =>
        await new Promise<void>((resolve) => {
          report?.({ message: "Core update applied", stage: "operation" });
          finishUpdate = resolve;
        })
    );
    deployment.cancelPending.mockImplementation(() => finishUpdate?.());
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);

    await terminal.waitFor("Update Atlas Core");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("Core update applied");
    terminal.write("\u001b");
    await terminal.waitFor("Update complete");
    expect(terminal.text).not.toContain("Core-only update cancelled");
    terminal.write("\r");
    await update;
  });

  it("exits after Escape cancels an update that can replace the CLI", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.6",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    let finishUpdate: (() => void) | undefined;
    deployment.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () => resolve(undefined);
        })
    );
    deployment.cancelPending.mockImplementation(() => finishUpdate?.());
    const update = createInteractiveCLI(terminal.input, terminal.output).runUpdate(deployment);
    let completion: "pending" | "resolved" | "rejected" = "pending";
    const completionPromise = update.then(
      () => {
        completion = "resolved";
      },
      () => {
        completion = "rejected";
      }
    );

    await terminal.waitFor("Update CLI only");
    terminal.write("\r");
    await terminal.waitFor("REVIEW UPDATE");
    terminal.write("\r");
    await terminal.waitFor("Applying reviewed update...");
    await vi.waitFor(() => expect(deployment.update).toHaveBeenCalledOnce());
    terminal.write("\u001b");

    await vi.waitFor(() => expect(completion).not.toBe("pending"), { timeout: 1_000 }).catch(() => undefined);
    if (completion === "pending") {
      terminal.write("q");
      await completionPromise;
    }
    await update;

    expect(completion).toBe("resolved");
    expect(deployment.checkForUpdates).toHaveBeenCalledOnce();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
  });

  it("offers initialization instead of configuration before first setup", async () => {
    const terminal = new TestTerminal();
    const deployment = operator({ status: "not-initialized", detail: "Initialize Atlas Core." });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Initialize Atlas Core");
    expect(terminal.text).not.toContain(" Configure ");
    terminal.write("q");
    await menu;
  });

  it("rejects a non-interactive terminal before reading input", async () => {
    const terminal = new TestTerminal(100, false);
    const deployment = operator();

    await expect(createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment)).rejects.toThrow(
      "requires an interactive terminal"
    );
    expect(deployment.snapshot).not.toHaveBeenCalled();
  });

  it("restores terminal mode when input ends", async () => {
    const terminal = new TestTerminal();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(operator());

    await terminal.waitFor("ATLAS CORE");
    terminal.input.end();

    await expect(menu).rejects.toThrow("lost its terminal input");
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("cancels the active operation when input ends", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    let finishDiagnostics: (() => void) | undefined;
    deployment.diagnostics.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDiagnostics = () => resolve({ healthy: true, checks: [] });
        })
    );
    deployment.cancelPending.mockImplementation(() => finishDiagnostics?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View logs and diagnostics");
    terminal.write("\u001b[B");
    terminal.write("\r");
    await terminal.waitFor("Logs and diagnostics");
    terminal.write("\u001b[B".repeat(5));
    terminal.write("\r");
    await terminal.waitFor("Running diagnostics...");
    await vi.waitFor(() => expect(deployment.diagnostics).toHaveBeenCalledOnce());
    terminal.input.emit("end");

    await expect(menu).rejects.toThrow("lost its terminal input");
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "");
}

async function nextInputTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

async function openPluginManagement(terminal: TestTerminal): Promise<void> {
  await terminal.waitFor("Manage Plugins");
  for (let index = 0; index < 4; index += 1) {
    terminal.write("\u001b[B");
    await nextInputTurn();
  }
  terminal.write("\r");
  await terminal.waitFor("ATLAS CORE > PLUGINS");
}
