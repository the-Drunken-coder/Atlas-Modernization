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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { PACKAGE_IMAGE, PACKAGE_NAME, PACKAGE_VERSION } from "./package-metadata.js";
import {
  type AtlasCoreOperator,
  createInteractiveCLI,
  type DeploymentDetails,
  type DeploymentService,
  type DeploymentSnapshot,
  type InteractiveCLI,
  type UpdateInfo,
  type UpdateScope
} from "./terminal-ui.js";

const PROJECT_NAME = "atlas_core_production";
const POSTGRES_VOLUME = `${PROJECT_NAME}_postgres_data`;
const MINIO_VOLUME = `${PROJECT_NAME}_minio_data`;
const API_CONTAINER = `${PROJECT_NAME}_api`;
const SOURCE_GATEWAY_CONTAINER = `${PROJECT_NAME}_source_gateway`;
const POSTGRES_CONTAINER = `${PROJECT_NAME}_postgres`;
const MINIO_CONTAINER = `${PROJECT_NAME}_minio`;
const MINIO_INIT_CONTAINER = `${PROJECT_NAME}_minio_init`;
const INIT_LOCK_NETWORK = `${PROJECT_NAME}_init_lock`;
const RESET_CONTAINERS = [
  API_CONTAINER,
  SOURCE_GATEWAY_CONTAINER,
  POSTGRES_CONTAINER,
  MINIO_CONTAINER,
  MINIO_INIT_CONTAINER
] as const;
const RESET_VOLUMES = [POSTGRES_VOLUME, MINIO_VOLUME] as const;
const RESET_CONTAINER_NAMES = new Set<string>(RESET_CONTAINERS);
const REQUIRED_SERVICES = new Set(["api", "source-gateway", "minio", "postgres"]);
const SERVICES = [
  { id: "api", label: "Core API", container: API_CONTAINER },
  { id: "source-gateway", label: "Source Gateway", container: SOURCE_GATEWAY_CONTAINER },
  { id: "postgres", label: "PostgreSQL", container: POSTGRES_CONTAINER },
  { id: "minio", label: "MinIO", container: MINIO_CONTAINER }
] as const;
const COMPOSE_VARIABLES = [
  "API_AUTH_KEY",
  "ATLAS_ADMIN_PASSWORD",
  "ATLAS_CORE_IMAGE",
  "ATLAS_PLUGINS",
  "ATLAS_SOURCE_GATEWAY_CONFIG_FILE",
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
const SUPPORTED_ARCHITECTURES = new Set<NodeJS.Architecture>(["arm64", "x64"]);
const CONFIG_SCHEMA = 1;
const COMPOSE_WAIT_SECONDS = "120";
const MINIMUM_COMPOSE_VERSION = [2, 17, 0] as const;
const UNRELEASED_IMAGE = "ghcr.io/the-drunken-coder/atlas-core:unreleased";
const SUPPORTED_DOCKER_ARCHITECTURES = new Set(["amd64", "arm64", "aarch64", "x86_64"]);

const usage = `Atlas Core ${PACKAGE_VERSION}

Usage:
  atlas-core
  atlas-core init
  atlas-core start
  atlas-core stop
  atlas-core restart
  atlas-core reset
  atlas-core config
  atlas-core update [cli|all]
  atlas-core status
  atlas-core logs [core|source-gateway|postgres|minio] [--follow]
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
  architecture?: NodeJS.Architecture;
  nodeVersion?: string;
  now?: () => Date;
  createSecret?: () => string;
  confirmCoreUpdate?: (question: string) => Promise<boolean>;
  confirmReset?: (question: string) => Promise<boolean>;
  imageReference?: string;
  interactive?: InteractiveCLI;
};

type Command =
  | { kind: "doctor" }
  | { kind: "config" }
  | { kind: "help" }
  | { kind: "init" }
  | { kind: "logs"; service?: "api" | "minio" | "postgres" | "source-gateway"; follow: boolean }
  | { kind: "menu" }
  | { kind: "reset" }
  | { kind: "restart" }
  | { kind: "start" }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "update"; scope?: UpdateScope }
  | { kind: "apply-core-update"; fromVersion: string; expectedImage: string }
  | { kind: "version" };

type DeploymentState = {
  schema: number;
  phase: "initializing" | "ready";
  initializedAt: string;
  packageVersion: string;
  dockerEngineId: string;
  startAttemptedAt?: string;
  startedAt?: string;
};

type DockerRuntime = {
  architecture: string;
  engineId: string;
  operatingSystem: string;
};

type ComposeServiceState = {
  Service: string;
  State: string;
  Health: string;
};

type DockerStats = {
  Name: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
  NetIO: string;
  BlockIO: string;
  PIDs: string;
};

type DockerContainerDetails = {
  Config: { Image: string };
  State: { StartedAt: string };
  RestartCount: number;
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

class AtlasCoreDeployment implements AtlasCoreOperator {
  readonly #configDir: string;
  readonly #envFile: string;
  readonly #stateFile: string;
  readonly #initLockFile: string;
  readonly #composeFile: string;
  readonly #initComposeFile: string;
  readonly #runner: CommandRunner;
  readonly #stdout: { write(data: string): void };
  readonly #stderr: { write(data: string): void };
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #architecture: NodeJS.Architecture;
  readonly #nodeVersion: string;
  readonly #now: () => Date;
  readonly #createSecret: () => string;
  readonly #confirmCoreUpdate: (question: string) => Promise<boolean>;
  readonly #confirmReset: (question: string) => Promise<boolean>;
  readonly #imageReference: string | undefined;

  constructor(context: RequiredRuntimeContext) {
    this.#configDir = resolveConfigDirectory(context.env.ATLAS_CORE_HOME, context.homeDir);
    this.#envFile = join(this.#configDir, ".env");
    this.#stateFile = join(this.#configDir, "state.json");
    this.#initLockFile = join(this.#configDir, ".init.lock");
    this.#composeFile = join(context.packageRoot, "assets", "docker-compose.yml");
    this.#initComposeFile = join(context.packageRoot, "assets", "docker-compose.init.yml");
    this.#runner = context.runner;
    this.#stdout = context.stdout;
    this.#stderr = context.stderr;
    this.#env = context.env;
    this.#platform = context.platform;
    this.#architecture = context.architecture;
    this.#nodeVersion = context.nodeVersion;
    this.#now = context.now;
    this.#createSecret = context.createSecret;
    this.#confirmCoreUpdate = context.confirmCoreUpdate;
    this.#confirmReset = context.confirmReset;
    this.#imageReference = context.imageReference;
  }

  async init(): Promise<void> {
    const dockerEngineId = await this.#preflight();
    this.#prepareConfigDirectory();
    this.#acquireInitLock();
    try {
      await this.#acquireDockerInitLock(dockerEngineId);
      try {
        await this.#initialize(dockerEngineId);
      } finally {
        await this.#releaseDockerInitLock();
      }
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
      this.#assertStateMatchesEngine(existingState, dockerEngineId);
      this.#stdout.write(`Atlas Core is already initialized at ${this.#configDir}.\n`);
      return;
    }
    if (existingState) this.#assertStateMatchesRuntime(existingState, dockerEngineId);
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

    const initializingState = this.#writeInitializingState(dockerEngineId, existingState);
    if (!hasEnv) this.#writeConfiguration();
    if (!hasMinio) await this.#createVolume(MINIO_VOLUME, "minio_data");

    let startedMinio = false;
    try {
      this.#stdout.write("Provisioning the new durable MinIO store...\n");
      startedMinio = true;
      await this.#runInitComposeChecked(["up", "-d", "--wait", "--wait-timeout", COMPOSE_WAIT_SECONDS, "minio"]);
      await this.#runInitComposeChecked([
        "exec",
        "-T",
        "minio",
        "sh",
        "-c",
        'mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'
      ]);
      const bucket = this.#readConfigValue("MINIO_BUCKET") ?? "atlas-media";
      await this.#runInitComposeChecked(["exec", "-T", "minio", "mc", "mb", "--ignore-existing", `local/${bucket}`]);
      await this.#runInitComposeChecked(["exec", "-T", "minio", "mc", "anonymous", "set", "none", `local/${bucket}`]);
      await this.#runInitComposeChecked(["down"]);
      startedMinio = false;
      this.#writeReadyState(initializingState);
    } catch (error) {
      if (startedMinio) {
        const cleanup = await this.#runInitCompose(["down"]);
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
    await this.#start(state, dockerEngineId);
  }

  async #start(state: DeploymentState, dockerEngineId: string): Promise<void> {
    this.#assertStateMatchesRuntime(state, dockerEngineId);
    this.#requirePublishedImage();
    const needsPostgresVolume = await this.#assertStartIsSafe(state);
    if (needsPostgresVolume) await this.#createVolume(POSTGRES_VOLUME, "postgres_data");
    const attemptedState = this.#recordStartAttempt(state);
    this.#stdout.write(`Starting Atlas Core ${PACKAGE_VERSION}...\n`);
    await this.#runComposeChecked(["up", "-d", "--pull", "always", "--wait", "--wait-timeout", COMPOSE_WAIT_SECONDS]);
    this.#recordStarted(attemptedState);
    this.#stdout.write("Atlas Core is ready.\n");
    this.#stdout.write("API:       http://127.0.0.1:8000\n");
    this.#stdout.write("MinIO UI:  http://127.0.0.1:9001\n");
  }

  async reset(): Promise<void> {
    this.#stdout.write(
      `Reset permanently deletes Atlas Core containers, PostgreSQL and MinIO data, and configuration at ${this.#configDir}.\n`
    );
    if (!(await this.#confirmReset("Continue? [y/N] "))) {
      this.#stdout.write("Atlas Core reset cancelled.\n");
      return;
    }
    const imageReference = this.#requirePublishedImage();
    const dockerEngineId = await this.#preflight();
    await this.#checkCommand("docker", ["pull", imageReference]);
    this.#prepareConfigDirectory();
    this.#assertResetConfigurationMatchesRuntime(dockerEngineId);
    this.#acquireInitLock();
    try {
      await this.#acquireDockerInitLock(dockerEngineId);
      try {
        await this.#reset(dockerEngineId);
      } finally {
        await this.#releaseDockerInitLock();
      }
    } finally {
      this.#releaseInitLock();
    }
  }

  async #reset(dockerEngineId: string): Promise<void> {
    const existingContainers: string[] = [];
    for (const name of RESET_CONTAINERS) {
      if (await this.#containerExists(name)) existingContainers.push(name);
    }
    const existingVolumes: string[] = [];
    for (const name of RESET_VOLUMES) {
      if (await this.#volumeExists(name)) existingVolumes.push(name);
    }
    await this.#assertResetVolumesHaveNoUnknownUsers(existingVolumes);

    for (const name of existingContainers) {
      await this.#checkCommand("docker", ["container", "rm", "--force", name]);
    }
    for (const name of existingVolumes) {
      await this.#checkCommand("docker", ["volume", "rm", name]);
    }
    this.#deleteConfigurationFile(this.#stateFile);
    this.#deleteConfigurationFile(this.#envFile);

    this.#stdout.write(`Reinitializing Atlas Core ${PACKAGE_VERSION} with new credentials and empty storage.\n`);
    await this.#initialize(dockerEngineId);
    await this.#start(this.#requireInitialized(), dockerEngineId);
    this.#stdout.write(`Atlas Core ${PACKAGE_VERSION} reset is complete.\n`);
  }

  async stop(): Promise<void> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesEngine(state, dockerEngineId);
    await this.#runComposeChecked(["down"]);
    this.#stdout.write("Atlas Core stopped. Durable volumes were preserved.\n");
  }

  async restart(): Promise<void> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    await this.#restart(state, dockerEngineId);
  }

  async configureAdminPassword(password: string): Promise<void> {
    assertAdminPassword(password);
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesEngine(state, dockerEngineId);
    const snapshot = await this.#deploymentSnapshot();
    if (snapshot.status !== "stopped") this.#assertPackageVersionMatches(state);
    if (snapshot.status !== "stopped") this.#requirePublishedImage();
    this.#replaceConfigValue("ATLAS_ADMIN_PASSWORD", quoteComposeValue(password));
    this.#stdout.write("Atlas Core admin password updated for username admin.\n");
    if (snapshot.status === "stopped") {
      this.#stdout.write("The new password will take effect the next time Atlas Core starts.\n");
      return;
    }
    this.#stdout.write("Restarting Atlas Core to apply the new password...\n");
    await this.#restart(state, dockerEngineId);
  }

  async checkForUpdates(): Promise<UpdateInfo> {
    const release = await this.#latestRelease();
    let state: DeploymentState | undefined;
    try {
      state = this.#readInitializedStateIfPresent();
    } catch {
      state = undefined;
    }
    return {
      cliVersion: PACKAGE_VERSION,
      ...(state ? { coreVersion: state.packageVersion } : {}),
      latestVersion: release.version,
      cliUpdateAvailable: compareVersions(PACKAGE_VERSION, release.version, "installed CLI", "npm") < 0,
      coreUpdateAvailable: state
        ? compareVersions(state.packageVersion, release.version, "running Atlas Core", "npm") < 0
        : false
    };
  }

  async update(scope: UpdateScope, expectedVersion?: string, coreBackupConfirmed = false): Promise<void> {
    const release = await this.#latestRelease();
    if (expectedVersion && release.version !== expectedVersion) {
      throw new Error(
        `npm latest changed from ${expectedVersion} to ${release.version} while the update menu was open. Review the update again.`
      );
    }
    if (compareVersions(PACKAGE_VERSION, release.version, "installed CLI", "npm") > 0) {
      throw new Error(`Installed CLI ${PACKAGE_VERSION} is newer than npm's latest release ${release.version}.`);
    }

    const updateCLI = compareVersions(PACKAGE_VERSION, release.version, "installed CLI", "npm") < 0;
    if (scope === "cli") {
      if (!updateCLI) {
        this.#stdout.write(`Atlas Core CLI ${PACKAGE_VERSION} is already current.\n`);
        return;
      }
      await this.#installCLI(release.version);
      this.#stdout.write(`Atlas Core CLI ${release.version} installed. The running Core was not changed.\n`);
      return;
    }

    const state = this.#readInitializedStateIfPresent();
    if (state && compareVersions(state.packageVersion, release.version, "running Atlas Core", "npm") > 0) {
      throw new Error(
        `Running Atlas Core ${state.packageVersion} is newer than npm's latest release ${release.version}.`
      );
    }
    const updateCore =
      state !== undefined && compareVersions(state.packageVersion, release.version, "running Atlas Core", "npm") < 0;
    if (!state) {
      if (updateCLI) await this.#installCLI(release.version);
      this.#stdout.write(
        "Atlas Core is not initialized. The CLI is current and there is no Core deployment to update.\n"
      );
      return;
    }
    if (!updateCLI && !updateCore) {
      this.#stdout.write(`Atlas Core CLI and deployment ${PACKAGE_VERSION} are already current.\n`);
      return;
    }
    if (updateCore && !coreBackupConfirmed) {
      this.#stdout.write(
        "Atlas Core updates may apply schema migrations. Create and validate a paired PostgreSQL and MinIO backup before continuing.\n"
      );
      if (!(await this.#confirmCoreUpdate("Confirm a current paired backup exists. Continue? [y/N] "))) {
        this.#stdout.write("Atlas Core update cancelled.\n");
        return;
      }
    }
    if (updateCLI) {
      await this.#installCLI(release.version);
      if (updateCore) await this.#runInstalledCoreUpdate(release.version, release.image, state.packageVersion);
      return;
    }
    if (updateCore) await this.applyCoreUpdate(state.packageVersion, release.image);
  }

  async applyCoreUpdate(fromVersion: string, expectedImage: string): Promise<void> {
    const state = this.#requireInitialized();
    if (state.packageVersion !== fromVersion) {
      throw new Error(
        `Atlas Core changed from ${fromVersion} to ${state.packageVersion} before the update could start. Check status and retry.`
      );
    }
    const comparison = compareVersions(fromVersion, PACKAGE_VERSION, "running Atlas Core", "installed CLI");
    if (comparison > 0) throw new Error(`Atlas Core refuses to downgrade from ${fromVersion} to ${PACKAGE_VERSION}.`);
    if (comparison === 0) {
      this.#stdout.write(`Atlas Core ${PACKAGE_VERSION} is already current.\n`);
      return;
    }

    const imageReference = this.#requirePublishedImage();
    if (imageReference !== expectedImage) {
      throw new Error(`Installed Atlas Core ${PACKAGE_VERSION} pins ${imageReference}, not ${expectedImage}.`);
    }
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesEngine(state, dockerEngineId);
    const snapshot = await this.#deploymentSnapshot();
    const needsPostgresVolume = await this.#assertStartIsSafe(state);
    if (needsPostgresVolume) await this.#createVolume(POSTGRES_VOLUME, "postgres_data");

    this.#stdout.write(`Updating Atlas Core ${fromVersion} to ${PACKAGE_VERSION}...\n`);
    await this.#runComposeChecked(["pull"]);
    if (snapshot.status !== "stopped") {
      await this.#runComposeChecked(["down"]);
      await this.#runComposeChecked(["up", "-d", "--pull", "never", "--wait", "--wait-timeout", COMPOSE_WAIT_SECONDS]);
    }
    this.#writeDeploymentState({ ...state, packageVersion: PACKAGE_VERSION });
    this.#stdout.write(
      snapshot.status === "stopped"
        ? `Atlas Core ${PACKAGE_VERSION} is ready for its next start. Durable data and credentials were preserved.\n`
        : `Atlas Core ${PACKAGE_VERSION} is healthy. Durable data and credentials were preserved.\n`
    );
  }

  async status(): Promise<boolean> {
    const snapshot = await this.snapshot();
    if (snapshot.status === "not-initialized")
      throw new Error("Atlas Core is not initialized. Run atlas-core init first.");
    if (snapshot.status === "stopped") {
      this.#stderr.write("Atlas Core is stopped.\n");
      return false;
    }
    if (snapshot.status === "degraded") {
      this.#stderr.write(`Atlas Core is not ready: ${snapshot.detail}.\n`);
      return false;
    }
    this.#stdout.write("Atlas Core is running.\n");
    return true;
  }

  async snapshot(): Promise<DeploymentSnapshot> {
    if (!existsSync(this.#configDir) || !existsSync(this.#envFile) || !existsSync(this.#stateFile)) {
      return { status: "not-initialized", detail: "Initialize Atlas Core to create its private configuration." };
    }
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesEngine(state, dockerEngineId);
    return await this.#deploymentSnapshot();
  }

  async details(): Promise<DeploymentDetails> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesEngine(state, dockerEngineId);
    const serviceStates = await this.#composeServiceStates();
    const snapshot = deploymentSnapshotFromServices(serviceStates);
    const { services, error } = await this.#deploymentServices(serviceStates);
    const image = services.find((service) => service.id === "api")?.image;
    return {
      snapshot,
      cliVersion: PACKAGE_VERSION,
      coreVersion: state.packageVersion,
      initializedAt: state.initializedAt,
      apiEndpoint: "http://127.0.0.1:8000",
      minioEndpoint: "http://127.0.0.1:9001",
      services,
      ...(image ? { image } : {}),
      ...(error ? { performanceError: error } : {})
    };
  }

  async #deploymentSnapshot(): Promise<DeploymentSnapshot> {
    return deploymentSnapshotFromServices(await this.#composeServiceStates());
  }

  async #composeServiceStates(): Promise<ComposeServiceState[]> {
    const result = await this.#runCompose(["ps", "--all", "--format", "json"]);
    if (result.status !== 0) throw commandFailure("docker compose ps", result);
    return parseComposeServiceStates(result.stdout);
  }

  async #deploymentServices(
    serviceStates: ComposeServiceState[]
  ): Promise<{ services: DeploymentService[]; error?: string }> {
    const runningContainers = SERVICES.filter(({ id }) =>
      serviceStates.some((service) => service.Service === id && service.State === "running")
    ).map(({ container }) => container);
    const stats = new Map<string, DockerStats>();
    const errors: string[] = [];
    if (runningContainers.length > 0) {
      const result = await this.#runner.run(
        "docker",
        ["stats", "--no-stream", "--format", "{{json .}}", ...runningContainers],
        { env: this.#env }
      );
      if (result.status === 0) {
        try {
          for (const item of parseDockerStats(result.stdout)) stats.set(item.Name, item);
        } catch (error) {
          errors.push(errorMessage(error));
        }
      } else {
        errors.push(errorMessage(commandFailure("docker stats", result)));
      }
    }

    const services: DeploymentService[] = [];
    for (const definition of SERVICES) {
      const state = serviceStates.find((candidate) => candidate.Service === definition.id);
      const service: DeploymentService = {
        ...definition,
        state: state?.State || "missing",
        health: state?.Health || "not reporting health"
      };
      const currentStats = stats.get(definition.container);
      if (currentStats) {
        service.cpuPercent = currentStats.CPUPerc;
        service.memoryUsage = currentStats.MemUsage;
        service.memoryPercent = currentStats.MemPerc;
        service.networkIO = currentStats.NetIO;
        service.blockIO = currentStats.BlockIO;
        service.processes = currentStats.PIDs;
      }
      if (state?.State === "running") {
        const inspection = await this.#runner.run(
          "docker",
          [
            "container",
            "inspect",
            "--format",
            "{{json .Config.Image}}\t{{json .State.StartedAt}}\t{{.RestartCount}}",
            definition.container
          ],
          { env: this.#env }
        );
        if (inspection.status === 0) {
          try {
            const details = parseDockerContainerDetails(inspection.stdout);
            service.uptime = formatUptime(this.#now(), details.State.StartedAt);
            service.restarts = details.RestartCount;
            service.image = details.Config.Image;
          } catch (error) {
            errors.push(`${definition.label}: ${errorMessage(error)}`);
          }
        } else {
          errors.push(`${definition.label}: ${errorMessage(commandFailure("docker container inspect", inspection))}`);
        }
      }
      services.push(service);
    }
    return errors.length > 0 ? { services, error: errors.join("; ") } : { services };
  }

  async logs(service: "api" | "minio" | "postgres" | "source-gateway" | undefined, follow: boolean): Promise<void> {
    const state = this.#requireInitialized();
    const dockerEngineId = await this.#preflight();
    this.#assertStateMatchesEngine(state, dockerEngineId);
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
          if (!SUPPORTED_ARCHITECTURES.has(this.#architecture)) {
            throw new Error(`${this.#architecture} is not supported yet`);
          }
          return `${this.#platform}/${this.#architecture}`;
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
        check: async () => {
          const version = oneLine(await this.#checkCommand("docker", ["compose", "version", "--short"]));
          assertComposeVersion(version);
          return version;
        }
      },
      {
        label: "Docker daemon",
        check: async () => {
          const runtime = await this.#dockerRuntime();
          return `${runtime.engineId} (${runtime.operatingSystem}/${runtime.architecture})`;
        }
      },
      {
        label: "configuration",
        check: async () => {
          const state = this.#requireInitialized();
          const runtime = await this.#dockerRuntime();
          this.#assertStateMatchesEngine(state, runtime.engineId);
          await this.#runComposeChecked(["config", "--quiet"]);
          return `${this.#configDir} (Core ${state.packageVersion})`;
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
    if (!SUPPORTED_ARCHITECTURES.has(this.#architecture)) {
      throw new Error(`Atlas Core supports arm64 and x64 hosts. Detected ${this.#architecture}.`);
    }
    assertNodeVersion(this.#nodeVersion);
    await this.#checkCommand("docker", ["--version"]);
    const composeVersion = oneLine(await this.#checkCommand("docker", ["compose", "version", "--short"]));
    assertComposeVersion(composeVersion);
    return (await this.#dockerRuntime()).engineId;
  }

  async #dockerRuntime(): Promise<DockerRuntime> {
    const context = oneLine(await this.#checkCommand("docker", ["context", "show"]));
    if (!context) throw new Error("Docker did not report an active context.");
    const contextHost = oneLine(
      await this.#checkCommand("docker", [
        "context",
        "inspect",
        context,
        "--format",
        '{{(index .Endpoints "docker").Host}}'
      ])
    );
    const configuredContext = this.#env.DOCKER_CONTEXT?.trim();
    const dockerHost = configuredContext ? contextHost : this.#env.DOCKER_HOST?.trim() || contextHost;
    if (!dockerHost.startsWith("unix://")) {
      throw new Error(
        `Atlas Core requires a local Docker daemon over a Unix socket. Context ${context} uses ${dockerHost || "no endpoint"}.`
      );
    }

    const raw = await this.#checkCommand("docker", ["info", "--format", "{{json .}}"]);
    let info: unknown;
    try {
      info = JSON.parse(raw);
    } catch {
      throw new Error("Docker returned invalid daemon information.");
    }
    if (!isDockerInfo(info)) {
      throw new Error("Docker daemon information is missing its ID, operating system, or architecture.");
    }
    if (info.OSType !== "linux") {
      throw new Error(`Atlas Core requires a Linux Docker daemon. Detected ${info.OSType}.`);
    }
    if (!SUPPORTED_DOCKER_ARCHITECTURES.has(info.Architecture)) {
      throw new Error(`Atlas Core supports amd64 and arm64 Docker daemons. Detected ${info.Architecture}.`);
    }
    return { architecture: info.Architecture, engineId: info.ID, operatingSystem: info.OSType };
  }

  async #checkCommand(command: string, args: string[]): Promise<string> {
    const result = await this.#runner.run(command, args, { env: this.#env });
    if (result.status !== 0) throw commandFailure([command, ...args].join(" "), result);
    return result.stdout || result.stderr;
  }

  #acquireInitLock(): void {
    try {
      writePrivateFile(this.#initLockFile, `${JSON.stringify({ pid: process.pid }, null, 2)}\n`, this.#platform, true);
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
    const ownerDescription = isInitLock(owner) ? ` by PID ${owner.pid}` : "";
    throw new Error(
      `Atlas Core initialization is locked${ownerDescription} at ${this.#initLockFile}. ` +
        "If no atlas-core init process is running, remove that file and run init again."
    );
  }

  #releaseInitLock(): void {
    try {
      unlinkSync(this.#initLockFile);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  async #acquireDockerInitLock(dockerEngineId: string): Promise<void> {
    const labels = {
      "io.atlas.core.engine": dockerEngineId,
      "io.atlas.core.lock": "initialization",
      "io.atlas.core.project": PROJECT_NAME
    };
    const args = ["network", "create"];
    for (const [name, value] of Object.entries(labels)) args.push("--label", `${name}=${value}`);
    args.push(INIT_LOCK_NETWORK);

    const result = await this.#runner.run("docker", args, { env: this.#env });
    if (result.status === 0) return;

    const inspection = await this.#runner.run(
      "docker",
      ["network", "inspect", "--format", "{{json .Labels}}", INIT_LOCK_NETWORK],
      { env: this.#env }
    );
    if (inspection.status !== 0) throw commandFailure(`docker ${args.join(" ")}`, result);
    this.#assertResourceLabels("initialization lock", INIT_LOCK_NETWORK, inspection.stdout, labels);
    throw new Error(
      `Atlas Core initialization is already locked on Docker engine ${dockerEngineId}. ` +
        `If no atlas-core init process is running, remove ${INIT_LOCK_NETWORK} with docker network rm and run init again.`
    );
  }

  async #releaseDockerInitLock(): Promise<void> {
    const result = await this.#runner.run("docker", ["network", "rm", INIT_LOCK_NETWORK], { env: this.#env });
    if (result.status !== 0) throw commandFailure(`docker network rm ${INIT_LOCK_NETWORK}`, result);
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
        : name === SOURCE_GATEWAY_CONTAINER
          ? "source-gateway"
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

  async #assertResetVolumesHaveNoUnknownUsers(volumes: string[]): Promise<void> {
    for (const volume of volumes) {
      const output = await this.#checkCommand("docker", [
        "container",
        "ls",
        "--all",
        "--filter",
        `volume=${volume}`,
        "--format",
        "{{.Names}}"
      ]);
      const unexpected = output
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name && !RESET_CONTAINER_NAMES.has(name));
      if (unexpected.length > 0) {
        throw new Error(
          `Atlas Core volume ${volume} is also used by ${unexpected.join(", ")}. Reset stopped before deleting anything.`
        );
      }
    }
  }

  async #ownedResourceExists(
    kind: "container" | "volume",
    name: string,
    expectedLabels: Record<string, string>
  ): Promise<boolean> {
    const labelsFormat = kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}";
    const result = await this.#runner.run("docker", [kind, "inspect", "--format", labelsFormat, name], {
      env: this.#env
    });
    if (result.status !== 0) {
      if (new RegExp(`no such ${kind}`, "i").test(result.stderr || result.stdout)) return false;
      throw commandFailure(`docker ${kind} inspect ${name}`, result);
    }

    this.#assertResourceLabels(kind, name, result.stdout, expectedLabels);
    return true;
  }

  #assertResourceLabels(kind: string, name: string, stdout: string, expectedLabels: Record<string, string>): void {
    let labels: unknown;
    try {
      labels = JSON.parse(stdout);
    } catch {
      throw new Error(`Docker returned invalid ownership labels for ${kind} ${name}.`);
    }
    if (typeof labels !== "object" || labels === null) {
      throw new Error(`Atlas Core found ${kind} ${name} without ownership labels.`);
    }
    const record = labels as Record<string, unknown>;
    const mismatch = Object.entries(expectedLabels).find(([key, value]) => record[key] !== value);
    if (mismatch) {
      throw new Error(
        `Atlas Core found ${kind} ${name} without the expected ${mismatch[0]}=${mismatch[1]} ownership label.`
      );
    }
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

  async #restart(state: DeploymentState, dockerEngineId: string): Promise<void> {
    this.#assertStateMatchesRuntime(state, dockerEngineId);
    this.#requirePublishedImage();
    const needsPostgresVolume = await this.#assertStartIsSafe(state);
    if (needsPostgresVolume) await this.#createVolume(POSTGRES_VOLUME, "postgres_data");
    const attemptedState = this.#recordStartAttempt(state);
    await this.#runComposeChecked(["pull"]);
    await this.#runComposeChecked(["down"]);
    await this.#runComposeChecked(["up", "-d", "--pull", "never", "--wait", "--wait-timeout", COMPOSE_WAIT_SECONDS]);
    this.#recordStarted(attemptedState);
    this.#stdout.write(`Atlas Core ${PACKAGE_VERSION} restarted and is ready.\n`);
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
      "ATLAS_PLUGINS=[]",
      "ATLAS_SOURCE_GATEWAY_CONFIG_FILE=",
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

  #writeInitializingState(dockerEngineId: string, previous: DeploymentState | undefined): DeploymentState {
    const state: DeploymentState = {
      schema: CONFIG_SCHEMA,
      phase: "initializing",
      initializedAt: previous?.initializedAt ?? this.#now().toISOString(),
      packageVersion: PACKAGE_VERSION,
      dockerEngineId
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

  #readInitializedStateIfPresent(): DeploymentState | undefined {
    const paths = [this.#configDir, this.#envFile, this.#stateFile];
    if (paths.every((path) => !existsSync(path))) return undefined;
    return this.#requireInitialized();
  }

  async #latestRelease(): Promise<{ version: string; image: string }> {
    const result = await this.#runner.run(
      "npm",
      ["view", `${PACKAGE_NAME}@latest`, "version", "atlasCoreImage", "--json"],
      { env: this.#env }
    );
    if (result.status !== 0) throw commandFailure(`npm view ${PACKAGE_NAME}@latest`, result);
    return parseNpmRelease(result.stdout);
  }

  async #installCLI(version: string): Promise<void> {
    this.#stdout.write(`Installing Atlas Core CLI ${version}...\n`);
    const result = await this.#runner.run("npm", ["install", "--global", `${PACKAGE_NAME}@${version}`], {
      env: this.#env,
      inherit: true
    });
    if (result.status !== 0) throw commandFailure(`npm install --global ${PACKAGE_NAME}@${version}`, result);
  }

  async #runInstalledCoreUpdate(version: string, expectedImage: string, fromVersion: string): Promise<void> {
    const rootResult = await this.#runner.run("npm", ["root", "--global"], { env: this.#env });
    if (rootResult.status !== 0) throw commandFailure("npm root --global", rootResult);
    const globalRoot = oneLine(rootResult.stdout);
    if (!globalRoot) throw new Error("npm did not report its global package directory after the CLI update.");
    const installedCLI = resolveInstalledCLI(join(globalRoot, PACKAGE_NAME));
    const childEnvironment = { ...this.#env, ATLAS_CORE_HOME: this.#configDir };
    const versionResult = await this.#runner.run(process.execPath, [installedCLI, "version"], {
      env: childEnvironment
    });
    if (versionResult.status !== 0) throw commandFailure(`${installedCLI} version`, versionResult);
    if (oneLine(versionResult.stdout) !== `${PACKAGE_NAME} ${version}`) {
      throw new Error(`npm installed an unexpected Atlas Core CLI: ${oneLine(versionResult.stdout) || "no version"}.`);
    }
    const updateResult = await this.#runner.run(
      process.execPath,
      [installedCLI, "__apply-core-update", fromVersion, expectedImage],
      {
        env: childEnvironment,
        inherit: true
      }
    );
    if (updateResult.status !== 0) {
      throw commandFailure(`Atlas Core ${version} deployment update`, updateResult);
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

  #writeDeploymentState(state: DeploymentState): void {
    writePrivateFile(this.#stateFile, `${JSON.stringify(state, null, 2)}\n`, this.#platform);
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

  #assertResetConfigurationMatchesRuntime(dockerEngineId: string): void {
    this.#assertPrivateConfiguration();
    const state = this.#readState();
    if (state && state.dockerEngineId !== dockerEngineId) {
      throw new Error(
        `Atlas Core configuration belongs to Docker engine ${state.dockerEngineId}, but the current engine is ${dockerEngineId}. ` +
          "Restore the original Docker context before resetting this deployment."
      );
    }
  }

  #deleteConfigurationFile(path: string): void {
    if (!existsSync(path)) return;
    this.#assertPrivateFile(path);
    unlinkSync(path);
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
    this.#assertStateMatchesEngine(state, dockerEngineId);
    this.#assertPackageVersionMatches(state);
  }

  #assertPackageVersionMatches(state: DeploymentState): void {
    if (state.packageVersion !== PACKAGE_VERSION) {
      throw new Error(
        `Atlas Core ${state.packageVersion} initialized this deployment, but the installed CLI is ${PACKAGE_VERSION}. ` +
          "Run atlas-core update all to update the deployment explicitly."
      );
    }
  }

  #assertStateMatchesEngine(state: DeploymentState, dockerEngineId: string): void {
    if (state.dockerEngineId !== dockerEngineId) {
      throw new Error(
        `Atlas Core was initialized on Docker engine ${state.dockerEngineId}, but the current engine is ${dockerEngineId}. ` +
          "Restore the original Docker context before operating this deployment."
      );
    }
  }

  #requirePublishedImage(): string {
    if (!this.#imageReference) {
      throw new Error("This atlas-core package was not produced by the release workflow and has no pinned Core image.");
    }
    return this.#imageReference;
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

  #replaceConfigValue(name: string, value: string): void {
    this.#assertPrivateFile(this.#envFile);
    const contents = readFileSync(this.#envFile, "utf8");
    const lines = contents.split(/\r?\n/);
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (index === -1) throw new Error(`${this.#envFile} does not contain ${name}. Restore the matching configuration.`);
    lines[index] = `${name}=${value}`;
    writePrivateFile(this.#envFile, lines.join("\n"), this.#platform);
  }

  async #runCompose(args: string[], inherit = false): Promise<CommandResult> {
    return await this.#runComposeFile(this.#composeFile, args, inherit);
  }

  async #runInitCompose(args: string[]): Promise<CommandResult> {
    return await this.#runComposeFile(this.#initComposeFile, args);
  }

  async #runComposeFile(composeFile: string, args: string[], inherit = false): Promise<CommandResult> {
    const env = { ...this.#env };
    for (const variable of COMPOSE_VARIABLES) delete env[variable];
    for (const variable of Object.keys(env)) {
      if (variable.startsWith("COMPOSE_")) delete env[variable];
    }
    env.COMPOSE_IGNORE_ORPHANS = "0";
    env.COMPOSE_REMOVE_ORPHANS = "0";
    env.ATLAS_CORE_IMAGE = this.#imageReference ?? UNRELEASED_IMAGE;
    return await this.#runner.run("docker", this.#composeArgs(composeFile, args), {
      cwd: this.#configDir,
      env,
      inherit
    });
  }

  async #runComposeChecked(args: string[]): Promise<void> {
    const result = await this.#runCompose(args);
    if (result.status !== 0)
      throw commandFailure(`docker ${this.#composeArgs(this.#composeFile, args).join(" ")}`, result);
  }

  async #runInitComposeChecked(args: string[]): Promise<void> {
    const result = await this.#runInitCompose(args);
    if (result.status !== 0) {
      throw commandFailure(`docker ${this.#composeArgs(this.#initComposeFile, args).join(" ")}`, result);
    }
  }

  #composeArgs(composeFile: string, args: string[]): string[] {
    return ["compose", "--project-name", PROJECT_NAME, "--env-file", this.#envFile, "--file", composeFile, ...args];
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
  architecture: NodeJS.Architecture;
  nodeVersion: string;
  now: () => Date;
  createSecret: () => string;
  confirmCoreUpdate: (question: string) => Promise<boolean>;
  confirmReset: (question: string) => Promise<boolean>;
  imageReference: string | undefined;
  interactive: InteractiveCLI;
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
    if (command.kind === "menu") {
      await runtime.interactive.runMenu(deployment);
      return 0;
    }
    if (command.kind === "apply-core-update") {
      await deployment.applyCoreUpdate(command.fromVersion, command.expectedImage);
      return 0;
    }
    switch (command.kind) {
      case "config":
        await runtime.interactive.configureAdmin(deployment);
        return 0;
      case "doctor":
        return (await deployment.doctor()) ? 0 : 1;
      case "init":
        await deployment.init();
        return 0;
      case "logs":
        await deployment.logs(command.service, command.follow);
        return 0;
      case "reset":
        await deployment.reset();
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
      case "update":
        if (command.scope) await deployment.update(command.scope);
        else await runtime.interactive.runUpdate(deployment);
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
  if (argv.length === 0) return { kind: "menu" };
  if (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0] ?? "")) {
    return { kind: "help" };
  }
  const [name, ...args] = argv;
  switch (name) {
    case "doctor":
    case "config":
    case "init":
    case "restart":
    case "start":
    case "status":
    case "stop":
    case "version":
      if (args.length > 0) throw new UsageError(`${name} does not accept arguments`);
      return { kind: name };
    case "update":
      if (args.length === 0) return { kind: "update" };
      if (args.length === 1 && (args[0] === "cli" || args[0] === "all")) {
        return { kind: "update", scope: args[0] };
      }
      throw new UsageError("update accepts cli or all");
    case "__apply-core-update":
      if (args.length !== 2) throw new UsageError("invalid internal update request");
      return { kind: "apply-core-update", fromVersion: args[0] ?? "", expectedImage: args[1] ?? "" };
    case "reset":
      if (args.length > 0) throw new UsageError("reset does not accept arguments");
      return { kind: "reset" };
    case "logs":
      return parseLogs(args);
    default:
      throw new UsageError(`Unknown command: ${name ?? ""}`);
  }
}

