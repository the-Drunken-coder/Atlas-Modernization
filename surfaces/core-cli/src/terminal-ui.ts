import { emitKeypressEvents, type Key } from "node:readline";
import { PACKAGE_VERSION } from "./package-metadata.js";

export type DeploymentSnapshot = {
  status: "degraded" | "not-initialized" | "ready" | "stopped";
  detail: string;
};

export type DeploymentService = {
  id: "api" | "minio" | "postgres";
  label: string;
  container: string;
  state: string;
  health: string;
  cpuPercent?: string;
  memoryUsage?: string;
  memoryPercent?: string;
  networkIO?: string;
  blockIO?: string;
  processes?: string;
  uptime?: string;
  restarts?: number;
  image?: string;
};

export type DeploymentDetails = {
  snapshot: DeploymentSnapshot;
  cliVersion: string;
  coreVersion: string;
  initializedAt: string;
  apiEndpoint: string;
  minioEndpoint: string;
  image?: string;
  services: DeploymentService[];
  performanceError?: string;
};

export type UpdateInfo = {
  cliVersion: string;
  coreVersion?: string;
  latestVersion: string;
  cliUpdateAvailable: boolean;
  coreUpdateAvailable: boolean;
};

export type UpdateScope = "all" | "cli";

export type AtlasCoreOperator = {
  checkForUpdates(): Promise<UpdateInfo>;
  configureAdminPassword(password: string): Promise<void>;
  details(): Promise<DeploymentDetails>;
  doctor(): Promise<boolean>;
  init(): Promise<void>;
  logs(service: "api" | "minio" | "postgres" | undefined, follow: boolean): Promise<void>;
  reset(): Promise<void>;
  restart(): Promise<void>;
  snapshot(): Promise<DeploymentSnapshot>;
  start(): Promise<void>;
  status(): Promise<boolean>;
  stop(): Promise<void>;
  update(scope: UpdateScope, expectedVersion?: string): Promise<void>;
};

