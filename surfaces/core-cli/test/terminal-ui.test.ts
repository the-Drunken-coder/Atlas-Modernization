import { describe, expect, it, vi } from "vitest";
import {
  type AtlasCoreOperator,
  createInteractiveCLIForTerminal,
  type DeploymentSnapshot,
  type TerminalIO,
  type TerminalKey
} from "../src/terminal-ui.js";

class FakeTerminal implements TerminalIO {
  readonly columns = 100;
  readonly interactive = true;
  readonly output: string[] = [];
  readonly #keys: TerminalKey[];
  opened = false;

  constructor(keys: TerminalKey[]) {
    this.#keys = [...keys];
  }

  open(): void {
    this.opened = true;
  }

  close(): void {
    this.opened = false;
  }

  async readKey(): Promise<TerminalKey> {
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