function parseLogs(args: string[]): Extract<Command, { kind: "logs" }> {
  let service: "api" | "minio" | "postgres" | "source-gateway" | undefined;
  let follow = false;
  for (const arg of args) {
    if (arg === "--follow" || arg === "-f") {
      follow = true;
      continue;
    }
    if (service) throw new UsageError("logs accepts at most one service");
    if (arg === "core" || arg === "api") service = "api";
    else if (arg === "postgres" || arg === "minio" || arg === "source-gateway") service = arg;
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
    architecture: context.architecture ?? process.arch,
    nodeVersion: context.nodeVersion ?? process.versions.node,
    now: context.now ?? (() => new Date()),
    createSecret: context.createSecret ?? (() => randomBytes(32).toString("base64url")),
    confirmCoreUpdate: context.confirmCoreUpdate ?? askForConfirmation,
    confirmReset: context.confirmReset ?? askForConfirmation,
    imageReference: context.imageReference ?? PACKAGE_IMAGE,
    interactive: context.interactive ?? createInteractiveCLI()
  };
}

async function askForConfirmation(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<boolean>((resolveConfirmation) => {
      prompt.once("close", () => resolveConfirmation(false));
      void prompt.question(question).then(
        (answer) => resolveConfirmation(/^(?:y|yes)$/i.test(answer.trim())),
        () => resolveConfirmation(false)
      );
    });
  } finally {
    prompt.close();
  }
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
    (record.startAttemptedAt === undefined || typeof record.startAttemptedAt === "string") &&
    (record.startedAt === undefined || typeof record.startedAt === "string")
  );
}

