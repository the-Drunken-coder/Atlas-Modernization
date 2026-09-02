import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  type AtlasCoreOperator,
  createInteractiveCLI,
  type DeploymentSnapshot,
  type PluginActivityReporter,
  type PluginDeploymentStatus,
  type PluginOperationOutcome
} from "../src/terminal-ui.js";

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

function operator(snapshot: DeploymentSnapshot = { status: "ready", detail: "Everything is healthy." }) {
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
    details: vi.fn(async (_signal?: AbortSignal) => ({
      snapshot,
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
    pluginStatuses: vi.fn(async (_pluginId?: string): Promise<PluginDeploymentStatus[]> => []),
    resumeAfterCancellation: vi.fn(),
    reset: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => snapshot),
    start: vi.fn(async () => undefined),
    status: vi.fn(async () => true),
    stop: vi.fn(async (): Promise<void> => {}),
    update: vi.fn(async () => undefined)
  } satisfies AtlasCoreOperator;
}

describe("Atlas Core terminal UI", () => {
  it("shows the selected split console and exits without changing anything", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Reset Atlas Core");
    expect(terminal.text).toContain("ACTIONS");
    expect(terminal.text).toContain("DETAILS");
    expect(terminal.text).toContain("Everything is healthy.");
    terminal.write("q");
    await menu;

    expect(deployment.snapshot).toHaveBeenCalledOnce();
    expect(deployment.start).not.toHaveBeenCalled();
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("updates only changed terminal lines when an arrow key moves selection", async () => {
    const terminal = new TestTerminal();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(operator());

    await terminal.waitFor("View status");
    const before = terminal.raw.length;
    terminal.write("\u001b[B");
    await terminal.waitForRawChange(before);
    const arrowFrame = terminal.raw.slice(before);

    expect(arrowFrame).not.toContain("\u001b[2J");
    expect(arrowFrame).not.toContain("\u001bc");
    terminal.write("q");
    await menu;
  });

  it("dispatches the selection moved in the same input chunk", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
    terminal.write("\u001b[B\r");
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.stop).toHaveBeenCalledOnce();
    expect(deployment.details).not.toHaveBeenCalled();
  });

  it("returns to the menu after cancelling an ordinary operation", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    let finishStop: (() => void) | undefined;
    deployment.stop.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishStop = resolve;
        })
    );
    deployment.cancelPending.mockImplementation(() => finishStop?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
    terminal.write("stop");
    await terminal.waitFor("Filter: stop");
    terminal.write("\r");
    await terminal.waitFor("Stop Atlas Core...");
    await vi.waitFor(() => expect(deployment.stop).toHaveBeenCalledOnce());
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    await terminal.waitFor("View status");
    expect(deployment.cancelPending).toHaveBeenCalledOnce();
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
    terminal.write("q");
    await menu;
  });

  it("keeps a cleanup failure visible after cancelling an ordinary operation", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    let failCleanup: (() => void) | undefined;
    deployment.stop.mockImplementation(
      async () =>
        await new Promise<void>((_resolve, reject) => {
          failCleanup = () => reject(new Error("Docker mutation-lock cleanup failed"));
        })
    );
    deployment.cancelPending.mockImplementation(() => failCleanup?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
    terminal.write("stop");
    await terminal.waitFor("Filter: stop");
    terminal.write("\r");
    await terminal.waitFor("Stop Atlas Core...");
    process.emit("SIGINT", "SIGINT");
    await terminal.waitFor("Docker mutation-lock cleanup failed");
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
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
    expect(terminal.text).toContain("ACTIONS");
    expect(terminal.text).not.toContain("DETAILS");
    const before = terminal.raw.length;
    terminal.write("\u001b[B");
    await terminal.waitForRawChange(before);
    terminal.write("q");
    await menu;
  });

  it("blocks hidden main-menu actions when even the compact menu is too tall", async () => {
    const terminal = new TestTerminal(40, true, 10);
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Menu needs at least");
    terminal.write("\r");
    await nextInputTurn();
    terminal.write("q");
    await menu;

    expect(deployment.details).not.toHaveBeenCalled();
  });

  it("discards reset confirmation typed before the warning prompt appears", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    let answer: string | undefined;
    let confirmationSettled = false;
    deployment.reset.mockImplementation(async () => {
      terminal.output.write("Reset permanently deletes Atlas Core data.\n");
      const prompt = createInterface({ input: terminal.input, output: terminal.output });
      try {
        answer = await prompt.question("Continue? [y/N] ");
        confirmationSettled = true;
      } finally {
        prompt.close();
      }
    });
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Reset Atlas Core");
    terminal.writeWhenVisible("Reset Atlas Core...", "yes\n");
    terminal.write("reset");
    await terminal.waitFor("Filter: reset");
    terminal.write("\r");
    await terminal.waitFor("Continue? [y/N]");
    await nextInputTurn();
    if (!confirmationSettled) terminal.write("no\n");
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(answer).toBe("no");
  });

  it("opens the service status view and moves between services", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
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

  it("opens logs for the status service selected in the same input chunk", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
    terminal.write("\r");
    await terminal.waitFor("Network I/O");
    terminal.write("\u001b[Cl");
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.details).toHaveBeenCalledTimes(2));
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.logs).toHaveBeenCalledWith("postgres", false);
  });

  it("dispatches only one action when Enter repeats before the screen changes", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
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

    await terminal.waitFor("View status");
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

    await terminal.waitFor("View status");
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

      await terminal.waitFor("View status");
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

    await terminal.waitFor("View status");
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

    await terminal.waitFor("View status");
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

    await terminal.waitFor("View status");
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

    await terminal.waitFor("View status");
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

    await terminal.waitFor("View status");
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

    await terminal.waitFor("View status");
    terminal.write("plugins");
    await terminal.waitFor("Filter: plugins");
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

    await terminal.waitFor("View status");
    terminal.write("plugins");
    await terminal.waitFor("Filter: plugins");
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Previous deployment restored");
    await terminal.waitFor("Enable failed: health wait timed out");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("cancels Plugin enable safely and returns to the Plugins screen", async () => {
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
          reportActivity?.({ level: "working", message: "Pulling Building Scan image", stage: "operation" });
          cancelEnable = () => {
            reportActivity?.({
              level: "failure",
              message: "Enable stopped: Atlas Core command was cancelled",
              stage: "operation"
            });
            reportActivity?.({ level: "working", message: "Restoring previous deployment", stage: "rollback" });
            reportActivity?.({ level: "success", message: "Previous deployment restored", stage: "rollback" });
            resolve({ previousDeploymentPreserved: true, status: "cancelled" });
          };
        })
    );
    deployment.cancelPending.mockImplementation(() => cancelEnable?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
    terminal.write("plugins");
    await terminal.waitFor("Filter: plugins");
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Pulling Building Scan image");
    terminal.write("\u0003");
    await terminal.waitFor("Previous deployment restored");
    await terminal.waitFor("Enable cancelled. The previous deployment is preserved.");
    expect(deployment.resumeAfterCancellation).toHaveBeenCalledOnce();
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.cancelPending).toHaveBeenCalledOnce();
  });

  it("reports a committed Plugin change as success after a late cancellation request", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let finishLockCleanup: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async (_pluginId, reportActivity) =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          reportActivity?.({ level: "success", message: "Core API and Building Scan are healthy", stage: "operation" });
          finishLockCleanup = () => {
            reportActivity?.({ level: "success", message: "Building Scan enabled and healthy", stage: "operation" });
            resolve({ status: "success" });
          };
        })
    );
    deployment.cancelPending.mockImplementation(() => finishLockCleanup?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
    terminal.write("plugins");
    await terminal.waitFor("Filter: plugins");
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("Core API and Building Scan are healthy");
    terminal.write("\u0003");
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

    await terminal.waitFor("View status");
    terminal.write("plugins");
    await terminal.waitFor("Filter: plugins");
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

  it("keeps Plugin activity controls visible in a four-row terminal", async () => {
    const terminal = new TestTerminal(40, true, 24);
    const deployment = operator();
    const plugin = {
      pluginId: "building_scan",
      displayName: "Building Scan With A Deliberately Long Operator-Facing Name",
      lifecycle: "query_only" as const,
      enabled: false,
      packaged: true
    };
    let cancelEnable: (() => void) | undefined;
    deployment.pluginStatuses.mockResolvedValue([plugin]);
    deployment.pluginEnable.mockImplementation(
      async () =>
        await new Promise<PluginOperationOutcome>((resolve) => {
          cancelEnable = () => resolve({ previousDeploymentPreserved: true, status: "cancelled" });
        })
    );
    deployment.cancelPending.mockImplementation(() => cancelEnable?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
    terminal.write("plugins");
    await terminal.waitFor("Filter: plugins");
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("ATLAS CORE > ACTIVITY");
    terminal.resize(40, 4);
    await terminal.waitFor("ACTIVITY 00:00.0");
    await terminal.waitFor("Ctrl+C cancel safely");
    terminal.write("\u0003");
    await terminal.waitFor("Enable cancelled.");
    await terminal.waitFor("Enter return to Plugins");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
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

    await terminal.waitFor("View status");
    terminal.write("plugins");
    await terminal.waitFor("Filter: plugins");
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

  it("shows the Plugin failure reason in a four-row terminal", async () => {
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

    await terminal.waitFor("View status");
    terminal.write("plugins");
    await terminal.waitFor("Filter: plugins");
    terminal.write("\r");
    await terminal.waitFor("PLUGIN CATALOG");
    terminal.write("\r");
    await terminal.waitFor("ATLAS CORE > ACTIVITY");
    terminal.resize(40, 4);
    failEnable?.();
    await terminal.waitFor("Enable failed: health wait timed out");
    await terminal.waitFor("Enter return to Plugins");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.pluginStatuses).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;
  });

  it("shows logs for all services from the log picker", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View logs");
    terminal.write("logs\u001b[13u");
    await terminal.waitFor("All services");
    terminal.write("\r");
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(deployment.logs).toHaveBeenCalledWith(undefined, false);
  });

  it("dispatches the newly selected log once when input is coalesced", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    let finishLogs: (() => void) | undefined;
    const pendingLogs = new Promise<undefined>((resolve) => {
      finishLogs = () => resolve(undefined);
    });
    deployment.logs.mockImplementation(() => pendingLogs);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View logs");
    terminal.write("logs");
    await terminal.waitFor("Filter: logs");
    terminal.write("\r");
    await terminal.waitFor("All services");
    terminal.write("\u001b[B\u001b[13u\u001b[13u");
    await vi.waitFor(() => expect(deployment.logs).toHaveBeenCalled());
    await nextInputTurn();
    const logCallsAfterRepeatedEnter = deployment.logs.mock.calls.length;
    finishLogs?.();
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await vi.waitFor(() => expect(deployment.snapshot).toHaveBeenCalledTimes(2));
    terminal.write("q");
    await menu;

    expect(logCallsAfterRepeatedEnter).toBe(1);
    expect(deployment.logs).toHaveBeenCalledWith("api", false);
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
    terminal.write("\u001b[B\r");
    await terminal.waitFor("paired PostgreSQL and MinIO backup exists");
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

  it("opens the admin account from the Configure submenu", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("Configure");
    terminal.write("configure");
    await terminal.waitFor("Filter: configure");
    const beforeSubmenu = terminal.raw.length;
    terminal.write("\r");
    await terminal.waitForRawChange(beforeSubmenu);
    await nextInputTurn();
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

    expect(deployment.configureAdminPassword).not.toHaveBeenCalled();
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
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await configuration;

    expect(deployment.configureAdminPassword).toHaveBeenCalledWith(password);
    expect(terminal.text).not.toContain(password);
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
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await configuration;

    expect(deployment.configureAdminPassword).toHaveBeenCalledWith(password);
  });

  it("submits the admin password once when confirmation Enter repeats", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const password = "correct-horse-battery-staple";
    let finishConfiguration: (() => void) | undefined;
    const pendingConfiguration = new Promise<undefined>((resolve) => {
      finishConfiguration = () => resolve(undefined);
    });
    deployment.configureAdminPassword.mockImplementation(() => pendingConfiguration);
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
    await vi.waitFor(() => expect(deployment.configureAdminPassword).toHaveBeenCalled());
    await nextInputTurn();
    const configurationCallsAfterRepeatedEnter = deployment.configureAdminPassword.mock.calls.length;
    finishConfiguration?.();
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
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
    await terminal.waitFor("Press Enter to return to Atlas Core.");
    terminal.write("\r");
    await configuration;

    expect(deployment.configureAdminPassword).toHaveBeenCalledWith(password);
    expect(terminal.text).not.toContain(password);
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

    expect(deployment.configureAdminPassword).not.toHaveBeenCalled();
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
    await vi.waitFor(() =>
      expect(
        terminal.text.includes("Press Enter to return to Atlas Core.") ||
          terminal.text.includes("Passwords did not match")
      ).toBe(true)
    );
    const passwordWasSubmitted = deployment.configureAdminPassword.mock.calls.length > 0;
    if (passwordWasSubmitted) {
      terminal.write("\r");
    } else {
      terminal.write("\u001b");
    }
    await configuration;

    expect(deployment.configureAdminPassword).toHaveBeenCalledWith("x");
  });

  it("does not treat Ctrl-D as the diagnostics shortcut", async () => {
    const terminal = new TestTerminal();
    const deployment = operator();
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
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
    await terminal.waitFor("paired PostgreSQL and MinIO backup exists");
    terminal.write("\r");
    await terminal.waitFor("Update complete");
    terminal.write("\r");
    await update;

    expect(deployment.update).toHaveBeenCalledWith("all", "0.1.6", true);
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
    await terminal.waitFor("Update complete");
    terminal.write("\r");
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
    terminal.write("\r");
    await terminal.waitFor("CLI stays at 0.1.5.");
    terminal.write("\r");
    await terminal.waitFor("Update complete");
    terminal.write("\r");
    await update;

    expect(deployment.update).toHaveBeenCalledWith("all", "0.1.5", true);
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
    terminal.write("\r");

    await expect(update).rejects.toThrow("npm install failed");
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
    deployment.doctor.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDiagnostics = () => resolve(true);
        })
    );
    deployment.cancelPending.mockImplementation(() => finishDiagnostics?.());
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(deployment);

    await terminal.waitFor("View status");
    terminal.write("diagnostics");
    await terminal.waitFor("Filter: diagnostics");
    terminal.write("\r");
    await terminal.waitFor("Run diagnostics...");
    await vi.waitFor(() => expect(deployment.doctor).toHaveBeenCalledOnce());
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
