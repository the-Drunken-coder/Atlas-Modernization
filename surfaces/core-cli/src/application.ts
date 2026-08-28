import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-metadata.js";

const PROJECT_NAME = "atlas_core_production";
const POSTGRES_VOLUME = `${PROJECT_NAME}_postgres_data`;
const MINIO_VOLUME = `${PROJECT_NAME}_minio_data`;
const API_CONTAINER = `${PROJECT_NAME}_api`;
const POSTGRES_CONTAINER = `${PROJECT_NAME}_postgres`;
const MINIO_CONTAINER = `${PROJECT_NAME}_minio`;
const REQUIRED_SERVICES = new Set(["api", "minio", "postgres"]);
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);
const CONFIG_SCHEMA = 1;
const DEFAULT_IMAGE = `ghcr.io/the-drunken-coder/atlas-core:${PACKAGE_VERSION}`;

const usage = `Atlas Core ${PACKAGE_VERSION}

Usage:
  atlas-core init
  atlas-core start
  atlas-core stop
  atlas-core restart
  atlas-core status
  atlas-core logs [core|postgres|minio] [--follow]
  atlas-core doctor
  atlas-core version
  atlas-core help

Atlas Core stores durable configuration in ~/.atlas/core by default.
Set ATLAS_CORE_HOME to use a different directory.
`;

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
};

export type CommandRunner = {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
};

export type CLIContext = {
  stdout?: { write(data: string): void };
  stderr?: { write(data: string): void };
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  homeDir?: string;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  now?: () => Date;
  createSecret?: () => string;
};

type Command =
  | { kind: "doctor" }
  | { kind: "help" }
  | { kind: "init" }
  | { kind: "logs"; service?: "api" | "minio" | "postgres"; follow: boolean }
  | { kind: "restart" }
  | { kind: "start" }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "version" };

type DeploymentState = {
  schema: number;
  initializedAt: string;
  packageVersion: string;
  startedAt?: string;
};

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

class ProcessCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => {
        resolve({ status: status ?? 1, stdout, stderr });
      });
    });
  }
}

class AtlasCoreDeployment {
  readonly #configDir: string;
  readonly #envFile: string;
  readonly #stateFile: string;
  readonly #composeFile: string;
  readonly #runner: CommandRunner;
  readonly #stdout: { write(data: string): void };
  readonly #stderr: { write(data: string): void };
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #nodeVersion: string;
  readonly #now: () => Date;
  readonly #createSecret: () => string;

  constructor(context: RequiredRuntimeContext) {
    this.#configDir = context.env.ATLAS_CORE_HOME || join(context.homeDir, ".atlas", "core");
    this.#envFile = join(this.#configDir, ".env");
    this.#stateFile = join(this.#configDir, "state.json");
    this.#composeFile = join(context.packageRoot, "assets", "docker-compose.yml");
    this.#runner = context.runner;
    this.#stdout = context.stdout;
    this.#stderr = context.stderr;
    this.#env = context.env;
    this.#platform = context.platform;
    this.#nodeVersion = context.nodeVersion;
    this.#now = context.now;
    this.#createSecret = context.createSecret;
  }

