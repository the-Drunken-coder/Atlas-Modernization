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
  readonly columns = 100;
  readonly interactive: boolean;
  readonly output: string[] = [];
  readonly #keys: TerminalKey[];
  readCount = 0;
  opened = false;

  constructor(keys: TerminalKey[], interactive = true) {
    this.#keys = [...keys];
    this.interactive = interactive;
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
    configureAdminPassword: vi.fn(async () => undefined),
    doctor: vi.fn(async () => true),
    init: vi.fn(async () => undefined),
    logs: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => snapshot),
    start: vi.fn(async () => undefined),
    status: vi.fn(async () => true),
    stop: vi.fn(async () => undefined)
  } satisfies AtlasCoreOperator;
}

describe("Atlas Core terminal UI", () => {
  it("shows the action menu and exits without changing anything", async () => {
    const terminal = new FakeTerminal([key("q")]);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    const screen = terminal.output.join("");
    expect(screen).toContain("ATLAS CORE");
    expect(screen).toContain("Configure admin account");
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

  it("runs menu actions through the shared operator", async () => {
    const terminal = new FakeTerminal([enter(), enter(), key("q")]);
    const deployment = operator();

    await createInteractiveCLIForTerminal(terminal).runMenu(deployment);

    expect(deployment.status).toHaveBeenCalledOnce();
    expect(deployment.snapshot).toHaveBeenCalledTimes(2);
  });

  it("shows logs for all services from the log picker", async () => {
    const arrows = Array.from({ length: 4 }, () => key("\u001b[B", "down"));
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
    expect(screen).not.toContain("Configure admin account");
  });
});