export type InteractiveCLI = {
  configureAdmin(operator: AtlasCoreOperator): Promise<void>;
  runMenu(operator: AtlasCoreOperator): Promise<void>;
  runUpdate(operator: AtlasCoreOperator): Promise<void>;
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
  id: "configure" | "doctor" | "init" | "logs" | "quit" | "reset" | "restart" | "start" | "status" | "stop" | "update";
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
const YELLOW = "\u001b[33m";
const REVERSE = "\u001b[7m";

class NodeTerminal implements TerminalIO {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  readonly #queuedKeys: TerminalKey[] = [];
  #inputFailure: Error | undefined;
  #keypressEventsEnabled = false;
  #open = false;
  #pendingRead:
    | {
        reject: (error: Error) => void;
        resolve: (key: TerminalKey) => void;
      }
    | undefined;

  readonly #onKeypress = (sequence: string, key: Key): void => {
    const terminalKey = { ...key, sequence };
    const pendingRead = this.#pendingRead;
    if (pendingRead) {
      this.#pendingRead = undefined;
      pendingRead.resolve(terminalKey);
      return;
    }
    this.#queuedKeys.push(terminalKey);
  };

  readonly #onEnd = (): void => {
    this.#failInput(new Error("Atlas Core lost its terminal input."));
  };

  readonly #onError = (error: Error): void => {
    this.#failInput(new Error(`Atlas Core lost its terminal input: ${error.message}`));
  };

  readonly #onSighup = (): void => {
    this.#terminate("SIGHUP");
  };

  readonly #onSigterm = (): void => {
    this.#terminate("SIGTERM");
  };

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
    if (!this.#keypressEventsEnabled) {
      emitKeypressEvents(this.#input);
      this.#keypressEventsEnabled = true;
    }
    if (!this.#open) {
      this.#input.on("keypress", this.#onKeypress);
      this.#input.once("end", this.#onEnd);
      this.#input.once("error", this.#onError);
      process.once("SIGHUP", this.#onSighup);
      process.once("SIGTERM", this.#onSigterm);
      this.#open = true;
    }
    this.#input.setRawMode(true);
    this.#input.resume();
    this.write(HIDE_CURSOR);
  }

  close(): void {
    if (this.#open) {
      this.#input.off("keypress", this.#onKeypress);
      this.#input.off("end", this.#onEnd);
      this.#input.off("error", this.#onError);
      process.off("SIGHUP", this.#onSighup);
      process.off("SIGTERM", this.#onSigterm);
      this.#queuedKeys.length = 0;
      this.#open = false;
    }
    if (this.#input.isTTY && this.#input.setRawMode) this.#input.setRawMode(false);
    this.#input.pause();
    this.write(`${RESET_STYLE}${SHOW_CURSOR}`);
  }

  async readKey(): Promise<TerminalKey> {
    const queuedKey = this.#queuedKeys.shift();
    if (queuedKey) return queuedKey;
    if (this.#inputFailure) throw this.#inputFailure;
    if (this.#pendingRead) throw new Error("Atlas Core is already waiting for terminal input.");
    return await new Promise((resolve, reject) => {
      this.#pendingRead = { reject, resolve };
    });
  }

  write(data: string): void {
    this.#output.write(data);
  }

  #failInput(error: Error): void {
    this.#inputFailure ??= error;
    const pendingRead = this.#pendingRead;
    if (!pendingRead) return;
    this.#pendingRead = undefined;
    pendingRead.reject(this.#inputFailure);
  }

  #terminate(signal: "SIGHUP" | "SIGTERM"): void {
    this.close();
    process.kill(process.pid, signal);
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
    },
    runUpdate: async (operator) => {
      assertInteractive(terminal);
      terminal.open();
      try {
        await runUpdateMenu(operator, terminal);
      } finally {
        terminal.close();
      }
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
        if ((await runAction(operator, terminal, action)) === "exit") return;
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

async function runAction(
  operator: AtlasCoreOperator,
  terminal: TerminalIO,
  action: Action
): Promise<"continue" | "exit"> {
  if (action.id === "configure") {
    if ((await selectConfigureOption(terminal)) === "back") return "continue";
    terminal.write(CLEAR_SCREEN);
    terminal.write(`${BOLD}Configure > Admin account${RESET_STYLE}\nUsername: admin\n\n`);
    let password: string | undefined;
    try {
      password = await promptForPassword(terminal);
    } catch (error) {
      terminal.write(`\n${RED}${errorMessage(error)}${RESET_STYLE}\n\nPress Enter to return to the menu.`);
      await waitForReturn(terminal);
      return "continue";
    }
    if (password === undefined) {
      terminal.write("\nAdmin password unchanged.\n\nPress Enter to return to the menu.");
      await waitForReturn(terminal);
      return "continue";
    }
    await runVisibleOperation(terminal, async () => {
      await operator.configureAdminPassword(password);
    });
    return "continue";
  }

  if (action.id === "logs") {
    const service = await selectLogService(terminal);
    if (service === "cancel") return "continue";
    await runVisibleOperation(terminal, async () => {
      await operator.logs(service, false);
    });
    return "continue";
  }

  if (action.id === "status") {
    await runStatusView(operator, terminal);
    return "continue";
  }

  if (action.id === "update") {
    return (await runUpdateMenu(operator, terminal)) ? "exit" : "continue";
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
      case "stop":
        await operator.stop();
        return;
      case "configure":
      case "logs":
      case "quit":
      case "status":
      case "update":
        return;
    }
  });
  return "continue";
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

async function selectConfigureOption(terminal: TerminalIO): Promise<"admin" | "back"> {
  const choices = ["Admin account", "Back"] as const;
  let selected = 0;
  while (true) {
    terminal.write(`${CLEAR_SCREEN}${BOLD}Configure${RESET_STYLE}\n\n`);
    for (const [index, choice] of choices.entries()) {
      const line = `${index === selected ? ">" : " "} ${choice}`;
      terminal.write(index === selected ? `${REVERSE}${line}${RESET_STYLE}\n` : `${line}\n`);
    }
    terminal.write(
      `\n${DIM}${wrap("↑/↓ move   Enter select   Esc back", Math.max(44, terminal.columns)).join("\n")}${RESET_STYLE}`
    );
    const key = await terminal.readKey();
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return "back";
    if (choices.length > 0 && key.name === "up") selected = (selected - 1 + choices.length) % choices.length;
    if (choices.length > 0 && key.name === "down") selected = (selected + 1) % choices.length;
    if (key.name === "return" || key.name === "enter") return selected === 0 ? "admin" : "back";
  }
}

type StatusView = DeploymentDetails | Error;

async function runStatusView(operator: AtlasCoreOperator, terminal: TerminalIO): Promise<void> {
  let selected = 0;
  let view = await loadStatusView(operator, terminal);
  while (true) {
    if (!(view instanceof Error)) selected = Math.min(selected, Math.max(0, view.services.length - 1));
    renderStatusView(terminal, view, selected);
    const key = await terminal.readKey();
    if (
      key.name === "escape" ||
      (key.ctrl && key.name === "c") ||
      key.name === "q" ||
      key.name === "return" ||
      key.name === "enter"
    ) {
      return;
    }
    if (key.name === "r") {
      view = await loadStatusView(operator, terminal);
      continue;
    }
    if (key.name === "d") {
      await runVisibleOperation(terminal, async () => {
        await operator.doctor();
      });
      view = await loadStatusView(operator, terminal);
      continue;
    }
    if (view instanceof Error || view.services.length === 0) continue;
    if (key.name === "left" || key.name === "up") {
      selected = (selected - 1 + view.services.length) % view.services.length;
      continue;
    }
    if (key.name === "right" || key.name === "down") {
      selected = (selected + 1) % view.services.length;
      continue;
    }
    if (key.name === "l") {
      const service = view.services[selected];
      if (!service) continue;
      await runVisibleOperation(terminal, async () => {
        await operator.logs(service.id, false);
      });
      view = await loadStatusView(operator, terminal);
    }
  }
}

async function loadStatusView(operator: AtlasCoreOperator, terminal: TerminalIO): Promise<StatusView> {
  terminal.write(
    `${CLEAR_SCREEN}${BOLD}ATLAS CORE > STATUS${RESET_STYLE}\n\nLoading deployment and Docker statistics...`
  );
  try {
    return await operator.details();
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

function renderStatusView(terminal: TerminalIO, view: StatusView, selected: number): void {
  const width = Math.max(44, terminal.columns);
  terminal.write(`${CLEAR_SCREEN}${BOLD}${CYAN}ATLAS CORE > STATUS${RESET_STYLE}\n`);
  if (view instanceof Error) {
    terminal.write(`\n${RED}Status unavailable${RESET_STYLE}\n${wrap(view.message, width).join("\n")}\n`);
    terminal.write(
      `${"─".repeat(width)}\n${DIM}${wrap("r retry   d diagnostics   Enter or Esc back", width).join("\n")}${RESET_STYLE}`
    );
    return;
  }

  const state = view.snapshot.status.replace("not-initialized", "NOT INITIALIZED").toUpperCase();
  const versionStyle = view.cliVersion === view.coreVersion ? "" : YELLOW;
  terminal.write(
    `${state}  ${versionStyle}Core v${view.coreVersion}  CLI v${view.cliVersion}${versionStyle ? RESET_STYLE : ""}\n`
  );
  terminal.write(`${wrap(view.snapshot.detail, width).join("\n")}\n`);
  if (width >= 72) {
    terminal.write(`${DIM}API ${view.apiEndpoint}   MinIO ${view.minioEndpoint}${RESET_STYLE}\n`);
  } else {
    terminal.write(`${DIM}API    ${view.apiEndpoint}\nMinIO  ${view.minioEndpoint}${RESET_STYLE}\n`);
  }
  terminal.write(`${"─".repeat(width)}\n`);

  const service = view.services[selected];
  if (service) {
    terminal.write(`${BOLD}SERVICES${RESET_STYLE}  `);
    for (const [index, candidate] of view.services.entries()) {
      const label = index === selected ? `[${candidate.label}]` : candidate.label;
      terminal.write(index === selected ? `${REVERSE}${label}${RESET_STYLE}` : label);
      if (index < view.services.length - 1) terminal.write("  ");
    }
    terminal.write("\n\n");
    renderServiceDetails(terminal, service, width);
  } else {
    terminal.write(`${BOLD}SERVICES${RESET_STYLE}\nNo Atlas Core containers are running.\n`);
  }

  terminal.write(`\n${BOLD}DEPLOYMENT${RESET_STYLE}\n`);
  writeKeyValues(terminal, width, [
    ["Initialized", view.initializedAt],
    ["Image", view.image ?? "No running Core image"],
    ["Configuration", "Credentials and durable volumes preserved"]
  ]);
  if (view.performanceError) {
    const message = `Performance statistics unavailable: ${view.performanceError}`;
    terminal.write(`\n${YELLOW}${wrap(message, width).join("\n")}${RESET_STYLE}\n`);
  }
  terminal.write(`${"─".repeat(width)}\n`);
  terminal.write(
    `${DIM}${wrap("←/→ service   r refresh   l logs   d diagnostics   Enter or Esc back", width).join("\n")}${RESET_STYLE}`
  );
}

function renderServiceDetails(terminal: TerminalIO, service: DeploymentService, width: number): void {
  terminal.write(`${BOLD}${service.label}${RESET_STYLE}\n`);
  const status = `${service.state || "unknown"}${service.health ? `, ${service.health}` : ""}`;
  writeKeyValues(terminal, width, [
    ["Status", status],
    ["Container", service.container],
    ["Uptime", service.uptime ?? "Not running"],
    ["Restarts", service.restarts?.toString() ?? "Not available"],
    ["CPU", service.cpuPercent ?? "Not available"],
    ["Memory", joinMetric(service.memoryUsage, service.memoryPercent)],
    ["Network I/O", service.networkIO ?? "Not available"],
    ["Block I/O", service.blockIO ?? "Not available"],
    ["Processes", service.processes ?? "Not available"],
    ["Image", service.image ?? "Not available"]
  ]);
}

function writeKeyValues(terminal: TerminalIO, width: number, values: Array<readonly [string, string]>): void {
  const labelWidth = Math.min(14, Math.max(...values.map(([label]) => label.length)));
  const valueWidth = Math.max(20, width - labelWidth - 3);
  for (const [label, value] of values) {
    const lines = wrap(value, valueWidth);
    terminal.write(`${DIM}${pad(label, labelWidth)}${RESET_STYLE}  ${lines[0] ?? ""}\n`);
    for (const line of lines.slice(1)) terminal.write(`${" ".repeat(labelWidth + 2)}${line}\n`);
  }
}

function joinMetric(value: string | undefined, percentage: string | undefined): string {
  if (!value) return "Not available";
  return percentage ? `${value} (${percentage})` : value;
}

async function runUpdateMenu(operator: AtlasCoreOperator, terminal: TerminalIO): Promise<boolean> {
  terminal.write(`${CLEAR_SCREEN}${BOLD}ATLAS CORE > UPDATE${RESET_STYLE}\n\nChecking npm for the latest release...`);
  let info: UpdateInfo;
  try {
    info = await operator.checkForUpdates();
  } catch (error) {
    terminal.write(`${CLEAR_SCREEN}${BOLD}ATLAS CORE > UPDATE${RESET_STYLE}\n\n`);
    terminal.write(`${RED}${errorMessage(error)}${RESET_STYLE}\n\nPress Enter to return.`);
    await waitForReturn(terminal);
    return false;
  }

  const choices: Array<{ label: string; scope: UpdateScope }> = [];
  if (info.cliUpdateAvailable) choices.push({ label: "Update CLI only", scope: "cli" });
  if (info.coreVersion && (info.cliUpdateAvailable || info.coreUpdateAvailable)) {
    choices.push({ label: "Update CLI + Atlas Core", scope: "all" });
  }
  let selected = 0;
  while (true) {
    renderUpdateMenu(terminal, info, choices, selected);
    const key = await terminal.readKey();
    if (key.name === "escape" || (key.ctrl && key.name === "c") || key.name === "q") return false;
    if (key.name === "r") return await runUpdateMenu(operator, terminal);
    if (choices.length === 0 && (key.name === "return" || key.name === "enter")) return false;
    if (choices.length > 0 && key.name === "up") selected = (selected - 1 + choices.length) % choices.length;
    if (choices.length > 0 && key.name === "down") selected = (selected + 1) % choices.length;
    if ((key.name === "return" || key.name === "enter") && choices[selected]) {
      const choice = choices[selected];
      if (!choice || !(await confirmUpdate(terminal, info, choice.scope))) continue;
      return await applyUpdate(operator, terminal, choice.scope, info.latestVersion);
    }
  }
}

function renderUpdateMenu(
  terminal: TerminalIO,
  info: UpdateInfo,
  choices: Array<{ label: string; scope: UpdateScope }>,
  selected: number
): void {
  const width = Math.max(44, terminal.columns);
  terminal.write(`${CLEAR_SCREEN}${BOLD}${CYAN}ATLAS CORE > UPDATE${RESET_STYLE}\n\n`);
  terminal.write(`${DIM}Installed CLI${RESET_STYLE}  ${info.cliVersion}\n`);
  terminal.write(`${DIM}Running Core ${RESET_STYLE}  ${info.coreVersion ?? "Not initialized"}\n`);
  terminal.write(`${DIM}Latest release${RESET_STYLE}  ${info.latestVersion}\n\n`);
  if (choices.length === 0) {
    terminal.write("The CLI and Atlas Core are current.\n");
    terminal.write(`\n${DIM}${wrap("r check again   Enter or Esc back", width).join("\n")}${RESET_STYLE}`);
    return;
  }
  terminal.write(`${BOLD}CHOOSE UPDATE${RESET_STYLE}\n`);
  for (const [index, choice] of choices.entries()) {
    const line = `${index === selected ? ">" : " "} ${choice.label}`;
    terminal.write(index === selected ? `${REVERSE}${line}${RESET_STYLE}\n` : `${line}\n`);
  }
  terminal.write("\n");
  if (choices[selected]?.scope === "cli") {
    terminal.write(
      `${wrap("Install the latest CLI and leave the running Atlas Core version unchanged.", width).join("\n")}\n`
    );
  } else {
    terminal.write(
      `${wrap("Preserve credentials and durable data, install the latest CLI, then restart Atlas Core on its reviewed image.", width).join("\n")}\n`
    );
  }
  terminal.write(
    `\n${DIM}${wrap("↑/↓ move   Enter review   r check again   Esc back", width).join("\n")}${RESET_STYLE}`
  );
}

async function confirmUpdate(terminal: TerminalIO, info: UpdateInfo, scope: UpdateScope): Promise<boolean> {
  const width = Math.max(44, terminal.columns);
  terminal.write(`${CLEAR_SCREEN}${BOLD}REVIEW UPDATE${RESET_STYLE}\n\n`);
  if (scope === "cli") {
    terminal.write(`CLI ${info.cliVersion} → ${info.latestVersion}\n`);
    terminal.write(`Atlas Core stays at ${info.coreVersion ?? "not initialized"}.\n\n`);
    terminal.write(`${wrap("The current process exits after npm installs the CLI.", width).join("\n")}\n`);
  } else {
    terminal.write(`CLI ${info.cliVersion} → ${info.latestVersion}\n`);
    terminal.write(`Atlas Core ${info.coreVersion} → ${info.latestVersion}\n\n`);
    terminal.write(
      `${wrap("PostgreSQL, MinIO, credentials, and configuration are preserved. Atlas Core restarts after the image pull.", width).join("\n")}\n`
    );
  }
  terminal.write(`\n${DIM}${wrap("Enter update   Esc back", width).join("\n")}${RESET_STYLE}`);
  while (true) {
    const key = await terminal.readKey();
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return false;
    if (key.name === "return" || key.name === "enter") return true;
  }
}

async function applyUpdate(
  operator: AtlasCoreOperator,
  terminal: TerminalIO,
  scope: UpdateScope,
  expectedVersion: string
): Promise<boolean> {
  terminal.write(CLEAR_SCREEN);
  terminal.close();
  let failure: string | undefined;
  try {
    await operator.update(scope, expectedVersion);
  } catch (error) {
    failure = errorMessage(error);
    terminal.write(`\n${RED}${failure}${RESET_STYLE}\n`);
  }
  terminal.write(
    failure
      ? "\nThe update stopped without deleting Atlas Core data. Rerun atlas-core to inspect or retry.\n"
      : "\nUpdate complete. Rerun atlas-core to use the installed CLI.\n"
  );
  terminal.write("\nPress Enter to exit.");
  terminal.open();
  await waitForReturn(terminal);
  return true;
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
    terminal.write(
      `\n${DIM}${wrap("↑/↓ move   Enter select   Esc back", Math.max(44, terminal.columns)).join("\n")}${RESET_STYLE}`
    );
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
    actions.push({
      id: "update",
      label: "Update",
      detail: "Check npm and update the Atlas Core CLI."
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
        id: "update",
        label: "Update",
        detail: "Check npm, then update only the CLI or update the CLI and Atlas Core together."
      },
      {
        id: "configure",
        label: "Configure",
        detail: "Open Atlas Core configuration. Admin account settings are available here."
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
    const detail = actions[selected]?.detail ?? "No actions match the filter.";
    terminal.write(`\n${BOLD}DETAILS${RESET_STYLE}\n${wrap(detail, width).join("\n")}\n`);
  }

  terminal.write(`${"─".repeat(width)}\n`);
  terminal.write(`Filter: ${filter || `${DIM}type to filter${RESET_STYLE}`}\n`);
  terminal.write(
    `${DIM}${wrap("↑/↓ move   Enter select   Backspace edit   Esc or q quit", width).join("\n")}${RESET_STYLE}`
  );
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
  for (let word of value.split(/\s+/)) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      while (word.length > width) {
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      current = word;
      continue;
    }
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
