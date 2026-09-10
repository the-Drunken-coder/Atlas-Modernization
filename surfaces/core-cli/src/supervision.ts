import { dirname, isAbsolute, join } from "node:path";

const DEFAULT_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;
const MIN_INTERVAL_MS = 10;

export type SupervisorTick = () => void | Promise<void>;

export type SupervisorLoopOptions = {
  tick: SupervisorTick;
  signal?: AbortSignal;
  onError?: (error: unknown) => void | Promise<void>;
  intervalMs?: number;
};

/**
 * Runs manager recovery one tick at a time. The callback owns all durable
 * intent, locking, and Docker validation. This loop only schedules it and
 * reports failures, so it can never issue a Docker restart itself.
 *
 * A successful tick returns to the configured cadence. Failed ticks use a
 * bounded exponential delay. Errors from the observer are swallowed so an
 * accidentally failing logger cannot turn the supervisor into a hot loop.
 */
export async function runSupervisor(options: SupervisorLoopOptions): Promise<void> {
  const intervalMs = normalizeInterval(options.intervalMs);
  let delayMs = intervalMs;

  while (!options.signal?.aborted) {
    try {
      await options.tick();
      delayMs = intervalMs;
    } catch (error) {
      try {
        await options.onError?.(error);
      } catch {
        // Observing a failed tick must never stop recovery or cause a spin.
      }
      delayMs = Math.min(delayMs * 2, MAX_BACKOFF_MS);
    }

    if (options.signal?.aborted) return;
    await waitFor(delayMs, options.signal);
  }
}

function normalizeInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined) return DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError("Supervisor intervalMs must be a finite non-negative number.");
  }
  return Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs));
}