function isDockerInfo(value: unknown): value is { ID: string; OSType: string; Architecture: string } {
  if (!value || typeof value !== "object") return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.ID === "string" &&
    info.ID.length > 0 &&
    typeof info.OSType === "string" &&
    typeof info.Architecture === "string"
  );
}

function isInitLock(value: unknown): value is { pid: number } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0;
}

function resolveConfigDirectory(configured: string | undefined, homeDir: string): string {
  if (!configured) return join(homeDir, ".atlas", "core");
  if (configured === "~") return homeDir;
  if (configured.startsWith("~/")) return resolve(homeDir, configured.slice(2));
  return resolve(configured);
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

function deploymentSnapshotFromServices(services: ComposeServiceState[]): DeploymentSnapshot {
  if (services.length === 0) {
    return { status: "stopped", detail: "Atlas Core is initialized and stopped. Durable storage is preserved." };
  }
  const failures = [...REQUIRED_SERVICES].flatMap((service) => {
    const current = services.find((candidate) => candidate.Service === service);
    if (!current) return [`${service} is missing`];
    if (current.State !== "running") return [`${service} is ${current.State || "in an unknown state"}`];
    if (current.Health !== "healthy") return [`${service} is ${current.Health || "not reporting health"}`];
    return [];
  });
  if (failures.length > 0) return { status: "degraded", detail: failures.join(", ") };
  return { status: "ready", detail: "Core API, Source Gateway, PostgreSQL, and MinIO are running and healthy." };
}

function parseDockerStats(stdout: string): DockerStats[] {
  const output = stdout.trim();
  if (!output) return [];
  let values: unknown[];
  try {
    const parsed: unknown = JSON.parse(output);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      values = output.split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new Error("Docker returned invalid performance statistics.");
    }
  }
  return values.map((value) => {
    if (typeof value !== "object" || value === null) throw new Error("Docker returned invalid performance statistics.");
    const record = value as Record<string, unknown>;
    const fields = ["Name", "CPUPerc", "MemUsage", "MemPerc", "NetIO", "BlockIO", "PIDs"] as const;
    if (fields.some((field) => typeof record[field] !== "string")) {
      throw new Error("Docker returned incomplete performance statistics.");
    }
    return Object.fromEntries(fields.map((field) => [field, record[field]])) as DockerStats;
  });
}

