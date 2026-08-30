import { emitKeypressEvents, type Key } from "node:readline";
import { PACKAGE_VERSION } from "./package-metadata.js";

export type DeploymentSnapshot = {
  status: "degraded" | "not-initialized" | "ready" | "stopped";
  detail: string;
};

export type AtlasCoreOperator = {
  configureAdminPassword(password: string): Promise<void>;
  doctor(): Promise<boolean>;
  init(): Promise<void>;
  logs(service: "api" | "minio" | "postgres" | undefined, follow: boolean): Promise<void>;
  reset(): Promise<void>;
  restart(): Promise<void>;
  snapshot(): Promise<DeploymentSnapshot>;
  start(): Promise<void>;
  status(): Promise<boolean>;
  stop(): Promise<void>;
};

export type InteractiveCLI = {
  configureAdmin(operator: AtlasCoreOperator): Promise<void>;
  runMenu(operator: AtlasCoreOperator): Promise<void>;
};

export type TerminalKey = Pick<Key, "ctrl" | "meta" | "name" | "sequence" | "shift">;

export type TerminalIO = {
  readonly columns: number;
  readonly interactive: boolean;
  close(): void;
  open(): void;
  readKey(): Promise<TerminalKey>;
  write(data: string): void;
};

type Action = {
  id: "configure" | "doctor" | "init" | "logs" | "quit" | "reset" | "restart" | "start" | "status" | "stop";
  label: string;
  detail: string;
};

const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const SHOW_CURSOR = "\u001b[?25h";
const HIDE_CURSOR = "\u001b[?25l";
const RESET_STYLE = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const RED = "\u001b[31m";
const REVERSE = "\u001b[7m";

