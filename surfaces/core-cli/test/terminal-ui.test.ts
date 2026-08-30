import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { type AtlasCoreOperator, createInteractiveCLI, type DeploymentSnapshot } from "../src/terminal-ui.js";

class TestTerminal {
  readonly input = new PassThrough() as PassThrough & NodeJS.ReadStream;
  readonly output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  readonly setRawMode = vi.fn((enabled: boolean) => {
    Object.assign(this.input, { isRaw: enabled });
    return this.input;
  });
  #output = "";

  constructor(columns = 100, interactive = true) {
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
      rows: 40
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

  async waitFor(value: string): Promise<void> {
    await vi.waitFor(() => expect(this.text).toContain(value), { timeout: 2_000 });
  }

  async waitForRawChange(previousLength: number): Promise<void> {
    await vi.waitFor(() => expect(this.raw.length).toBeGreaterThan(previousLength), { timeout: 2_000 });
  }
}

function operator(snapshot: DeploymentSnapshot = { status: "ready", detail: "Everything is healthy." }) {
  return {
    checkForUpdates: vi.fn(async () => ({
      cliVersion: "0.1.5",
      coreVersion: "0.1.5",
      latestVersion: "0.1.5",
      cliUpdateAvailable: false,
      coreUpdateAvailable: false
    })),
    configureAdminPassword: vi.fn(async () => undefined),
    details: vi.fn(async () => ({
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
    reset: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => snapshot),
    start: vi.fn(async () => undefined),
    status: vi.fn(async () => true),
    stop: vi.fn(async () => undefined),
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

  it("renders an intentional narrow-terminal state", async () => {
    const terminal = new TestTerminal(36);
    const menu = createInteractiveCLI(terminal.input, terminal.output).runMenu(operator());

    await terminal.waitFor("Resize to at least 40 columns.");
    terminal.write("q");
    await menu;
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
});

function stripAnsi(value: string): string {
  return value.replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "");
}