function parseDockerContainerDetails(stdout: string): DockerContainerDetails {
  const [rawImage, rawStartedAt, rawRestartCount, ...extra] = stdout.trim().split("\t");
  if (!rawImage || !rawStartedAt || !rawRestartCount || extra.length > 0) {
    throw new Error("Docker returned incomplete container details.");
  }
  let image: unknown;
  let startedAt: unknown;
  try {
    image = JSON.parse(rawImage);
    startedAt = JSON.parse(rawStartedAt);
  } catch {
    throw new Error("Docker returned invalid container details.");
  }
  const restartCount = Number(rawRestartCount);
  if (
    typeof image !== "string" ||
    typeof startedAt !== "string" ||
    !Number.isInteger(restartCount) ||
    restartCount < 0
  ) {
    throw new Error("Docker returned incomplete container details.");
  }
  return {
    Config: { Image: image },
    State: { StartedAt: startedAt },
    RestartCount: restartCount
  };
}

function parseNpmRelease(stdout: string): { version: string; image: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("npm returned invalid Atlas Core release metadata.");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("npm returned incomplete Atlas Core release metadata.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string") throw new Error("npm did not return the latest Atlas Core version.");
  validateVersion(record.version, "npm");
  if (
    typeof record.atlasCoreImage !== "string" ||
    !/^ghcr\.io\/the-drunken-coder\/atlas-core@sha256:[0-9a-f]{64}$/u.test(record.atlasCoreImage)
  ) {
    throw new Error("npm did not return the reviewed Atlas Core image for its latest release.");
  }
  return { version: record.version, image: record.atlasCoreImage };
}

