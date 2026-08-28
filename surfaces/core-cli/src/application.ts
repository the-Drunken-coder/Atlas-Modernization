import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-metadata.js";

const PROJECT_NAME = "atlas_core_production";
const POSTGRES_VOLUME = `${PROJECT_NAME}_postgres_data`;
const MINIO_VOLUME = `${PROJECT_NAME}_minio_data`;
const API_CONTAINER = `${PROJECT_NAME}_api`;
const POSTGRES_CONTAINER = `${PROJECT_NAME}_postgres`;
const MINIO_CONTAINER = `${PROJECT_NAME}_minio`;
const MINIO_INIT_CONTAINER = `${PROJECT_NAME}_minio_init`;
const REQUIRED_SERVICES = new Set(["api", "minio", "postgres"]);
const COMPOSE_VARIABLES = [
  "API_AUTH_KEY",
  "ATLAS_ADMIN_PASSWORD",
  "ATLAS_CORE_IMAGE",
  "CORS_ORIGINS",
  "CORS_ORIGIN_PATTERNS",
  "DATABASE_MAX_OVERFLOW",
  "DATABASE_POOL_IDLE_TIMEOUT",
  "DATABASE_POOL_PRE_PING",
  "DATABASE_POOL_RECYCLE",
  "DATABASE_POOL_SIZE",
  "DATABASE_POOL_TIMEOUT",
  "MAX_UPLOAD_SIZE_MB",
  "MAX_VIEW_SIZE_MB",
  "MINIO_BUCKET",
  "MINIO_ROOT_PASSWORD",
  "MINIO_ROOT_USER",
  "POSTGRES_PASSWORD",
  "TRUSTED_PROXY_CIDRS"
] as const;
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);
const CONFIG_SCHEMA = 1;
const COMPOSE_WAIT_SECONDS = "120";
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
  phase: "initializing" | "ready";
  initializedAt: string;
  packageVersion: string;
  dockerEngineId: string;
  initializingPid?: number;
  initializingProcessStartedAt?: string;
  startAttemptedAt?: string;
  startedAt?: string;
};