  async init(): Promise<void> {
    await this.#preflight();
    if (this.#isInitialized()) {
      this.#stdout.write(`Atlas Core is already initialized at ${this.#configDir}.\n`);
      return;
    }

    const hasEnv = existsSync(this.#envFile);
    const [hasPostgres, hasMinio, hasApiContainer, hasPostgresContainer, hasMinioContainer] = await Promise.all([
      this.#volumeExists(POSTGRES_VOLUME),
      this.#volumeExists(MINIO_VOLUME),
      this.#containerExists(API_CONTAINER),
      this.#containerExists(POSTGRES_CONTAINER),
      this.#containerExists(MINIO_CONTAINER)
    ]);
    if (!hasEnv && (hasPostgres || hasMinio || hasApiContainer || hasPostgresContainer || hasMinioContainer)) {
      throw new Error(
        "Atlas Core found containers or durable volumes without matching CLI configuration. " +
          "Initialization stopped so existing data cannot be adopted with new credentials."
      );
    }
    if (hasEnv && (hasPostgres || hasApiContainer || hasPostgresContainer)) {
      throw new Error(
        "Atlas Core found an incomplete initialization with a PostgreSQL volume. " +
          "Initialization stopped because the deployment is no longer provably new."
      );
    }

    if (!hasEnv) this.#writeConfiguration();

    let startedMinio = false;
    try {
      this.#stdout.write("Provisioning the new durable MinIO store...\n");
      await this.#runComposeChecked(["up", "-d", "--wait", "minio"]);
      startedMinio = true;
      const bucket = this.#readConfigValue("MINIO_BUCKET") ?? "atlas-media";
      await this.#runComposeChecked(["exec", "-T", "minio", "mc", "mb", "--ignore-existing", `local/${bucket}`]);
      await this.#runComposeChecked(["exec", "-T", "minio", "mc", "anonymous", "set", "none", `local/${bucket}`]);
      await this.#runComposeChecked(["down", "--remove-orphans"]);
      startedMinio = false;
      this.#writeState();
    } finally {
      if (startedMinio) {
        await this.#runCompose(["down", "--remove-orphans"]);
      }
    }

    this.#stdout.write(`Atlas Core initialized at ${this.#configDir}.\n`);
    this.#stdout.write(`Credentials are stored in ${this.#envFile} with owner-only permissions.\n`);
    this.#stdout.write("Run atlas-core start to start the deployment.\n");
  }

  async start(): Promise<void> {
    const state = this.#requireInitialized();
    await this.#preflight();
    await this.#assertStartIsSafe(state);
    this.#stdout.write(`Starting Atlas Core ${PACKAGE_VERSION}...\n`);
    await this.#runComposeChecked(["up", "-d", "--pull", "missing", "--wait"]);
    this.#recordStarted(state);
    this.#stdout.write("Atlas Core is ready.\n");
    this.#stdout.write("API:       http://127.0.0.1:8000\n");
    this.#stdout.write("MinIO UI:  http://127.0.0.1:9001\n");
  }

  async stop(): Promise<void> {
    this.#requireInitialized();
    await this.#preflight();
    await this.#runComposeChecked(["down", "--remove-orphans"]);
    this.#stdout.write("Atlas Core stopped. Durable volumes were preserved.\n");
  }

  async restart(): Promise<void> {
    const state = this.#requireInitialized();
    await this.#preflight();
    await this.#assertStartIsSafe(state);
    await this.#runComposeChecked(["down", "--remove-orphans"]);
    await this.#runComposeChecked(["up", "-d", "--pull", "missing", "--wait"]);
    this.#recordStarted(state);
    this.#stdout.write(`Atlas Core ${PACKAGE_VERSION} restarted and is ready.\n`);
  }

  async status(): Promise<boolean> {
    this.#requireInitialized();
    await this.#preflight();
    const result = await this.#runCompose(["ps", "--status", "running", "--services"]);
    if (result.status !== 0) throw commandFailure("docker compose ps", result);
    if (result.stdout) this.#stdout.write(result.stdout);
    const running = new Set(result.stdout.split(/\s+/).filter(Boolean));
    const missing = [...REQUIRED_SERVICES].filter((service) => !running.has(service));
    if (missing.length > 0) {
      this.#stderr.write(`Atlas Core is not ready. Missing running services: ${missing.join(", ")}.\n`);
      return false;
    }
    this.#stdout.write("Atlas Core is running.\n");
    return true;
  }

  async logs(service: "api" | "minio" | "postgres" | undefined, follow: boolean): Promise<void> {
    this.#requireInitialized();
    await this.#preflight();
    const args = ["logs", "--tail", "200"];
    if (follow) args.push("--follow");
    if (service) args.push(service);
    const result = await this.#runCompose(args, true);
    if (result.status !== 0) throw commandFailure("docker compose logs", result);
  }

  async doctor(): Promise<boolean> {
    const checks: Array<{ label: string; check: () => Promise<string> }> = [
      {
        label: "platform",
        check: async () => {
          if (!SUPPORTED_PLATFORMS.has(this.#platform)) throw new Error(`${this.#platform} is not supported yet`);
          return this.#platform;
        }
      },
      {
        label: "Node.js",
        check: async () => {
          assertNodeVersion(this.#nodeVersion);
          return this.#nodeVersion;
        }
      },
      {
        label: "Docker",
        check: async () => oneLine(await this.#checkCommand("docker", ["--version"]))
      },
      {
        label: "Docker Compose",
        check: async () => oneLine(await this.#checkCommand("docker", ["compose", "version"]))
      },
      {
        label: "Docker daemon",
        check: async () => {
          await this.#checkCommand("docker", ["info"]);
          return "available";
        }
      },
      {
        label: "configuration",
        check: async () => {
          this.#requireInitialized();
          if (this.#platform !== "win32" && (statSync(this.#envFile).mode & 0o077) !== 0) {
            throw new Error(`${this.#envFile} is readable by other users`);
          }
          await this.#runComposeChecked(["config", "--quiet"]);
          return this.#configDir;
        }
      }
    ];

    let healthy = true;
    for (const item of checks) {
      try {
        this.#stdout.write(`[ok] ${item.label}: ${await item.check()}\n`);
      } catch (error) {
        healthy = false;
        this.#stderr.write(`[fail] ${item.label}: ${errorMessage(error)}\n`);
      }
    }
    return healthy;
  }

  async #preflight(): Promise<void> {
    if (!SUPPORTED_PLATFORMS.has(this.#platform)) {
      throw new Error(`Atlas Core supports macOS and Linux. Detected ${this.#platform}.`);
    }
    assertNodeVersion(this.#nodeVersion);
    await this.#checkCommand("docker", ["--version"]);
    await this.#checkCommand("docker", ["compose", "version"]);
    await this.#checkCommand("docker", ["info"]);
  }

  async #checkCommand(command: string, args: string[]): Promise<string> {
    const result = await this.#runner.run(command, args, { env: this.#env });
    if (result.status !== 0) throw commandFailure([command, ...args].join(" "), result);
    return result.stdout || result.stderr;
  }

  async #volumeExists(name: string): Promise<boolean> {
    const result = await this.#runner.run("docker", ["volume", "inspect", name], { env: this.#env });
    return result.status === 0;
  }

  async #containerExists(name: string): Promise<boolean> {
    const result = await this.#runner.run("docker", ["container", "inspect", name], { env: this.#env });
    return result.status === 0;
  }

  async #assertStartIsSafe(state: DeploymentState): Promise<void> {
    if (state.packageVersion !== PACKAGE_VERSION) {
      throw new Error(
        `Atlas Core ${state.packageVersion} initialized this deployment, but the installed CLI is ${PACKAGE_VERSION}. ` +
          `Reinstall atlas-core@${state.packageVersion}; automatic upgrades are not supported yet.`
      );
    }
    const [hasPostgres, hasMinio] = await Promise.all([
      this.#volumeExists(POSTGRES_VOLUME),
      this.#volumeExists(MINIO_VOLUME)
    ]);
    if (!hasMinio || (state.startedAt !== undefined && !hasPostgres)) {
      throw new Error(
        "Atlas Core durable storage is missing. Start stopped so Docker Compose cannot replace it with an empty volume."
      );
    }
  }

  #writeConfiguration(): void {
    mkdirSync(this.#configDir, { recursive: true, mode: 0o700 });
    if (this.#platform !== "win32") chmodSync(this.#configDir, 0o700);
    const contents = [
      "# Generated by atlas-core init. Keep this file private and back it up securely.",
      `POSTGRES_PASSWORD=${this.#createSecret()}`,
      "MINIO_ROOT_USER=atlas",
      `MINIO_ROOT_PASSWORD=${this.#createSecret()}`,
      "MINIO_BUCKET=atlas-media",
      `API_AUTH_KEY=${this.#createSecret()}`,
      `ATLAS_ADMIN_PASSWORD=${this.#createSecret()}`,
      "CORS_ORIGINS=https://atlasinterface.com",
      "CORS_ORIGIN_PATTERNS=https://*.atlas-je0.pages.dev",
      "",
      "# Optional tuning",
      "DATABASE_POOL_SIZE=5",
      "DATABASE_MAX_OVERFLOW=10",
      "DATABASE_POOL_RECYCLE=3600",
      "DATABASE_POOL_TIMEOUT=30",
      "DATABASE_POOL_IDLE_TIMEOUT=600",
      "DATABASE_POOL_PRE_PING=true",
      "MAX_UPLOAD_SIZE_MB=100",
      "MAX_VIEW_SIZE_MB=10",
      ""
    ].join("\n");
    writePrivateFile(this.#envFile, contents, this.#platform);
  }

  #writeState(): void {
    const state: DeploymentState = {
      schema: CONFIG_SCHEMA,
      initializedAt: this.#now().toISOString(),
      packageVersion: PACKAGE_VERSION
    };
    writePrivateFile(this.#stateFile, `${JSON.stringify(state, null, 2)}\n`, this.#platform);
  }

  #recordStarted(state: DeploymentState): void {
    const startedState: DeploymentState = {
      ...state,
      startedAt: state.startedAt ?? this.#now().toISOString()
    };
    writePrivateFile(this.#stateFile, `${JSON.stringify(startedState, null, 2)}\n`, this.#platform);
  }

  #readState(): DeploymentState | undefined {
    if (!existsSync(this.#stateFile)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(this.#stateFile, "utf8"));
      if (!isDeploymentState(value)) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  #isInitialized(): boolean {
    const state = this.#readState();
    return existsSync(this.#envFile) && state?.schema === CONFIG_SCHEMA;
  }

  #requireInitialized(): DeploymentState {
    const state = this.#readState();
    if (!existsSync(this.#envFile) || state?.schema !== CONFIG_SCHEMA) {
      throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
    }
    return state;
  }

  #readConfigValue(name: string): string | undefined {
    const line = readFileSync(this.#envFile, "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(`${name}=`));
    return line?.slice(name.length + 1);
  }

  async #runCompose(args: string[], inherit = false): Promise<CommandResult> {
    return await this.#runner.run("docker", this.#composeArgs(args), {
      cwd: this.#configDir,
      env: { ...this.#env, ATLAS_CORE_IMAGE: DEFAULT_IMAGE },
      inherit
    });
  }

  async #runComposeChecked(args: string[]): Promise<void> {
    const result = await this.#runCompose(args);
    if (result.status !== 0) throw commandFailure(`docker ${this.#composeArgs(args).join(" ")}`, result);
  }

  #composeArgs(args: string[]): string[] {
    return [
      "compose",
      "--project-name",
      PROJECT_NAME,
      "--env-file",
      this.#envFile,
      "--file",
      this.#composeFile,
      ...args
    ];
  }
}

type RequiredRuntimeContext = {
  stdout: { write(data: string): void };
  stderr: { write(data: string): void };
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  homeDir: string;
  packageRoot: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  now: () => Date;
  createSecret: () => string;
};

export async function runCLI(argv: string[], context: CLIContext = {}): Promise<number> {
  const runtime = defaultContext(context);
  try {
    const command = parseCommand(argv);
    if (command.kind === "help") {
      runtime.stdout.write(usage);
      return 0;
    }
    if (command.kind === "version") {
      runtime.stdout.write(`${PACKAGE_NAME} ${PACKAGE_VERSION}\n`);
      return 0;
    }

    const deployment = new AtlasCoreDeployment(runtime);
    switch (command.kind) {
      case "doctor":
        return (await deployment.doctor()) ? 0 : 1;
      case "init":
        await deployment.init();
        return 0;
      case "logs":
        await deployment.logs(command.service, command.follow);
        return 0;
      case "restart":
        await deployment.restart();
        return 0;
      case "start":
        await deployment.start();
        return 0;
      case "status":
        return (await deployment.status()) ? 0 : 1;
      case "stop":
        await deployment.stop();
        return 0;
      default:
        return assertNever(command);
    }
  } catch (error) {
    runtime.stderr.write(`${errorMessage(error)}\n`);
    if (error instanceof UsageError) runtime.stderr.write(usage);
    return error instanceof UsageError ? 2 : 1;
  }
}

function parseCommand(argv: string[]): Command {
  if (argv.length === 0 || (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0] ?? ""))) {
    return { kind: "help" };
  }
  const [name, ...args] = argv;
  switch (name) {
    case "doctor":
    case "init":
    case "restart":
    case "start":
    case "status":
    case "stop":
    case "version":
      if (args.length > 0) throw new UsageError(`${name} does not accept arguments`);
      return { kind: name };
    case "logs":
      return parseLogs(args);
    default:
      throw new UsageError(`Unknown command: ${name ?? ""}`);
  }
}

function parseLogs(args: string[]): Extract<Command, { kind: "logs" }> {
  let service: "api" | "minio" | "postgres" | undefined;
  let follow = false;
  for (const arg of args) {
    if (arg === "--follow" || arg === "-f") {
      follow = true;
      continue;
    }
    if (service) throw new UsageError("logs accepts at most one service");
    if (arg === "core" || arg === "api") service = "api";
    else if (arg === "postgres" || arg === "minio") service = arg;
    else throw new UsageError(`Unknown logs service: ${arg}`);
  }
  return service === undefined ? { kind: "logs", follow } : { kind: "logs", service, follow };
}

function defaultContext(context: CLIContext): RequiredRuntimeContext {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  return {
    stdout: context.stdout ?? process.stdout,
    stderr: context.stderr ?? process.stderr,
    env: context.env ?? process.env,
    runner: context.runner ?? new ProcessCommandRunner(),
    homeDir: context.homeDir ?? homedir(),
    packageRoot: context.packageRoot ?? dirname(currentDirectory),
    platform: context.platform ?? process.platform,
    nodeVersion: context.nodeVersion ?? process.versions.node,
    now: context.now ?? (() => new Date()),
    createSecret: context.createSecret ?? (() => randomBytes(32).toString("base64url"))
  };
}

function writePrivateFile(path: string, contents: string, platform: NodeJS.Platform): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, path);
  if (platform !== "win32") chmodSync(path, 0o600);
}

function isDeploymentState(value: unknown): value is DeploymentState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.schema === "number" &&
    typeof record.initializedAt === "string" &&
    typeof record.packageVersion === "string" &&
    (record.startedAt === undefined || typeof record.startedAt === "string")
  );
}

function assertNodeVersion(version: string): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`Atlas Core requires Node.js 24 or newer. Detected ${version}.`);
  }
}

function commandFailure(command: string, result: CommandResult): Error {
  const detail = oneLine(result.stderr || result.stdout);
  return new Error(`${command} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
}

function oneLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command: ${JSON.stringify(value)}`);
}