function resolveInstalledCLI(packageDirectory: string): string {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  } catch {
    throw new Error(`npm installed Atlas Core without readable package metadata at ${packageDirectory}.`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("The installed Atlas Core package metadata is invalid.");
  }
  const bin = (value as Record<string, unknown>).bin;
  const entry =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? (bin as Record<string, unknown>)[PACKAGE_NAME]
        : undefined;
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(`The installed Atlas Core package does not define its ${PACKAGE_NAME} executable.`);
  }
  const installedCLI = resolve(packageDirectory, entry);
  const relativeEntry = relative(packageDirectory, installedCLI);
  if (
    relativeEntry === "" ||
    relativeEntry === ".." ||
    relativeEntry.startsWith(`..${sep}`) ||
    isAbsolute(relativeEntry)
  ) {
    throw new Error("The installed Atlas Core package executable points outside its package directory.");
  }
  return installedCLI;
}

function validateVersion(version: string, source: string): void {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error(`${source} has an invalid Atlas Core version: ${version}`);
  }
}

function compareVersions(left: string, right: string, leftSource: string, rightSource: string): number {
  validateVersion(left, leftSource);
  validateVersion(right, rightSource);
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function formatUptime(now: Date, startedAt: string): string {
  const start = new Date(startedAt);
  const milliseconds = now.getTime() - start.getTime();
  if (!Number.isFinite(start.getTime()) || milliseconds < 0) return "Not available";
  const minutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remainingMinutes}m`;
  return `${remainingMinutes}m`;
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

function assertComposeVersion(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Docker Compose returned an unsupported version: ${version}`);
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < MINIMUM_COMPOSE_VERSION.length; index += 1) {
    const difference = (actual[index] ?? 0) - (MINIMUM_COMPOSE_VERSION[index] ?? 0);
    if (difference > 0) return;
    if (difference < 0) {
      throw new Error(
        `Atlas Core requires Docker Compose ${MINIMUM_COMPOSE_VERSION.join(".")} or newer. Detected ${version}.`
      );
    }
  }
}

function assertAdminPassword(password: string): void {
  const trimmed = password.trim();
  if (password !== trimmed) throw new Error("Admin password cannot begin or end with whitespace.");
  if (/[\r\n\0]/u.test(password)) throw new Error("Admin password cannot contain line breaks or null characters.");
  const placeholder = trimmed.toLowerCase();
  if (
    [
      "password",
      "replace_with_secure_admin_password",
      "replace-with-secure-admin-password",
      "your-secure-admin-password"
    ].includes(placeholder)
  ) {
    throw new Error("Admin password cannot be a development default or example placeholder.");
  }
  if (Array.from(trimmed).length < 12) throw new Error("Admin password must contain at least 12 characters.");
}

function quoteComposeValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")}"`;
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