function waitFor(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export type SupervisorPlatform = "darwin" | "linux";

export type SupervisorCommandResult = {
  status: number;
  stdout?: string;
  stderr?: string;
};

/** A deliberately shell-free command boundary for service-manager calls. */
export type SupervisorCommandRunner = (command: string, args: readonly string[]) => Promise<SupervisorCommandResult>;

/** The small host filesystem surface needed by service installation. */
export type SupervisorFileSystem = {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  writeFile(path: string, contents: string, options?: { mode?: number }): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
};

export type SupervisorDefinitionOptions = {
  platform: SupervisorPlatform;
  homeDirectory: string;
  coreHome: string;
  nodeExecutable: string;
  cliScript: string;
  userId?: string;
};

export type SupervisorServiceDefinition = {
  platform: SupervisorPlatform;
  serviceName: string;
  servicePath: string;
  command: readonly [string, string, "supervise"];
  environment: Readonly<{ ATLAS_CORE_HOME: string; PATH: string }>;
  content: string;
  sessionScope: "user";
  startsWithoutLogin: boolean;
  requiredPrivileges: "none";
  limitations: readonly string[];
};

export const MACOS_SERVICE_NAME = "com.the-drunken-coder.atlas-core.supervisor";
export const LINUX_SERVICE_NAME = "atlas-core-supervisor.service";

/**
 * Purely creates the service-manager file. It never touches a host or invokes
 * launchctl/systemctl. The command uses the exact Node executable and the
 * installed CLI script supplied by the caller.
 */
export function generateSupervisorDefinition(options: SupervisorDefinitionOptions): SupervisorServiceDefinition {
  validateDefinitionOptions(options);
  const environment = {
    ATLAS_CORE_HOME: options.coreHome,
    PATH: supervisorPath(options)
  } as const;
  if (options.platform === "darwin") {
    const servicePath = join(options.homeDirectory, "Library", "LaunchAgents", `${MACOS_SERVICE_NAME}.plist`);
    return {
      platform: options.platform,
      serviceName: MACOS_SERVICE_NAME,
      servicePath,
      command: [options.nodeExecutable, options.cliScript, "supervise"],
      environment,
      content: generateLaunchdPlist(options, environment),
      sessionScope: "user",
      startsWithoutLogin: false,
      requiredPrivileges: "none",
      limitations: [
        "The LaunchAgent runs only in the logged-in user's GUI session.",
        "It does not start Atlas at boot before that user logs in."
      ]
    };
  }

  const servicePath = join(options.homeDirectory, ".config", "systemd", "user", LINUX_SERVICE_NAME);
  return {
    platform: options.platform,
    serviceName: LINUX_SERVICE_NAME,
    servicePath,
    command: [options.nodeExecutable, options.cliScript, "supervise"],
    environment,
    content: generateSystemdUnit(options, environment),
    sessionScope: "user",
    startsWithoutLogin: false,
    requiredPrivileges: "none",
    limitations: [
      "The systemd user manager must be available for the target user.",
      "Without user lingering, the service starts when the user logs in and stops when the last session ends.",
      "Run loginctl enable-linger for the user when boot-time operation without login is required; this may require administrator privileges."
    ]
  };
}

function supervisorPath(options: SupervisorDefinitionOptions): string {
  return [
    dirname(options.nodeExecutable),
    join(options.homeDirectory, ".docker", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].join(":");
}

function validateDefinitionOptions(options: SupervisorDefinitionOptions): void {
  for (const [name, value] of Object.entries({
    homeDirectory: options.homeDirectory,
    coreHome: options.coreHome,
    nodeExecutable: options.nodeExecutable,
    cliScript: options.cliScript
  })) {
    if (!isAbsolute(value)) throw new Error(`Supervisor ${name} must be an absolute path.`);
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new Error(`Supervisor ${name} contains an invalid path character.`);
    }
  }
  if (options.platform === "darwin" && !options.userId) {
    throw new Error("Supervisor userId is required for a macOS LaunchAgent.");
  }
  if (options.userId !== undefined && !/^[0-9]+$/.test(options.userId)) {
    throw new Error("Supervisor userId must be a numeric user ID.");
  }
}

function generateLaunchdPlist(
  options: SupervisorDefinitionOptions,
  environment: Readonly<{ ATLAS_CORE_HOME: string; PATH: string }>
): string {
  const args: readonly [string, string, "supervise"] = [options.nodeExecutable, options.cliScript, "supervise"];
  const argumentsXml = args.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ATLAS_CORE_HOME</key>
    <string>${escapeXml(environment.ATLAS_CORE_HOME)}</string>
    <key>PATH</key>
    <string>${escapeXml(environment.PATH)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

function generateSystemdUnit(
  options: SupervisorDefinitionOptions,
  environment: Readonly<{ ATLAS_CORE_HOME: string; PATH: string }>
): string {
  const command = [options.nodeExecutable, options.cliScript, "supervise"].map(escapeSystemdExecArg).join(" ");
  return `[Unit]
Description=Atlas Core supervisor

[Service]
Type=simple
ExecStart=${command}
Environment=${escapeSystemdEnvironment("ATLAS_CORE_HOME", environment.ATLAS_CORE_HOME)}
Environment=${escapeSystemdEnvironment("PATH", environment.PATH)}
Restart=always
RestartSec=10s

[Install]
WantedBy=default.target
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeSystemdExecArg(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function escapeSystemdEnvironment(name: string, value: string): string {
  return `"${name}=${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export type SupervisorInstallOptions = SupervisorDefinitionOptions & {
  filesystem: SupervisorFileSystem;
  runner: SupervisorCommandRunner;
};

export type SupervisorInstallResult = {
  definition: SupervisorServiceDefinition;
  started: true;
};

export type SupervisorStatus = {
  definition: SupervisorServiceDefinition;
  installed: boolean;
  loaded: boolean;
  running: boolean | undefined;
  enabled: boolean | undefined;
  userManagerAvailable: boolean | undefined;
  sessionRequired: true;
  startsWithoutLogin: false;
  message: string;
};

/**
 * Installs and starts a user service through the supplied adapters. This
 * function never enables lingering automatically and never uses a privileged
 * service manager scope.
 */
export async function installSupervisor(options: SupervisorInstallOptions): Promise<SupervisorInstallResult> {
  const definition = generateSupervisorDefinition(options);
  await options.filesystem.mkdir(dirname(definition.servicePath), { recursive: true, mode: 0o700 });
  await options.filesystem.writeFile(definition.servicePath, definition.content, { mode: 0o600 });

  if (definition.platform === "darwin") {
    const domain = `gui/${options.userId}`;
    await runChecked(
      options.runner,
      "launchctl",
      ["bootout", domain, definition.servicePath],
      "unload existing LaunchAgent",
      {
        acceptedStatuses: [0, 3]
      }
    );
    await runChecked(options.runner, "launchctl", ["bootstrap", domain, definition.servicePath], "load LaunchAgent");
    await runChecked(
      options.runner,
      "launchctl",
      ["enable", `${domain}/${definition.serviceName}`],
      "enable LaunchAgent"
    );
  } else {
    await runChecked(options.runner, "systemctl", ["--user", "daemon-reload"], "reload systemd user units");
    await runChecked(
      options.runner,
      "systemctl",
      ["--user", "enable", definition.serviceName],
      "enable systemd user service"
    );
    await runChecked(
      options.runner,
      "systemctl",
      ["--user", "restart", definition.serviceName],
      "start systemd user service"
    );
  }

  return { definition, started: true };
}

export type SupervisorUninstallOptions = SupervisorInstallOptions;

export async function uninstallSupervisor(options: SupervisorUninstallOptions): Promise<SupervisorServiceDefinition> {
  const definition = generateSupervisorDefinition(options);
  if (definition.platform === "darwin") {
    const domain = `gui/${options.userId}`;
    await runChecked(options.runner, "launchctl", ["bootout", domain, definition.servicePath], "unload LaunchAgent", {
      acceptedStatuses: [0, 3]
    });
  } else {
    await runChecked(options.runner, "systemctl", ["--user", "daemon-reload"], "contact systemd user manager");
    await runChecked(
      options.runner,
      "systemctl",
      ["--user", "disable", "--now", definition.serviceName],
      "stop systemd user service",
      {
        acceptedStatuses: [0, 1, 3, 5]
      }
    );
  }
  await options.filesystem.rm(definition.servicePath, { force: true });
  return definition;
}

export async function getSupervisorStatus(options: SupervisorInstallOptions): Promise<SupervisorStatus> {
  const definition = generateSupervisorDefinition(options);
  const installed = await options.filesystem.exists(definition.servicePath);
  if (definition.platform === "darwin") {
    const result = await options.runner("launchctl", ["print", `gui/${options.userId}/${definition.serviceName}`]);
    const loaded = result.status === 0;
    const userManagerAvailable =
      result.status === 0 ||
      !/could not find service|domain does not exist|unknown service|not found/i.test(result.stderr ?? "");
    return {
      definition,
      installed,
      loaded,
      running: loaded ? /\bstate\s*=\s*running\b/.test(result.stdout ?? "") : undefined,
      enabled: undefined,
      userManagerAvailable,
      sessionRequired: true,
      startsWithoutLogin: false,
      message: loaded
        ? "The Atlas Core LaunchAgent is loaded in the current user's GUI session."
        : installed
          ? "The LaunchAgent file exists but is not loaded; a logged-in GUI session is required."
          : "The Atlas Core LaunchAgent is not installed."
    };
  }

  const active = await options.runner("systemctl", ["--user", "is-active", definition.serviceName]);
  const enabled = await options.runner("systemctl", ["--user", "is-enabled", definition.serviceName]);
  const userManagerAvailable = userManagerAvailability(active, enabled);
  const loaded = active.status === 0 || enabled.status === 0;
  const running = active.status === 0 ? true : active.status === 3 ? false : undefined;
  return {
    definition,
    installed,
    loaded,
    running,
    enabled: enabled.status === 0 ? true : enabled.status === 1 || enabled.status === 3 ? false : undefined,
    userManagerAvailable,
    sessionRequired: true,
    startsWithoutLogin: false,
    message: !userManagerAvailable
      ? "The systemd user manager is unavailable for this user; login or user lingering is required."
      : loaded
        ? running
          ? "The Atlas Core systemd user service is running."
          : "The Atlas Core systemd user service is installed but inactive."
        : installed
          ? "The systemd user unit exists but is not enabled or loaded."
          : "The Atlas Core systemd user service is not installed."
  };
}

function userManagerAvailability(
  active: SupervisorCommandResult,
  enabled: SupervisorCommandResult
): boolean | undefined {
  if (active.status === 127 || enabled.status === 127) return false;
  const output = `${active.stderr ?? ""}\n${enabled.stderr ?? ""}`;
  if (
    /failed to connect to bus|no medium found|not been booted with systemd|cannot access user manager/i.test(output)
  ) {
    return false;
  }
  if (active.status === 0 || enabled.status === 0 || active.status === 3 || enabled.status === 3) return true;
  return undefined;
}

async function runChecked(
  runner: SupervisorCommandRunner,
  command: string,
  args: readonly string[],
  action: string,
  options: { acceptedStatuses?: readonly number[] } = {}
): Promise<void> {
  const result = await runner(command, args);
  const acceptedStatuses = options.acceptedStatuses ?? [0];
  if (!acceptedStatuses.includes(result.status)) {
    const detail = (result.stderr ?? result.stdout ?? "").trim();
    throw new Error(`Could not ${action}: ${detail || `command exited with status ${result.status}`}`);
  }
}
