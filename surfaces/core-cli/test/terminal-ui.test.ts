import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  type AtlasCoreOperator,
  createInteractiveCLI,
  createInteractiveCLIForTerminal,
  type DeploymentSnapshot,
  type TerminalIO,
  type TerminalKey
} from "../src/terminal-ui.js";

class FakeTerminal implements TerminalIO {
  readonly columns: number;
  readonly interactive: boolean;
  readonly output: string[] = [];
  readonly #keys: TerminalKey[];
  readCount = 0;
  opened = false;

  constructor(keys: TerminalKey[], interactive = true, columns = 100) {
    this.#keys = [...keys];
    this.interactive = interactive;
    this.columns = columns;
  }

  open(): void {
    this.opened = true;
  }

  close(): void {
    this.opened = false;
  }

  async readKey(): Promise<TerminalKey> {
    this.readCount += 1;
    const key = this.#keys.shift();
    if (!key) throw new Error("Fake terminal ran out of keys");
    return key;
  }

  write(data: string): void {
    this.output.push(data);
  }
}

function key(sequence: string, name = sequence): TerminalKey {
  return { ctrl: false, meta: false, name, sequence, shift: false };
}

function enter(): TerminalKey {
  return key("\r", "return");
}

function operator(snapshot: DeploymentSnapshot = { status: "ready", detail: "Everything is healthy." }) {
  return {
    checkForUpdates: vi.fn(async () => ({
      cliVersion: "0.1.3",
      coreVersion: "0.1.3",
      latestVersion: "0.1.3",
      cliUpdateAvailable: false,
      coreUpdateAvailable: false
    })),
    configureAdminPassword: vi.fn(async () => undefined),
    details: vi.fn(async () => ({
      snapshot,
      cliVersion: "0.1.3",
      coreVersion: "0.1.3",
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
  it("shows the action menu and exits without changing anything", async () => {
    const terminal = new FakeTerminal([key("q")]);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    const screen = terminal.output.join("");
    expect(screen).toContain("ATLAS CORE");
    expect(screen).toContain("Configure");
    expect(screen).toContain("Update");
    expect(screen).toContain("Reset Atlas Core");
    expect(deployment.snapshot).toHaveBeenCalledOnce();
    expect(deployment.start).not.toHaveBeenCalled();
    expect(terminal.opened).toBe(false);
  });

  it("masks a manually entered admin password", async () => {
    const password = "correct-horse-battery-staple";
    const keys = [...password].map((character) => key(character));
    const terminal = new FakeTerminal([...keys, enter(), ...keys, enter()]);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).configureAdmin(deployment);

    expect(deployment.configureAdminPassword).toHaveBeenCalledWith(password);
    const output = terminal.output.join("");
    expect(output).toContain("Username: admin");
    expect(output).not.toContain(password);
    expect(output).toContain("*".repeat(password.length));
    expect(terminal.opened).toBe(false);
  });

  it("accepts a pasted password without dropping keypresses", async () => {
    const input = new PassThrough();
    const setRawMode = vi.fn(() => input);
    Object.assign(input, { isTTY: true, setRawMode });
    const output = new PassThrough();
    Object.assign(output, { columns: 100, isTTY: true });
    const password = "correct-horse-battery-staple";
    const deployment = operator();

    const configuration = createInteractiveCLI(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream
    ).configureAdmin(deployment);
    input.write(`${password}\r${password}\r`);

    await configuration;
    expect(deployment.configureAdminPassword).toHaveBeenCalledWith(password);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("rejects mismatched password confirmation without changing the account", async () => {
    const password = "correct-horse-battery-staple";
    const confirmation = "different-admin-password";
    const terminal = new FakeTerminal([
      ...[...password].map((character) => key(character)),
      enter(),
      ...[...confirmation].map((character) => key(character)),
      enter()
    ]);
    const deployment = operator();

    await expect(createInteractiveCLIForTerminal(terminal).configureAdmin(deployment)).rejects.toThrow(
      "Passwords did not match"
    );

    expect(deployment.configureAdminPassword).not.toHaveBeenCalled();
    expect(terminal.opened).toBe(false);
  });

  it("rejects configuration outside an interactive terminal before reading input", async () => {
    const terminal = new FakeTerminal([], false);
    const deployment = operator();

    await expect(createInteractiveCLIForTerminal(terminal).configureAdmin(deployment)).rejects.toThrow(
      "requires an interactive terminal"
    );

    expect(terminal.readCount).toBe(0);
    expect(deployment.configureAdminPassword).not.toHaveBeenCalled();
  });

  it("restores terminal mode when input ends", async () => {
    const input = new PassThrough();
    const setRawMode = vi.fn(() => input);
    Object.assign(input, { isTTY: true, setRawMode });
    const output = new PassThrough();
    Object.assign(output, { columns: 100, isTTY: true });
    const deployment = operator({ status: "not-initialized", detail: "Initialize Atlas Core." });

    const menu = createInteractiveCLI(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream
    ).runMenu(deployment);
    input.end();

    await expect(menu).rejects.toThrow("lost its terminal input");
    expect(setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("opens the service-focused status view through the shared operator", async () => {
    const terminal = new FakeTerminal([enter(), enter(), key("q")]);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    expect(deployment.details).toHaveBeenCalledOnce();
    expect(terminal.output.join("")).toContain("ATLAS CORE > STATUS");
    expect(terminal.output.join("")).toContain("1.00%");
    expect(deployment.snapshot).toHaveBeenCalledTimes(2);
  });

  it("moves between services in the detailed status view", async () => {
    const terminal = new FakeTerminal([enter(), key("\u001b[C", "right"), enter(), key("q")]);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    const screen = terminal.output.join("");
    expect(screen).toContain("[PostgreSQL]");
    expect(screen).toContain("256MiB / 1GiB");
    expect(screen).toContain("Network I/O");
  });

  it("fits the detailed status view in a narrow terminal", async () => {
    const terminal = new FakeTerminal([enter(), enter(), key("q")], true, 44);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    const statusScreen = terminal.output
      .join("")
      .split("\u001b[2J\u001b[H")
      .filter((screen) => screen.includes("ATLAS CORE > STATUS"))
      .at(-1)
      ?.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "")
      .split("ATLAS CORE > STATUS")
      .at(-1);
    expect(statusScreen).toBeDefined();
    expect((statusScreen ?? "").split("\n").filter((line) => line.length > 44)).toEqual([]);
  });

  it("opens Admin account from the Configure submenu", async () => {
    const filter = [..."configure"].map((character) => key(character));
    const terminal = new FakeTerminal([...filter, enter(), key("\u001b[B", "down"), enter(), key("q")]);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    expect(terminal.output.join("")).toContain("Admin account");
    expect(deployment.configureAdminPassword).not.toHaveBeenCalled();
  });

  it("updates the CLI and Core from the update menu", async () => {
    const filter = [..."update"].map((character) => key(character));
    const terminal = new FakeTerminal([...filter, enter(), key("\u001b[B", "down"), enter(), enter(), enter()]);
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.3",
      coreVersion: "0.1.3",
      latestVersion: "0.1.4",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    expect(deployment.update).toHaveBeenCalledWith("all", "0.1.4", true);
    expect(terminal.output.join("")).toContain("PostgreSQL, MinIO, credentials, and configuration are preserved");
    expect(terminal.output.join("")).toContain("paired PostgreSQL and MinIO backup exists");
  });

  it("labels a Core-only update without claiming the CLI will change", async () => {
    const terminal = new FakeTerminal([enter(), enter(), enter()]);
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.3",
      coreVersion: "0.1.2",
      latestVersion: "0.1.3",
      cliUpdateAvailable: false,
      coreUpdateAvailable: true
    });

    await createInteractiveCLIForTerminal(terminal).runUpdate(deployment);

    expect(terminal.output.join("")).toContain("Update Atlas Core");
    expect(terminal.output.join("")).toContain("CLI stays at 0.1.3");
    expect(deployment.update).toHaveBeenCalledWith("all", "0.1.3", true);
  });

  it("propagates an interactive update failure after showing the recovery message", async () => {
    const terminal = new FakeTerminal([enter(), enter(), enter()]);
    const deployment = operator();
    deployment.checkForUpdates.mockResolvedValue({
      cliVersion: "0.1.3",
      coreVersion: "0.1.3",
      latestVersion: "0.1.4",
      cliUpdateAvailable: true,
      coreUpdateAvailable: true
    });
    deployment.update.mockRejectedValue(new Error("npm install failed"));

    await expect(createInteractiveCLIForTerminal(terminal).runUpdate(deployment)).rejects.toThrow("npm install failed");

    expect(terminal.output.join("")).toContain("The update stopped without deleting Atlas Core data");
    expect(terminal.opened).toBe(false);
  });

  it("shows logs for all services from the log picker", async () => {
    const arrows = Array.from({ length: 5 }, () => key("\u001b[B", "down"));
    const terminal = new FakeTerminal([...arrows, enter(), enter(), enter(), key("q")]);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    expect(deployment.logs).toHaveBeenCalledWith(undefined, false);
  });

  it("offers initialization instead of account configuration before first setup", async () => {
    const terminal = new FakeTerminal([key("q")]);
    const deployment = operator({ status: "not-initialized", detail: "Initialize Atlas Core." });

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    const screen = terminal.output.join("");
    expect(screen).toContain("Initialize Atlas Core");
    expect(screen).not.toContain(" Configure ");
  });
});