class NodeTerminal implements TerminalIO {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  #listeningForKeys = false;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
    this.#input = input;
    this.#output = output;
  }

  get columns(): number {
    return this.#output.columns ?? 80;
  }

  get interactive(): boolean {
    return this.#input.isTTY === true && this.#output.isTTY === true && this.#input.setRawMode !== undefined;
  }

  open(): void {
    if (!this.interactive)
      throw new Error("Atlas Core's menu requires an interactive terminal. Use atlas-core help to list commands.");
    if (!this.#listeningForKeys) {
      emitKeypressEvents(this.#input);
      this.#listeningForKeys = true;
    }
    this.#input.setRawMode(true);
    this.#input.resume();
    this.write(HIDE_CURSOR);
  }

  close(): void {
    if (this.#input.isTTY && this.#input.setRawMode) this.#input.setRawMode(false);
    this.#input.pause();
    this.write(`${RESET_STYLE}${SHOW_CURSOR}`);
  }

  async readKey(): Promise<TerminalKey> {
    return await new Promise((resolve) => {
      this.#input.once("keypress", (sequence: string, key: Key) => resolve({ ...key, sequence }));
    });
  }

  write(data: string): void {
    this.#output.write(data);
  }
}

export function createInteractiveCLI(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout
): InteractiveCLI {
  return createInteractiveCLIForTerminal(new NodeTerminal(input, output));
}

export function createInteractiveCLIForTerminal(terminal: TerminalIO): InteractiveCLI {
  return {
    configureAdmin: async (operator) => {
      assertInteractive(terminal);
      terminal.open();
      try {
        terminal.write(`${BOLD}Configure Atlas Core admin account${RESET_STYLE}\nUsername: admin\n\n`);
        const password = await promptForPassword(terminal);
        if (password === undefined) {
          terminal.write("\nAdmin password unchanged.\n");
          return;
        }
        terminal.close();
        await operator.configureAdminPassword(password);
      } finally {
        terminal.close();
      }
    },
    runMenu: async (operator) => {
      await runMenu(operator, terminal);
    }
  };
}

async function runMenu(operator: AtlasCoreOperator, terminal: TerminalIO): Promise<void> {
  assertInteractive(terminal);
  terminal.open();
  try {
    terminal.write(`${CLEAR_SCREEN}${BOLD}ATLAS CORE${RESET_STYLE}\n\nChecking deployment...`);
    let snapshot = await readSnapshot(operator);
    let filter = "";
    let selected = 0;

    while (true) {
      const actions = filteredActions(menuActions(snapshot), filter);
      selected = Math.min(selected, Math.max(0, actions.length - 1));
      renderMenu(terminal, snapshot, actions, selected, filter);
      const key = await terminal.readKey();

      if ((key.ctrl && key.name === "c") || key.name === "escape" || (key.name === "q" && filter === "")) return;
      if (key.name === "up") {
        selected = actions.length === 0 ? 0 : (selected - 1 + actions.length) % actions.length;
        continue;
      }
      if (key.name === "down") {
        selected = actions.length === 0 ? 0 : (selected + 1) % actions.length;
        continue;
      }
      if (key.name === "backspace") {
        filter = Array.from(filter).slice(0, -1).join("");
        selected = 0;
        continue;
      }
      if (key.name === "return" || key.name === "enter") {
        const action = actions[selected];
        if (!action) continue;
        if (action.id === "quit") return;
        await runAction(operator, terminal, action);
        snapshot = await readSnapshot(operator);
        filter = "";
        selected = 0;
        continue;
      }
      if (isPrintableKey(key)) {
        filter += key.sequence;
        selected = 0;
      }
    }
  } finally {
    terminal.write(CLEAR_SCREEN);
    terminal.close();
  }
}

async function runAction(operator: AtlasCoreOperator, terminal: TerminalIO, action: Action): Promise<void> {
  if (action.id === "configure") {
    terminal.write(CLEAR_SCREEN);
    terminal.write(`${BOLD}Configure Atlas Core admin account${RESET_STYLE}\nUsername: admin\n\n`);
    let password: string | undefined;
    try {
      password = await promptForPassword(terminal);
    } catch (error) {
      terminal.write(`\n${RED}${errorMessage(error)}${RESET_STYLE}\n\nPress Enter to return to the menu.`);
      await waitForReturn(terminal);
      return;
    }
    if (password === undefined) {
      terminal.write("\nAdmin password unchanged.\n\nPress Enter to return to the menu.");
      await waitForReturn(terminal);
      return;
    }
    await runVisibleOperation(terminal, async () => {
      await operator.configureAdminPassword(password);
    });
    return;
  }

  if (action.id === "logs") {
    const service = await selectLogService(terminal);
    if (service === "cancel") return;
    await runVisibleOperation(terminal, async () => {
      await operator.logs(service, false);
    });
    return;
  }

  await runVisibleOperation(terminal, async () => {
    switch (action.id) {
      case "doctor":
        await operator.doctor();
        return;
      case "init":
        await operator.init();
        return;
      case "reset":
        await operator.reset();
        return;
      case "restart":
        await operator.restart();
        return;
      case "start":
        await operator.start();
        return;
      case "status":
        await operator.status();
        return;
      case "stop":
        await operator.stop();
        return;
      case "configure":
      case "logs":
      case "quit":
        return;
    }
  });
}

async function runVisibleOperation(terminal: TerminalIO, operation: () => Promise<void>): Promise<void> {
  terminal.write(CLEAR_SCREEN);
  terminal.close();
  try {
    await operation();
  } catch (error) {
    terminal.write(`\n${RED}${errorMessage(error)}${RESET_STYLE}\n`);
  }
  terminal.write("\nPress Enter to return to the menu.");
  terminal.open();
  await waitForReturn(terminal);
}

async function waitForReturn(terminal: TerminalIO): Promise<void> {
  while (true) {
    const key = await terminal.readKey();
    if (key.name === "return" || key.name === "enter" || key.name === "escape" || (key.ctrl && key.name === "c")) {
      return;
    }
  }
}

async function promptForPassword(terminal: TerminalIO): Promise<string | undefined> {
  const password = await readSecret(terminal, "New password: ");
  if (password === undefined) return undefined;
  const confirmation = await readSecret(terminal, "Confirm password: ");
  if (confirmation === undefined) return undefined;
  if (password !== confirmation) throw new Error("Passwords did not match. The admin password was not changed.");
  return password;
}

async function readSecret(terminal: TerminalIO, label: string): Promise<string | undefined> {
  terminal.write(label);
  let value = "";
  while (true) {
    const key = await terminal.readKey();
    if ((key.ctrl && key.name === "c") || key.name === "escape") return undefined;
    if (key.name === "return" || key.name === "enter") {
      terminal.write("\n");
      return value;
    }
    if (key.name === "backspace") {
      if (value.length > 0) {
        value = Array.from(value).slice(0, -1).join("");
        terminal.write("\b \b");
      }
      continue;
    }
    if (isPrintableKey(key)) {
      value += key.sequence;
      terminal.write("*");
    }
  }
}

async function selectLogService(terminal: TerminalIO): Promise<"api" | "cancel" | "minio" | "postgres" | undefined> {
  const choices: Array<{ label: string; service: "api" | "cancel" | "minio" | "postgres" | undefined }> = [
    { label: "All services", service: undefined },
    { label: "Core API", service: "api" },
    { label: "PostgreSQL", service: "postgres" },
    { label: "MinIO", service: "minio" },
    { label: "Back", service: "cancel" }
  ];
  let selected = 0;
  while (true) {
    terminal.write(`${CLEAR_SCREEN}${BOLD}View logs${RESET_STYLE}\n\n`);
    for (const [index, choice] of choices.entries()) {
      const line = `${index === selected ? ">" : " "} ${choice.label}`;
      terminal.write(index === selected ? `${REVERSE}${line}${RESET_STYLE}\n` : `${line}\n`);
    }
    terminal.write(`\n${DIM}↑/↓ move   Enter select   Esc back${RESET_STYLE}`);
    const key = await terminal.readKey();
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return "cancel";
    if (key.name === "up") selected = (selected - 1 + choices.length) % choices.length;
    if (key.name === "down") selected = (selected + 1) % choices.length;
    if (key.name === "return" || key.name === "enter") {
      const choice = choices[selected];
      return choice ? choice.service : "cancel";
    }
  }
}

function menuActions(snapshot: DeploymentSnapshot): Action[] {
  const actions: Action[] = [];
  if (snapshot.status === "not-initialized") {
    actions.push({
      id: "init",
      label: "Initialize Atlas Core",
      detail: "Create private credentials and provision the new durable MinIO store."
    });
  } else {
    actions.push({ id: "status", label: "View status", detail: snapshot.detail });
    if (snapshot.status === "ready") {
      actions.push({ id: "stop", label: "Stop Atlas Core", detail: "Stop containers and preserve durable storage." });
    } else {
      actions.push({ id: "start", label: "Start Atlas Core", detail: "Start the deployment from its pinned image." });
    }
    actions.push(
      { id: "restart", label: "Restart Atlas Core", detail: "Pull the pinned image, then restart the deployment." },
      {
        id: "configure",
        label: "Configure admin account",
        detail: "Change the password for the fixed admin username. No other settings are exposed."
      },
      { id: "logs", label: "View logs", detail: "Show the latest logs for all services or one service." }
    );
  }
  actions.push(
    { id: "doctor", label: "Run diagnostics", detail: "Check the host, Docker, Compose, and local configuration." },
    {
      id: "reset",
      label: "Reset Atlas Core",
      detail: "Permanently delete Atlas Core data and credentials, then start from scratch. Confirmation is required."
    },
    { id: "quit", label: "Quit", detail: "Exit without changing the deployment." }
  );
  return actions;
}

function filteredActions(actions: Action[], filter: string): Action[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return actions;
  return actions.filter((action) => action.label.toLocaleLowerCase().includes(query));
}

function renderMenu(
  terminal: TerminalIO,
  snapshot: DeploymentSnapshot,
  actions: Action[],
  selected: number,
  filter: string
): void {
  const width = Math.max(44, terminal.columns);
  const state = snapshot.status.replace("not-initialized", "NOT INITIALIZED").toUpperCase();
  const title = `${BOLD}${CYAN}ATLAS CORE${RESET_STYLE}`;
  const versionAndState = `${DIM}v${PACKAGE_VERSION}  ${state}${RESET_STYLE}`;
  terminal.write(
    `${CLEAR_SCREEN}${title}${" ".repeat(Math.max(2, width - 10 - visibleLength(versionAndState)))}${versionAndState}\n`
  );
  terminal.write(`${DIM}Manage one durable deployment${RESET_STYLE}\n${"─".repeat(width)}\n`);

  const actionWidth = Math.min(34, Math.max(24, Math.floor(width * 0.42)));
  const detailWidth = width - actionWidth - 4;
  if (detailWidth >= 28) {
    terminal.write(`${BOLD}${pad("ACTIONS", actionWidth)}   DETAILS${RESET_STYLE}\n`);
    const detail = actions[selected]?.detail ?? "No actions match the filter.";
    const detailLines = wrap(detail, detailWidth);
    const rowCount = Math.max(actions.length, detailLines.length, 1);
    for (let index = 0; index < rowCount; index += 1) {
      const action = actions[index];
      const label = action ? `${index === selected ? ">" : " "} ${action.label}` : "";
      const styledLabel =
        action && index === selected ? `${REVERSE}${pad(label, actionWidth)}${RESET_STYLE}` : pad(label, actionWidth);
      terminal.write(`${styledLabel} │ ${detailLines[index] ?? ""}\n`);
    }
  } else {
    terminal.write(`${BOLD}ACTIONS${RESET_STYLE}\n`);
    for (const [index, action] of actions.entries()) {
      const label = `${index === selected ? ">" : " "} ${action.label}`;
      terminal.write(index === selected ? `${REVERSE}${label}${RESET_STYLE}\n` : `${label}\n`);
    }
    terminal.write(`\n${BOLD}DETAILS${RESET_STYLE}\n${actions[selected]?.detail ?? "No actions match the filter."}\n`);
  }

  terminal.write(`${"─".repeat(width)}\n`);
  terminal.write(`Filter: ${filter || `${DIM}type to filter${RESET_STYLE}`}\n`);
  terminal.write(`${DIM}↑/↓ move   Enter select   Backspace edit   Esc or q quit${RESET_STYLE}`);
}

async function readSnapshot(operator: AtlasCoreOperator): Promise<DeploymentSnapshot> {
  try {
    return await operator.snapshot();
  } catch (error) {
    return { status: "degraded", detail: errorMessage(error) };
  }
}

function isPrintableKey(key: TerminalKey): key is TerminalKey & { sequence: string } {
  return !key.ctrl && !key.meta && typeof key.sequence === "string" && /^[^\u0000-\u001f\u007f]+$/u.test(key.sequence);
}

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of value.split(/\s+/)) {
    if (!current) current = word;
    else if (current.length + word.length + 1 <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function pad(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return clipped.padEnd(width);
}

function visibleLength(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function assertInteractive(terminal: TerminalIO): void {
  if (!terminal.interactive) {
    throw new Error("Atlas Core's menu requires an interactive terminal. Use atlas-core help to list commands.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