type ComposeServiceState = {
  Service: string;
  State: string;
  Health: string;
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
  readonly #initLockFile: string;
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
    this.#configDir = resolveConfigDirectory(context.env.ATLAS_CORE_HOME, context.homeDir);
    this.#envFile = join(this.#configDir, ".env");
    this.#stateFile = join(this.#configDir, "state.json");
    this.#initLockFile = join(this.#configDir, ".init.lock");
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
    const dockerEngineId = await this.#preflight();
    this.#prepareConfigDirectory();
    await this.#acquireInitLock();
    try {
      await this.#initialize(dockerEngineId);
    } finally {
      this.#releaseInitLock();
    }
  }

  async #initialize(dockerEngineId: string): Promise<void> {
    const hasEnv = existsSync(this.#envFile);
    const hasState = existsSync(this.#stateFile);
    if (hasEnv) this.#assertPrivateFile(this.#envFile);
    if (hasState) this.#assertPrivateFile(this.#stateFile);

    const existingState = this.#readState();
    if (hasState && !existingState) {
      throw new Error(`${this.#stateFile} is invalid. Initialization stopped so existing storage is not adopted.`);
    }
    if (existingState && existingState.schema !== CONFIG_SCHEMA) {
      throw new Error(`Atlas Core state schema ${existingState.schema} is not supported by this CLI.`);
    }
    if (existingState?.phase === "ready") {
      if (!hasEnv)
        throw new Error(`Atlas Core state exists without ${this.#envFile}. Restore the matching credentials.`);
      this.#assertStateMatchesRuntime(existingState, dockerEngineId);
      this.#stdout.write(`Atlas Core is already initialized at ${this.#configDir}.\n`);
      return;
    }
    if (existingState) {
      this.#assertStateMatchesRuntime(existingState, dockerEngineId);
      if (
        existingState.initializingPid !== undefined &&
        existingState.initializingProcessStartedAt !== undefined &&
        existingState.initializingPid !== process.pid &&
        processIsRunning(existingState.initializingPid)
      ) {
        const processStartedAt = await this.#processStartedAt(existingState.initializingPid);
        if (processStartedAt === existingState.initializingProcessStartedAt) {
          throw new Error(
            `Another atlas-core init process is already running with PID ${existingState.initializingPid}.`
          );
        }
      }
    }
    if (hasEnv && !existingState) {
      throw new Error(
        `Atlas Core found ${this.#envFile} without matching initialization state. ` +
          "Initialization stopped so arbitrary credentials cannot adopt existing storage."
      );
    }

    const [hasPostgres, hasMinio, hasApiContainer, hasPostgresContainer, hasMinioContainer, hasMinioInitContainer] =
      await Promise.all([
        this.#volumeExists(POSTGRES_VOLUME),
        this.#volumeExists(MINIO_VOLUME),
        this.#containerExists(API_CONTAINER),
        this.#containerExists(POSTGRES_CONTAINER),
        this.#containerExists(MINIO_CONTAINER),
        this.#containerExists(MINIO_INIT_CONTAINER)
      ]);
    if (
      !hasEnv &&
      (hasPostgres || hasMinio || hasApiContainer || hasPostgresContainer || hasMinioContainer || hasMinioInitContainer)
    ) {
      throw new Error(
        "Atlas Core found containers or durable volumes without matching CLI configuration. " +
          "Initialization stopped so existing data cannot be adopted with new credentials."
      );
    }
    if (hasEnv && (hasPostgres || hasApiContainer || hasPostgresContainer || hasMinioInitContainer)) {
      throw new Error(
        "Atlas Core found an incomplete initialization with a PostgreSQL volume. " +
          "Initialization stopped because the deployment is no longer provably new."
      );
    }

    const initializingState = await this.#writeInitializingState(dockerEngineId, existingState);
    if (!hasEnv) this.#writeConfiguration();
    if (!hasMinio) await this.#createVolume(MINIO_VOLUME, "minio_data");

    let startedMinio = false;
    try {
      this.#stdout.write("Provisioning the new durable MinIO store...\n");
      startedMinio = true;
      await this.#runComposeChecked(["up", "-d", "--wait", "--wait-timeout", COMPOSE_WAIT_SECONDS, "minio"]);
      await this.#runComposeChecked([
        "exec",
        "-T",
        "minio",
        "sh",
        "-c",
        'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'
      ]);
      const bucket = this.#readConfigValue("MINIO_BUCKET") ?? "atlas-media";
      await this.#runComposeChecked(["exec", "-T", "minio", "mc", "mb", "--ignore-existing", `local/${bucket}`]);
      await this.#runComposeChecked(["exec", "-T", "minio", "mc", "anonymous", "set", "none", `local/${bucket}`]);
      await this.#runComposeChecked(["down"]);
      startedMinio = false;
      this.#writeReadyState(initializingState);
    } catch (error) {
      if (startedMinio) {
        const cleanup = await this.#runCompose(["down"]);
        if (cleanup.status !== 0) {
          throw new Error(
            `${errorMessage(error)} Cleanup also failed: ${errorMessage(commandFailure("docker compose down", cleanup))}`
          );
        }
      }
      throw error;
    }

    this.#stdout.write(`Atlas Core initialized at ${this.#configDir}.\n`);
    this.#stdout.write(`Credentials are stored in ${this.#envFile} with owner-only permissions.\n`);
    this.#stdout.write("Run atlas-core start to start the deployment.\n");
  }

  async start(): Promise<void> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesRuntime(state, dockerEngineId);
    const needsPostgresVolume = await this.#assertStartIsSafe(state);
    if (needsPostgresVolume) await this.#createVolume(POSTGRES_VOLUME, "postgres_data");
    const attemptedState = this.#recordStartAttempt(state);
    this.#stdout.write(`Starting Atlas Core ${PACKAGE_VERSION}...\n`);
    await this.#runComposeChecked(["up", "-d", "--pull", "missing", "--wait", "--wait-timeout", COMPOSE_WAIT_SECONDS]);
    this.#recordStarted(attemptedState);
    this.#stdout.write("Atlas Core is ready.\n");
    this.#stdout.write("API:       http://127.0.0.1:8000\n");
    this.#stdout.write("MinIO UI:  http://127.0.0.1:9001\n");
  }

  async stop(): Promise<void> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesRuntime(state, dockerEngineId);
    await this.#runComposeChecked(["down"]);
    this.#stdout.write("Atlas Core stopped. Durable volumes were preserved.\n");
  }

  async restart(): Promise<void> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesRuntime(state, dockerEngineId);
    const needsPostgresVolume = await this.#assertStartIsSafe(state);
    if (needsPostgresVolume) await this.#createVolume(POSTGRES_VOLUME, "postgres_data");
    const attemptedState = this.#recordStartAttempt(state);
    await this.#runComposeChecked(["down"]);
    await this.#runComposeChecked(["up", "-d", "--pull", "missing", "--wait", "--wait-timeout", COMPOSE_WAIT_SECONDS]);
    this.#recordStarted(attemptedState);
    this.#stdout.write(`Atlas Core ${PACKAGE_VERSION} restarted and is ready.\n`);
  }

  async status(): Promise<boolean> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesRuntime(state, dockerEngineId);
    const result = await this.#runCompose(["ps", "--all", "--format", "json"]);
    if (result.status !== 0) throw commandFailure("docker compose ps", result);
    const services = parseComposeServiceStates(result.stdout);
    const failures = [...REQUIRED_SERVICES].flatMap((service) => {
      const current = services.find((candidate) => candidate.Service === service);
      if (!current) return [`${service} is missing`];
      if (current.State !== "running") return [`${service} is ${current.State || "in an unknown state"}`];
      if (current.Health !== "healthy") return [`${service} is ${current.Health || "not reporting health"}`];
      return [];
    });
    if (failures.length > 0) {
      this.#stderr.write(`Atlas Core is not ready: ${failures.join(", ")}.\n`);
      return false;
    }
    this.#stdout.write("Atlas Core is running.\n");
    return true;
  }

  async logs(service: "api" | "minio" | "postgres" | undefined, follow: boolean): Promise<void> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesRuntime(state, dockerEngineId);
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
          const dockerEngineId = oneLine(await this.#checkCommand("docker", ["info", "--format", "{{.ID}}"]));
          if (!dockerEngineId) throw new Error("Docker did not report an engine ID");
          return dockerEngineId;
        }
      },
      {
        label: "configuration",
        check: async () => {
          const state = this.#requireInitialized();
          const dockerEngineId = oneLine(await this.#checkCommand("docker", ["info", "--format", "{{.ID}}"]));
          this.#assertStateMatchesRuntime(state, dockerEngineId);
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

  async #preflight(): Promise<string> {
    if (!SUPPORTED_PLATFORMS.has(this.#platform)) {
      throw new Error(`Atlas Core supports macOS and Linux. Detected ${this.#platform}.`);
    }
    assertNodeVersion(this.#nodeVersion);
    await this.#checkCommand("docker", ["--version"]);
    await this.#checkCommand("docker", ["compose", "version"]);
    const dockerEngineId = oneLine(await this.#checkCommand("docker", ["info", "--format", "{{.ID}}"]));
    if (!dockerEngineId) throw new Error("Docker did not report an engine ID.");
    return dockerEngineId;
  }

  async #checkCommand(command: string, args: string[]): Promise<string> {
    const result = await this.#runner.run(command, args, { env: this.#env });
    if (result.status !== 0) throw commandFailure([command, ...args].join(" "), result);
    return result.stdout || result.stderr;
  }

  async #processStartedAt(pid: number): Promise<string> {
    const startedAt = oneLine(await this.#checkCommand("ps", ["-o", "lstart=", "-p", String(pid)]));
    if (!startedAt) throw new Error(`Could not identify the process running with PID ${pid}.`);
    return startedAt;
  }

  async #acquireInitLock(): Promise<void> {
    const processStartedAt = await this.#processStartedAt(process.pid);
    try {
      writePrivateFile(
        this.#initLockFile,
        `${JSON.stringify({ pid: process.pid, processStartedAt }, null, 2)}\n`,
        this.#platform,
        true
      );
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }

    this.#assertPrivateFile(this.#initLockFile);
    let owner: unknown;
    try {
      owner = JSON.parse(readFileSync(this.#initLockFile, "utf8"));
    } catch {
      owner = undefined;
    }
    if (isInitLock(owner) && processIsRunning(owner.pid)) {
      try {
        if ((await this.#processStartedAt(owner.pid)) === owner.processStartedAt) {
          throw new Error(`Another atlas-core init process is already running with PID ${owner.pid}.`);
        }
      } catch (error) {
        if (processIsRunning(owner.pid)) throw error;
      }
    }
    throw new Error(
      `Atlas Core found a stale initialization lock at ${this.#initLockFile}. ` +
        "Confirm that no atlas-core init process is running, remove that file, and run init again."
    );
  }

  #releaseInitLock(): void {
    try {
      unlinkSync(this.#initLockFile);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  async #volumeExists(name: string): Promise<boolean> {
    const volume = name === POSTGRES_VOLUME ? "postgres_data" : "minio_data";
    return await this.#ownedResourceExists("volume", name, {
      "com.docker.compose.project": PROJECT_NAME,
      "com.docker.compose.volume": volume
    });
  }

  async #createVolume(name: string, volume: "minio_data" | "postgres_data"): Promise<void> {
    await this.#checkCommand("docker", [
      "volume",
      "create",
      "--label",
      `com.docker.compose.project=${PROJECT_NAME}`,
      "--label",
      `com.docker.compose.volume=${volume}`,
      name
    ]);
    if (!(await this.#volumeExists(name))) {
      throw new Error(`Docker created ${name}, but Atlas Core could not verify the volume.`);
    }
  }

  async #containerExists(name: string): Promise<boolean> {
    const service =
      name === API_CONTAINER
        ? "api"
        : name === POSTGRES_CONTAINER
          ? "postgres"
          : name === MINIO_INIT_CONTAINER
            ? "minio-init"
            : "minio";
    return await this.#ownedResourceExists("container", name, {
      "com.docker.compose.project": PROJECT_NAME,
      "com.docker.compose.service": service
    });
  }

  async #ownedResourceExists(
    kind: "container" | "volume",
    name: string,
    expectedLabels: Record<string, string>
  ): Promise<boolean> {
    const result = await this.#runner.run("docker", [kind, "inspect", "--format", "{{json .Labels}}", name], {
      env: this.#env
    });
    if (result.status !== 0) {
      if (new RegExp(`no such ${kind}`, "i").test(result.stderr || result.stdout)) return false;
      throw commandFailure(`docker ${kind} inspect ${name}`, result);
    }

    let labels: unknown;
    try {
      labels = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Docker returned invalid ownership labels for ${kind} ${name}.`);
    }
    if (typeof labels !== "object" || labels === null) {
      throw new Error(`Atlas Core found ${kind} ${name} without Docker Compose ownership labels.`);
    }
    const record = labels as Record<string, unknown>;
    const mismatch = Object.entries(expectedLabels).find(([key, value]) => record[key] !== value);
    if (mismatch) {
      throw new Error(
        `Atlas Core found ${kind} ${name} without the expected ${mismatch[0]}=${mismatch[1]} ownership label.`
      );
    }
    return true;
  }

  async #assertStartIsSafe(state: DeploymentState): Promise<boolean> {
    const [hasPostgres, hasMinio] = await Promise.all([
      this.#volumeExists(POSTGRES_VOLUME),
      this.#volumeExists(MINIO_VOLUME)
    ]);
    if (!hasMinio || ((state.startAttemptedAt !== undefined || state.startedAt !== undefined) && !hasPostgres)) {
      throw new Error(
        "Atlas Core durable storage is missing. Start stopped so Docker Compose cannot replace it with an empty volume."
      );
    }
    return !hasPostgres;
  }

  #writeConfiguration(): void {
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
      "TRUSTED_PROXY_CIDRS=",
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
    try {
      writePrivateFile(this.#envFile, contents, this.#platform, true);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`Another atlas-core init process created ${this.#envFile}. Run init again after it exits.`);
      }
      throw error;
    }
  }

  async #writeInitializingState(
    dockerEngineId: string,
    previous: DeploymentState | undefined
  ): Promise<DeploymentState> {
    const state: DeploymentState = {
      schema: CONFIG_SCHEMA,
      phase: "initializing",
      initializedAt: previous?.initializedAt ?? this.#now().toISOString(),
      packageVersion: PACKAGE_VERSION,
      dockerEngineId,
      initializingPid: process.pid,
      initializingProcessStartedAt: await this.#processStartedAt(process.pid)
    };
    try {
      writePrivateFile(this.#stateFile, `${JSON.stringify(state, null, 2)}\n`, this.#platform, previous === undefined);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`Another atlas-core init process created ${this.#stateFile}. Run init again after it exits.`);
      }
      throw error;
    }
    return state;
  }

  #writeReadyState(state: DeploymentState): void {
    const readyState: DeploymentState = {
      ...state,
      phase: "ready"
    };
    delete readyState.initializingPid;
    delete readyState.initializingProcessStartedAt;
    writePrivateFile(this.#stateFile, `${JSON.stringify(readyState, null, 2)}\n`, this.#platform);
  }

  #recordStartAttempt(state: DeploymentState): DeploymentState {
    const attemptedState: DeploymentState = {
      ...state,
      startAttemptedAt: state.startAttemptedAt ?? this.#now().toISOString()
    };
    writePrivateFile(this.#stateFile, `${JSON.stringify(attemptedState, null, 2)}\n`, this.#platform);
    return attemptedState;
  }

  #recordStarted(state: DeploymentState): void {
    const startedState: DeploymentState = {
      ...state,
      startAttemptedAt: state.startAttemptedAt ?? this.#now().toISOString(),
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

  #requireInitialized(): DeploymentState {
    if (!existsSync(this.#configDir) || !existsSync(this.#envFile) || !existsSync(this.#stateFile)) {
      throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
    }
    this.#assertPrivateConfiguration();
    const state = this.#readState();
    if (state?.schema !== CONFIG_SCHEMA || state.phase !== "ready") {
      throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
    }
    return state;
  }

  #prepareConfigDirectory(): void {
    if (!existsSync(this.#configDir)) {
      mkdirSync(this.#configDir, { recursive: true, mode: 0o700 });
      if (this.#platform !== "win32") chmodSync(this.#configDir, 0o700);
      return;
    }
    this.#assertPrivateDirectory();
  }

  #assertPrivateConfiguration(): void {
    this.#assertPrivateDirectory();
    if (existsSync(this.#envFile)) this.#assertPrivateFile(this.#envFile);
    if (existsSync(this.#stateFile)) this.#assertPrivateFile(this.#stateFile);
  }

  #assertPrivateDirectory(): void {
    const info = lstatSync(this.#configDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${this.#configDir} must be a regular directory, not a symlink or another file type.`);
    }
    this.#assertPrivateOwnershipAndMode(this.#configDir, info, 0o700);
  }

  #assertPrivateFile(path: string): void {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${path} must be a regular file, not a symlink or another file type.`);
    }
    this.#assertPrivateOwnershipAndMode(path, info, 0o600);
  }

  #assertPrivateOwnershipAndMode(path: string, info: Stats, expectedMode: number): void {
    if (this.#platform === "win32") return;
    const currentUserId = process.getuid?.();
    if (currentUserId !== undefined && info.uid !== currentUserId) {
      throw new Error(`${path} is owned by UID ${info.uid}, not the current user.`);
    }
    const actualMode = info.mode & 0o777;
    if (actualMode !== expectedMode) {
      throw new Error(`${path} must have mode ${expectedMode.toString(8)}, not ${actualMode.toString(8)}.`);
    }
  }

  #assertStateMatchesRuntime(state: DeploymentState, dockerEngineId: string): void {
    if (state.packageVersion !== PACKAGE_VERSION) {
      throw new Error(
        `Atlas Core ${state.packageVersion} initialized this deployment, but the installed CLI is ${PACKAGE_VERSION}. ` +
          `Reinstall atlas-core@${state.packageVersion}; automatic upgrades are not supported yet.`
      );
    }
    if (state.dockerEngineId !== dockerEngineId) {
      throw new Error(
        `Atlas Core was initialized on Docker engine ${state.dockerEngineId}, but the current engine is ${dockerEngineId}. ` +
          "Restore the original Docker context before operating this deployment."
      );
    }
  }

  #readConfigValue(name: string): string | undefined {
    const line = readFileSync(this.#envFile, "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim();
    if (value === undefined) return undefined;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }

  async #runCompose(args: string[], inherit = false): Promise<CommandResult> {
    const env = { ...this.#env };
    for (const variable of COMPOSE_VARIABLES) delete env[variable];
    env.ATLAS_CORE_IMAGE = DEFAULT_IMAGE;
    return await this.#runner.run("docker", this.#composeArgs(args), {
      cwd: this.#configDir,
      env,
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

function writePrivateFile(path: string, contents: string, platform: NodeJS.Platform, exclusive = false): void {
  if (exclusive) {
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (platform !== "win32") chmodSync(path, 0o600);
    return;
  }
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
    (record.phase === "initializing" || record.phase === "ready") &&
    typeof record.initializedAt === "string" &&
    typeof record.packageVersion === "string" &&
    typeof record.dockerEngineId === "string" &&
    ((record.initializingPid === undefined && record.initializingProcessStartedAt === undefined) ||
      (typeof record.initializingPid === "number" &&
        Number.isInteger(record.initializingPid) &&
        record.initializingPid > 0 &&
        typeof record.initializingProcessStartedAt === "string")) &&
    (record.startAttemptedAt === undefined || typeof record.startAttemptedAt === "string") &&
    (record.startedAt === undefined || typeof record.startedAt === "string")
  );
}

function isInitLock(value: unknown): value is { pid: number; processStartedAt: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.processStartedAt === "string"
  );
}

function resolveConfigDirectory(configured: string | undefined, homeDir: string): string {
  if (!configured) return join(homeDir, ".atlas", "core");
  if (configured === "~") return homeDir;
  if (configured.startsWith("~/")) return resolve(homeDir, configured.slice(2));
  return resolve(configured);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function parseComposeServiceStates(stdout: string): ComposeServiceState[] {
  const output = stdout.trim();
  if (!output) return [];
  let candidates: unknown[];
  try {
    const value: unknown = JSON.parse(output);
    candidates = Array.isArray(value) ? value : [value];
  } catch {
    try {
      candidates = output.split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new Error("Docker Compose returned invalid JSON from ps.");
    }
  }
  return candidates.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("Docker Compose returned an invalid service from ps.");
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.Service !== "string" || typeof record.State !== "string" || typeof record.Health !== "string") {
      throw new Error("Docker Compose returned an incomplete service from ps.");
    }
    return { Service: record.Service, State: record.State, Health: record.Health };
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
