import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CLIContext, type CommandRunner, ProcessCommandRunner, runCLI } from "../src/application.js";
import { OperationCleanupError } from "../src/operation-errors.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-metadata.js";
import type { PluginCatalogEntry } from "../src/plugin-catalog.js";
import type { DeploymentDetails } from "../src/terminal-ui.js";

const TEST_IMAGE = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"a".repeat(64)}`;
const TEST_PLUGIN_IMAGE = `ghcr.io/the-drunken-coder/atlas-spatial-fixture@sha256:${"b".repeat(64)}`;
const TEST_ENGINE_ID = "test-engine-id";
const projectName = (engineId: string): string =>
  `atlas_core_production_${createHash("sha256").update(engineId).digest("hex")}`;
const PROJECT_NAME = projectName(TEST_ENGINE_ID);
const API_CONTAINER = `${PROJECT_NAME}_api`;
const SOURCE_GATEWAY_CONTAINER = `${PROJECT_NAME}_source_gateway`;
const POSTGRES_CONTAINER = `${PROJECT_NAME}_postgres`;
const MINIO_CONTAINER = `${PROJECT_NAME}_minio`;
const MINIO_INIT_CONTAINER = `${PROJECT_NAME}_minio_init`;
const POSTGRES_VOLUME = `${PROJECT_NAME}_postgres_data`;
const MINIO_VOLUME = `${PROJECT_NAME}_minio_data`;
const MUTATION_LOCK_NETWORK = "atlas_core_production_mutation_lock";

function nextPatchVersion(version: string): string {
  const [major, minor, patch, ...extra] = version.split(".");
  if (!major || !minor || !patch || extra.length > 0) throw new Error(`Invalid test package version: ${version}`);
  return `${major}.${minor}.${Number(patch) + 1}`;
}

const NEXT_PACKAGE_VERSION = nextPatchVersion(PACKAGE_VERSION);
const FOLLOWING_PACKAGE_VERSION = nextPatchVersion(NEXT_PACKAGE_VERSION);

type Call = {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  inherit: boolean;
  processGroup?: {
    started(processGroupId: number): void;
    finished(processGroupId: number): void;
  };
  signal?: AbortSignal;
};

class FakeRunner implements CommandRunner {
  readonly calls: Call[] = [];
  readonly existingVolumes = new Set<string>();
  readonly existingContainers = new Set<string>();
  readonly existingNetworks = new Set<string>();
  readonly networkLabels = new Map<string, Record<string, string>>();
  readonly networkIds = new Map<string, string>();
  readonly mismatchedResources = new Set<string>();
  readonly volumeUsers = new Map<string, Set<string>>();
  inspectionError: { kind: "container" | "volume"; name: string } | undefined;
  failComposeDown = false;
  failComposeConfig = false;
  failComposePull = false;
  failComposeUp = false;
  failAfterComposeDown = false;
  failDockerPullImage: string | undefined;
  failComposeUpImage: string | undefined;
  failStats = false;
  failInstalledCoreUpdate = false;
  composeVersion = "5.1.2";
  contextHost = "unix:///var/run/docker.sock";
  dockerArchitecture = "arm64";
  dockerEngineId = TEST_ENGINE_ID;
  dockerOperatingSystem = "linux";
  globalRoot = "";
  latestVersion = PACKAGE_VERSION;
  latestImage = TEST_IMAGE;
  runningCoreImage = TEST_IMAGE;
  installedVersion = PACKAGE_VERSION;
  missingNetworkError = (name: string): string => `Error: No such network: ${name}`;
  nextNetworkRemovalError: ((name: string) => string) | undefined;
  retainNetworkOnRemovalError = false;
  onRun: ((call: Call) => void | Promise<void>) | undefined;
  afterSuccessfulNetworkCreate: (() => void) | undefined;
  afterNetworkCreateEffect: ((call: Call) => void) | undefined;
  afterDockerInfo: (() => void) | undefined;
  failAfterNetworkCreate: string | undefined;
  failProcessGroupClearAfterNetworkCreate = false;
  afterSuccessfulComposeUp: (() => void) | undefined;
  cancelAfterNetworkCreate: (() => void) | undefined;
  onCleanupStart: ((signal: AbortSignal | undefined) => void) | undefined;
  hangCleanup = false;
  serviceStates = [
    { Service: "api", State: "running", Health: "healthy" },
    { Service: "source-gateway", State: "running", Health: "healthy" },
    { Service: "minio", State: "running", Health: "healthy" },
    { Service: "postgres", State: "running", Health: "healthy" }
  ];
  cancelAllCalls = 0;

  cancelAll(): void {
    this.cancelAllCalls++;
  }

  async run(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      inherit?: boolean;
      processGroup?: Call["processGroup"];
      signal?: AbortSignal;
    } = {}
  ): Promise<{ cancelled?: true; status: number; stdout: string; stderr: string }> {
    const call = {
      command,
      args,
      cwd: options.cwd,
      env: { ...options.env },
      inherit: options.inherit ?? false,
      ...(options.processGroup ? { processGroup: options.processGroup } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    };
    this.calls.push(call);
    const cancellationCount = this.cancelAllCalls;
    await this.onRun?.(call);
    if (this.cancelAllCalls > cancellationCount) return { ...result(1), cancelled: true };
    if (command === "npm" && args[0] === "view") {
      return result(0, JSON.stringify({ version: this.latestVersion, atlasCoreImage: this.latestImage }));
    }
    if (command === "npm" && args[0] === "install" && args[1] === "--global") {
      this.installedVersion = args[2]?.split("@").at(-1) ?? this.installedVersion;
      return result(0);
    }
    if (command === "npm" && args[0] === "root" && args[1] === "--global") {
      return result(0, `${this.globalRoot}\n`);
    }
    if (command === process.execPath && args.at(-1) === "version") {
      return result(0, `atlas-core ${this.installedVersion}\n`);
    }
    if (command === process.execPath && args.includes("__apply-core-update")) {
      return this.failInstalledCoreUpdate ? result(1, "", "injected installed update failure") : result(0);
    }
    if (args[0] === "network" && args[1] === "create") {
      const name = args.at(-1) ?? "";
      if (this.existingNetworks.has(name)) return result(1, "", `network with name ${name} already exists`);
      this.existingNetworks.add(name);
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index++) {
        if (args[index] !== "--label") continue;
        const [labelName, ...valueParts] = args[index + 1]?.split("=") ?? [];
        if (labelName) labels[labelName] = valueParts.join("=");
      }
      this.networkLabels.set(name, labels);
      const networkId = `network-${this.networkIds.size + 1}`;
      this.networkIds.set(name, networkId);
      const afterNetworkCreateEffect = this.afterNetworkCreateEffect;
      this.afterNetworkCreateEffect = undefined;
      afterNetworkCreateEffect?.(call);
      if (this.failProcessGroupClearAfterNetworkCreate) {
        this.failProcessGroupClearAfterNetworkCreate = false;
        options.processGroup?.started(2_000_000_000);
        throw new OperationCleanupError("injected durable process-group clear failure");
      }
      const cancelAfterNetworkCreate = this.cancelAfterNetworkCreate;
      this.cancelAfterNetworkCreate = undefined;
      if (cancelAfterNetworkCreate) {
        cancelAfterNetworkCreate();
        return { ...result(1), cancelled: true };
      }
      const failAfterNetworkCreate = this.failAfterNetworkCreate;
      this.failAfterNetworkCreate = undefined;
      if (failAfterNetworkCreate) return result(1, "", failAfterNetworkCreate);
      const afterSuccessfulNetworkCreate = this.afterSuccessfulNetworkCreate;
      this.afterSuccessfulNetworkCreate = undefined;
      if (afterSuccessfulNetworkCreate) queueMicrotask(afterSuccessfulNetworkCreate);
      return result(0, `${networkId}\n`);
    }
    if (args[0] === "pull" && args[1] === this.failDockerPullImage) {
      return result(1, "", "injected Docker image pull failure");
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const requested = args.at(-1) ?? "";
      const name = this.existingNetworks.has(requested)
        ? requested
        : ([...this.networkIds].find(([, id]) => id === requested)?.[0] ?? requested);
      if (!this.existingNetworks.has(name)) return result(1, "", this.missingNetworkError(name));
      const labels = this.networkLabels.get(name) ?? {
        "io.atlas.core.engine": "test-engine-id",
        "io.atlas.core.lock": "mutation",
        "io.atlas.core.project": "atlas_core_production"
      };
      const format = args[args.indexOf("--format") + 1];
      if (format === "{{json .Id}}\t{{json .Labels}}") {
        const networkId = this.networkIds.get(name) ?? `existing-${name}`;
        this.networkIds.set(name, networkId);
        return result(0, `${JSON.stringify(networkId)}\t${JSON.stringify(labels)}\n`);
      }
      return result(0, JSON.stringify(labels));
    }
    if (args[0] === "network" && args[1] === "rm") {
      const requested = args.at(-1) ?? "";
      const name = this.existingNetworks.has(requested)
        ? requested
        : ([...this.networkIds].find(([, id]) => id === requested)?.[0] ?? requested);
      const removalError = this.nextNetworkRemovalError;
      this.nextNetworkRemovalError = undefined;
      const retainNetworkOnRemovalError = this.retainNetworkOnRemovalError;
      this.retainNetworkOnRemovalError = false;
      if (removalError && retainNetworkOnRemovalError) return result(1, "", removalError(requested));
      this.existingNetworks.delete(name);
      this.networkLabels.delete(name);
      this.networkIds.delete(name);
      if (removalError) return result(1, "", removalError(requested));
      return result(0);
    }
    if (args[0] === "volume" && args[1] === "create") {
      const name = args.at(-1) ?? "";
      this.existingVolumes.add(name);
      return result(0, `${name}\n`);
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const name = args.at(-1) ?? "";
      if ((this.volumeUsers.get(name)?.size ?? 0) > 0) return result(1, "", `volume ${name} is in use`);
      this.existingVolumes.delete(name);
      return result(0, `${name}\n`);
    }
    if (args[0] === "container" && args[1] === "ls") {
      const filter = args[args.indexOf("--filter") + 1] ?? "";
      if (filter === `label=com.docker.compose.project=${PROJECT_NAME}`) {
        return result(0, [...this.existingContainers].filter((name) => !this.mismatchedResources.has(name)).join("\n"));
      }
      const volume = filter.startsWith("volume=") ? filter.slice("volume=".length) : "";
      return result(0, [...(this.volumeUsers.get(volume) ?? [])].join("\n"));
    }
    if (args[0] === "container" && args[1] === "rm") {
      const name = args.at(-1) ?? "";
      this.existingContainers.delete(name);
      for (const users of this.volumeUsers.values()) users.delete(name);
      return result(0, `${name}\n`);
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args.at(-1) ?? "";
      if (this.inspectionError?.kind === "volume" && this.inspectionError.name === name) {
        return result(1, "", "permission denied");
      }
      if (!this.existingVolumes.has(name)) return result(1, "", `Error: No such volume: ${name}`);
      const volume = name.endsWith("postgres_data") ? "postgres_data" : "minio_data";
      return result(
        0,
        JSON.stringify({
          "com.docker.compose.project": this.mismatchedResources.has(name) ? "other" : PROJECT_NAME,
          "com.docker.compose.volume": volume,
          "io.atlas.core.engine": TEST_ENGINE_ID
        })
      );
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const name = args.at(-1) ?? "";
      if (this.inspectionError?.kind === "container" && this.inspectionError.name === name) {
        return result(1, "", "permission denied");
      }
      const service = name.endsWith("_api")
        ? "api"
        : name.endsWith("_source_gateway")
          ? "source-gateway"
          : name.endsWith("_postgres")
            ? "postgres"
            : name.endsWith("_minio_init")
              ? "minio-init"
              : "minio";
      if (args[args.indexOf("--format") + 1] === "{{json .Config.Image}}") {
        if (!this.serviceStates.some((candidate) => candidate.Service === service)) {
          return result(1, "", `Error: No such container: ${name}`);
        }
        return result(0, `${JSON.stringify(this.runningCoreImage)}\n`);
      }
      if (
        args[args.indexOf("--format") + 1] === "{{json .Config.Image}}\t{{json .State.StartedAt}}\t{{.RestartCount}}"
      ) {
        if (!this.serviceStates.some((candidate) => candidate.Service === service)) {
          return result(1, "", `Error: No such container: ${name}`);
        }
        return result(0, `${JSON.stringify(TEST_IMAGE)}\t"2026-08-28T08:00:00.000Z"\t${service === "api" ? 1 : 0}\n`);
      }
      if (!this.existingContainers.has(name)) return result(1, "", `Error: No such container: ${name}`);
      return result(
        0,
        JSON.stringify({
          "com.docker.compose.project": this.mismatchedResources.has(name) ? "other" : PROJECT_NAME,
          "com.docker.compose.service": service,
          "io.atlas.core.engine": TEST_ENGINE_ID
        })
      );
    }
    if (args[0] === "stats") {
      if (this.failStats) return result(1, "", "injected stats failure");
      const formatIndex = args.indexOf("--format");
      const names = args.slice(formatIndex + 2);
      return result(
        0,
        names
          .map((name, index) =>
            JSON.stringify({
              Name: name,
              CPUPerc: `${index + 1}.00%`,
              MemUsage: `${128 + index * 64}MiB / 1GiB`,
              MemPerc: `${12.5 + index * 6.25}%`,
              NetIO: `${index + 1}MB / ${index + 2}MB`,
              BlockIO: `${index + 3}MB / ${index + 4}MB`,
              PIDs: `${10 + index}`
            })
          )
          .join("\n")
      );
    }
    if (args.includes("ps")) return result(0, this.serviceStates.map((service) => JSON.stringify(service)).join("\n"));
    if (args[0] === "--version") return result(0, "Docker version 29.4.0\n");
    if (args[0] === "compose" && args[1] === "version") return result(0, `${this.composeVersion}\n`);
    if (args[0] === "context" && args[1] === "show") return result(0, "default\n");
    if (args[0] === "context" && args[1] === "inspect") return result(0, `${this.contextHost}\n`);
    if (args[0] === "info") {
      const engineId = this.dockerEngineId;
      const afterDockerInfo = this.afterDockerInfo;
      this.afterDockerInfo = undefined;
      if (afterDockerInfo) queueMicrotask(afterDockerInfo);
      return result(
        0,
        JSON.stringify({
          ID: engineId,
          OSType: this.dockerOperatingSystem,
          Architecture: this.dockerArchitecture
        })
      );
    }
    const compose = composeCommand(call);
    if (this.failComposeConfig && compose[0] === "config") {
      return result(1, "", "injected compose config failure");
    }
    if (this.failComposePull && compose[0] === "pull") {
      return result(1, "", "injected compose pull failure");
    }
    if (
      (this.failComposeUp ||
        (this.failComposeUpImage !== undefined && this.failComposeUpImage === call.env.ATLAS_CORE_IMAGE)) &&
      compose[0] === "up"
    ) {
      return result(1, "", "injected compose up failure");
    }
    if (this.failComposeDown && compose[0] === "down") {
      return result(1, "", "injected compose down failure");
    }
    if (this.failAfterComposeDown && compose[0] === "down") {
      this.failAfterComposeDown = false;
      this.serviceStates = [];
      return result(1, "", "injected failure after compose down");
    }
    if (compose[0] === "rm") {
      const removedService = compose.at(-1);
      if (removedService)
        this.serviceStates = this.serviceStates.filter((service) => service.Service !== removedService);
    }
    if (compose[0] === "up") {
      if (compose.includes("--remove-orphans")) {
        const definedServices = new Set(["api", "source-gateway", "minio", "postgres"]);
        for (let index = 0; index < call.args.length; index++) {
          if (call.args[index] !== "--file" || index === call.args.indexOf("--file")) continue;
          const composePath = call.args[index + 1];
          if (!composePath || !existsSync(composePath)) continue;
          for (const match of readFileSync(composePath, "utf8").matchAll(/^  ([a-z][a-z0-9-]+):/gmu)) {
            const service = match[1];
            if (service) definedServices.add(service);
          }
        }
        this.serviceStates = this.serviceStates.filter((service) => definedServices.has(service.Service));
      }
      const waitTimeout = compose.indexOf("--wait-timeout");
      const requestedServices = waitTimeout === -1 ? [] : compose.slice(waitTimeout + 2);
      for (const service of requestedServices) {
        if (!this.serviceStates.some((candidate) => candidate.Service === service)) {
          this.serviceStates.push({ Service: service, State: "running", Health: "healthy" });
        }
      }
      const afterSuccessfulComposeUp = this.afterSuccessfulComposeUp;
      this.afterSuccessfulComposeUp = undefined;
      if (afterSuccessfulComposeUp) queueMicrotask(afterSuccessfulComposeUp);
    }
    return result(0);
  }

  async runCleanup(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      inherit?: boolean;
      processGroup?: Call["processGroup"];
      signal?: AbortSignal;
    } = {}
  ): Promise<{ cancelled?: true; status: number; stdout: string; stderr: string }> {
    if (!this.hangCleanup) return await this.run(command, args, options);
    this.onCleanupStart?.(options.signal);
    return await new Promise((resolve) => {
      const cancelled = (): void => resolve({ ...result(1), cancelled: true });
      options.signal?.addEventListener("abort", cancelled, { once: true });
      if (options.signal?.aborted) cancelled();
    });
  }
}

type TestRuntime = {
  home: string;
  runner: FakeRunner;
  stdout: string[];
  stderr: string[];
  context: CLIContext;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runtime(): TestRuntime {
  const home = mkdtempSync(join(tmpdir(), "atlas-core-test-"));
  temporaryDirectories.push(home);
  const runner = new FakeRunner();
  runner.globalRoot = join(home, "npm-global", "lib", "node_modules");
  const installedPackage = join(runner.globalRoot, PACKAGE_NAME);
  mkdirSync(installedPackage, { recursive: true });
  writeFileSync(
    join(installedPackage, "package.json"),
    `${JSON.stringify({ bin: { [PACKAGE_NAME]: "./dist/cli.js" } })}\n`
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  let secret = 0;
  return {
    home,
    runner,
    stdout,
    stderr,
    context: {
      homeDir: home,
      runner,
      stdout: { write: (data) => stdout.push(data) },
      stderr: { write: (data) => stderr.push(data) },
      env: {},
      platform: "darwin",
      architecture: "arm64",
      nodeVersion: "24.19.0",
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      createSecret: () => `secret-${++secret}-abcdefghijklmnopqrstuvwxyz`,
      confirmCoreUpdate: async () => false,
      confirmReset: async () => false,
      imageReference: TEST_IMAGE
    }
  };
}

function result(status: number, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function composeCommand(call: Call): string[] {
  const fileFlagIndex = call.args.lastIndexOf("--file");
  if (fileFlagIndex === -1) return [];
  const commandIndex = fileFlagIndex + 2;
  return call.args.slice(commandIndex);
}

function installTestPluginCatalog(test: TestRuntime): PluginCatalogEntry {
  const packageRoot = join(test.home, "test-package");
  const assetsRoot = join(packageRoot, "assets");
  const pluginRoot = join(packageRoot, "assets", "plugins", "spatial_fixture");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(assetsRoot, "docker-compose.yml"), "services:\n  api:\n    image: ${ATLAS_CORE_IMAGE}\n");
  writeFileSync(join(assetsRoot, "source_gateway.production.json"), "{}\n");
  writeFileSync(join(pluginRoot, "compose.yml"), "services:\n  spatial-fixture-plugin:\n    image: fixture\n");
  writeFileSync(
    join(pluginRoot, "core-endpoint.json"),
    '{"id":"spatial_fixture","base_url":"http://spatial-fixture-plugin:8080"}\n'
  );
  writeFileSync(join(pluginRoot, "source-connector.json"), '{"id":"spatial_fixture"}\n');
  const plugin: PluginCatalogEntry = {
    pluginId: "spatial_fixture",
    displayName: "Spatial Fixture",
    lifecycle: "query_only",
    service: "spatial-fixture-plugin",
    image: TEST_PLUGIN_IMAGE,
    assets: {
      compose: "compose.yml",
      core_endpoint: "core-endpoint.json",
      source_connector: "source-connector.json"
    }
  };
  test.context.packageRoot = packageRoot;
  test.context.pluginCatalog = [plugin];
  return plugin;
}

function composeFile(call: Call): string | undefined {
  const fileFlagIndex = call.args.indexOf("--file");
  return fileFlagIndex === -1 ? undefined : call.args[fileFlagIndex + 1];
}

function markInitialized(test: TestRuntime, started = true): void {
  const config = join(test.home, ".atlas", "core");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, ".env"), "MINIO_BUCKET=atlas-media\nATLAS_ADMIN_PASSWORD='original-admin-password'\n", {
    mode: 0o600
  });
  test.runner.existingVolumes.add(MINIO_VOLUME);
  if (started) test.runner.existingVolumes.add(POSTGRES_VOLUME);
  writeFileSync(
    join(config, "state.json"),
    `${JSON.stringify({
      schema: 1,
      phase: "ready",
      initializedAt: "2026-08-28T12:00:00.000Z",
      packageVersion: PACKAGE_VERSION,
      dockerEngineId: "test-engine-id",
      ...(started
        ? {
            startAttemptedAt: "2026-08-28T12:04:00.000Z",
            startedAt: "2026-08-28T12:05:00.000Z"
          }
        : {})
    })}\n`,
    { mode: 0o600 }
  );
}

function setCoreVersion(test: TestRuntime, version: string): void {
  const statePath = join(test.home, ".atlas", "core", "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  writeFileSync(statePath, `${JSON.stringify({ ...state, packageVersion: version })}\n`, { mode: 0o600 });
}

function simulateInterruptedPluginDisable(
  test: TestRuntime,
  plugin: PluginCatalogEntry,
  stateCommitted: boolean
): void {
  const config = join(test.home, ".atlas", "core");
  const statePath = join(config, "state.json");
  const pluginPath = join(config, "plugins", plugin.pluginId);
  const lockId = "c".repeat(32);
  writeFileSync(
    join(pluginPath, "disable.json"),
    `${JSON.stringify({
      schema: 1,
      operation: "plugin-disable",
      pluginId: plugin.pluginId,
      previousStatus: test.runner.serviceStates.length === 0 ? "stopped" : "ready"
    })}\n`,
    { mode: 0o600 }
  );
  if (stateCommitted) {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(
      statePath,
      `${JSON.stringify({ ...state, enabledPlugins: state.enabledPlugins.filter((id: string) => id !== plugin.pluginId) })}\n`,
      { mode: 0o600 }
    );
  }

  writeFileSync(
    join(config, ".mutation.lock"),
    `${JSON.stringify({ schema: 1, id: lockId, pid: 2_147_483_647, operation: "plugin-disable" })}\n`,
    { mode: 0o600 }
  );
  test.runner.existingNetworks.add(MUTATION_LOCK_NETWORK);
  test.runner.networkLabels.set(MUTATION_LOCK_NETWORK, {
    "io.atlas.core.engine": "test-engine-id",
    "io.atlas.core.lock": "mutation",
    "io.atlas.core.project": "atlas_core_production",
    "io.atlas.core.lock-id": lockId
  });
}

describe("atlas-core CLI", () => {
  it("opens the interactive menu for no command", async () => {
    const test = runtime();
    let opened = false;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async () => {
        opened = true;
      },
      runUpdate: async () => undefined
    };
    expect(await runCLI([], test.context)).toBe(0);
    expect(opened).toBe(true);
    expect(test.runner.calls).toHaveLength(0);
  });

  it("still prints help without opening the menu", async () => {
    const test = runtime();
    expect(await runCLI(["help"], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("atlas-core config");
    expect(test.runner.calls).toHaveLength(0);
  });

  it("opens the interactive update menu when no update scope is supplied", async () => {
    const test = runtime();
    let opened = false;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async () => undefined,
      runUpdate: async () => {
        opened = true;
      }
    };

    expect(await runCLI(["update"], test.context)).toBe(0);
    expect(opened).toBe(true);
    expect(test.runner.calls).toHaveLength(0);
  });

  it("cancels pending commands and prevents later commands from starting", async () => {
    const test = runtime();
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async () => undefined,
      runUpdate: async (operator) => {
        operator.cancelPending();
        await expect(operator.checkForUpdates()).rejects.toThrow("Atlas Core command was cancelled.");
      }
    };

    expect(await runCLI(["update"], test.context)).toBe(0);
    expect(test.runner.cancelAllCalls).toBe(1);
    expect(test.runner.calls).toHaveLength(0);
  });

  it("allows later commands after the interface finishes cancellation cleanup", async () => {
    const test = runtime();
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async () => undefined,
      runUpdate: async (operator) => {
        operator.cancelPending();
        await expect(operator.checkForUpdates()).rejects.toThrow("Atlas Core command was cancelled.");
        operator.resumeAfterCancellation();
        await expect(operator.checkForUpdates()).resolves.toMatchObject({ latestVersion: PACKAGE_VERSION });
      }
    };

    expect(await runCLI(["update"], test.context)).toBe(0);
    expect(test.runner.cancelAllCalls).toBe(1);
    expect(test.runner.calls.some((call) => call.command === "npm" && call.args[0] === "view")).toBe(true);
  });

  it("allows initialization cleanup commands after cancellation", async () => {
    const test = runtime();
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        let cancelled = false;
        test.runner.onRun = (call) => {
          if (cancelled || composeCommand(call)[0] !== "up") return;
          cancelled = true;
          operator.cancelPending();
        };
        await expect(operator.init()).rejects.toThrow("Atlas Core command was cancelled.");
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["down"]);
    expect(test.runner.calls.some((call) => call.args[0] === "network" && call.args[1] === "rm")).toBe(true);
  });

  it("releases the Docker mutation lock when cancellation races successful acquisition", async () => {
    const test = runtime();
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.afterSuccessfulNetworkCreate = () => operator.cancelPending();
        await expect(operator.init()).rejects.toThrow("Atlas Core command was cancelled.");
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.runner.calls.some((call) => call.args[0] === "network" && call.args[1] === "rm")).toBe(true);
  });

  it("removes its Docker mutation lock when create succeeds before reporting cancellation", async () => {
    const test = runtime();
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.cancelAfterNetworkCreate = () => operator.cancelPending();
        await expect(operator.init()).rejects.toThrow("Atlas Core command was cancelled.");
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.runner.calls.some((call) => call.args[0] === "network" && call.args[1] === "inspect")).toBe(true);
    expect(test.runner.calls.some((call) => call.args[0] === "network" && call.args[1] === "rm")).toBe(true);
  });

  it("removes its Docker mutation lock when create succeeds before a transport failure", async () => {
    const test = runtime();
    test.runner.failAfterNetworkCreate = "connection reset by peer";

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("connection reset by peer");
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.runner.calls.some((call) => call.args[0] === "network" && call.args[1] === "inspect")).toBe(true);
    expect(
      test.runner.calls.some(
        (call) => call.args[0] === "network" && call.args[1] === "rm" && call.args[2] === "network-1"
      )
    ).toBe(true);
    expect(await runCLI(["init"], test.context)).toBe(0);
  });

  it("accepts Docker's missing-network response when ambiguous cleanup loses the inspect/remove race", async () => {
    const test = runtime();
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.nextNetworkRemovalError = (name) => `Error response from daemon: network ${name} not found`;
        test.runner.cancelAfterNetworkCreate = () => operator.cancelPending();
        await expect(operator.init()).rejects.toThrow("Atlas Core command was cancelled.");
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("accepts Docker's canonical missing-network response during ambiguous acquisition cleanup", async () => {
    const test = runtime();
    test.runner.missingNetworkError = (name) => `Error response from daemon: network ${name} not found`;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        let cancelled = false;
        test.runner.onRun = (call) => {
          if (cancelled || call.args[0] !== "network" || call.args[1] !== "create") return;
          cancelled = true;
          operator.cancelPending();
        };
        await expect(operator.init()).rejects.toThrow("Atlas Core command was cancelled.");
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.runner.calls.some((call) => call.args[0] === "network" && call.args[1] === "inspect")).toBe(true);
  });

  it("accepts Docker's canonical missing-network response when releasing a completed mutation", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.missingNetworkError = (name) => `Error response from daemon: network ${name} not found`;
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] !== "down") return;
      test.runner.existingNetworks.delete(MUTATION_LOCK_NETWORK);
      test.runner.networkLabels.delete(MUTATION_LOCK_NETWORK);
    };

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(existsSync(join(test.home, ".atlas", "core", ".mutation.lock"))).toBe(false);
    expect(test.stdout.join("")).toContain("Atlas Core stopped");
  });

  it("accepts Docker's missing-network response when release loses the inspect/remove race", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.nextNetworkRemovalError = (name) => `Error response from daemon: network ${name} not found`;

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(existsSync(join(test.home, ".atlas", "core", ".mutation.lock"))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.stdout.join("")).toContain("Atlas Core stopped");
  });

  it("propagates non-missing Docker network removal failures", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.nextNetworkRemovalError = () => "permission denied";

    expect(await runCLI(["stop"], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain("docker network rm");
    expect(test.stderr.join("")).toContain("permission denied");
    expect(existsSync(join(test.home, ".atlas", "core", ".mutation.lock"))).toBe(false);
  });

  it("retries retained Plugin-disable lock cleanup in the same interactive session", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const lockPath = join(test.home, ".atlas", "core", ".mutation.lock");
    let retryError: unknown;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.retainNetworkOnRemovalError = true;
        test.runner.nextNetworkRemovalError = () => "permission denied";
        await expect(operator.pluginDisable(plugin.pluginId)).rejects.toThrow("permission denied");
        expect(existsSync(lockPath)).toBe(true);
        try {
          await operator.stop();
        } catch (error) {
          retryError = error;
        }
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(retryError).toBeUndefined();
    expect(existsSync(lockPath)).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("recovers a Docker lock after its durable process-group clear fails", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.failProcessGroupClearAfterNetworkCreate = true;
        await expect(operator.pluginDisable(plugin.pluginId)).rejects.toThrow(
          "injected durable process-group clear failure"
        );

        const retainedOwner = JSON.parse(readFileSync(lockPath, "utf8"));
        expect(retainedOwner).toMatchObject({ operation: "plugin-disable", processGroupId: 2_000_000_000 });
        expect(test.runner.networkLabels.get(MUTATION_LOCK_NETWORK)).toMatchObject({
          "io.atlas.core.lock-id": retainedOwner.id
        });

        await expect(operator.pluginDisable(plugin.pluginId)).resolves.toMatchObject({ status: "success" });
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
  });

  it("recovers when the process-group clear was published before its durability failure", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.afterNetworkCreateEffect = (call) => {
          call.processGroup?.started(2_000_000_000);
          const canonicalOwner = JSON.parse(readFileSync(lockPath, "utf8"));
          const { processGroupId: _, ...clearedOwner } = canonicalOwner;
          writeFileSync(lockPath, `${JSON.stringify(clearedOwner)}\n`, { mode: 0o600 });
          throw new OperationCleanupError("injected post-publication durability failure");
        };
        await expect(operator.pluginDisable(plugin.pluginId)).rejects.toThrow(
          "injected post-publication durability failure"
        );

        expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });
        expect(JSON.parse(readFileSync(lockPath, "utf8"))).not.toHaveProperty("processGroupId");
        await expect(operator.pluginDisable(plugin.pluginId)).resolves.toMatchObject({ status: "success" });
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("preserves a retained Plugin-disable lock when the engine changes in the same interactive session", async () => {
    const test = runtime();
    markInitialized(test);
    test.context.confirmReset = async () => true;
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.retainNetworkOnRemovalError = true;
        test.runner.nextNetworkRemovalError = () => "permission denied";
        await expect(operator.pluginDisable(plugin.pluginId)).rejects.toThrow("permission denied");
        const retainedOwner = JSON.parse(readFileSync(lockPath, "utf8"));
        const retainedLabels = test.runner.networkLabels.get(MUTATION_LOCK_NETWORK);
        const retainedNetworkId = test.runner.networkIds.get(MUTATION_LOCK_NETWORK);

        test.runner.existingNetworks.delete(MUTATION_LOCK_NETWORK);
        test.runner.networkLabels.delete(MUTATION_LOCK_NETWORK);
        test.runner.networkIds.delete(MUTATION_LOCK_NETWORK);
        test.runner.dockerEngineId = "another-engine";
        test.runner.calls.length = 0;

        await expect(operator.stop()).rejects.toThrow("Restore the original Docker context");
        expect(test.runner.calls.some((call) => call.args[0] === "network")).toBe(false);
        expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(retainedOwner);

        test.runner.calls.length = 0;
        await expect(operator.reset()).rejects.toThrow("Restore the original Docker context before resetting");
        expect(test.runner.calls.some((call) => call.args[0] === "pull" || call.args[0] === "network")).toBe(false);
        expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(retainedOwner);

        test.runner.dockerEngineId = "test-engine-id";
        test.runner.existingNetworks.add(MUTATION_LOCK_NETWORK);
        if (retainedLabels) test.runner.networkLabels.set(MUTATION_LOCK_NETWORK, retainedLabels);
        if (retainedNetworkId) test.runner.networkIds.set(MUTATION_LOCK_NETWORK, retainedNetworkId);

        await expect(operator.stop()).resolves.toBeUndefined();
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("rechecks the reset engine after pull before acquiring a retained Plugin-disable lock", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    test.runner.dockerEngineId = "another-engine";
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    const retainedOwner = {
      schema: 1,
      id: "a".repeat(32),
      pid: 2_147_483_647,
      operation: "plugin-disable"
    } as const;
    let injectedRetainedOwner = false;
    test.runner.onRun = (call) => {
      if (injectedRetainedOwner || call.command !== "docker" || call.args[0] !== "pull") return;
      injectedRetainedOwner = true;
      markInitialized(test);
      writeFileSync(lockPath, `${JSON.stringify(retainedOwner)}\n`, { mode: 0o600 });
    };

    expect(await runCLI(["reset"], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain("Restore the original Docker context");
    expect(test.runner.calls.some((call) => call.args[0] === "network")).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(retainedOwner);

    test.runner.dockerEngineId = "test-engine-id";
    test.runner.existingNetworks.add(MUTATION_LOCK_NETWORK);
    test.runner.networkIds.set(MUTATION_LOCK_NETWORK, "retained-network");
    test.runner.networkLabels.set(MUTATION_LOCK_NETWORK, {
      "io.atlas.core.engine": "test-engine-id",
      "io.atlas.core.lock": "mutation",
      "io.atlas.core.project": "atlas_core_production",
      "io.atlas.core.lock-id": retainedOwner.id
    });
    test.stderr.length = 0;

    expect(await runCLI(["stop"], test.context)).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("keeps reset pinned to its validated Docker socket during a concurrent preflight", async () => {
    const test = runtime();
    markInitialized(test);
    test.context.confirmReset = async () => true;
    const validatedHost = test.runner.contextHost;
    let pullStarted: (() => void) | undefined;
    const pulling = new Promise<void>((resolve) => {
      pullStarted = resolve;
    });
    let releasePull: (() => void) | undefined;
    const holdPull = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const resumedResetCalls: Call[] = [];
    let hold = true;
    let captureReset = false;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.onRun = async (call) => {
          if (captureReset) resumedResetCalls.push(call);
          if (!hold || call.command !== "docker" || call.args[0] !== "pull" || call.args[1] !== TEST_IMAGE) return;
          hold = false;
          pullStarted?.();
          await holdPull;
        };
        const reset = operator.reset();
        await pulling;

        test.runner.contextHost = "unix:///alternate-docker.sock";
        test.runner.dockerEngineId = "alternate-engine";
        await expect(operator.details()).rejects.toThrow("Restore the original Docker context");
        test.runner.contextHost = validatedHost;
        test.runner.dockerEngineId = "test-engine-id";

        captureReset = true;
        releasePull?.();
        await expect(reset).resolves.toBeUndefined();
      }
    };

    expect(await runCLI([], test.context)).toBe(0);

    expect(resumedResetCalls.length).toBeGreaterThan(0);
    for (const call of resumedResetCalls.filter((candidate) => candidate.command === "docker")) {
      expect(call.env.DOCKER_HOST).toBe(validatedHost);
      expect(call.env.DOCKER_CONTEXT).toBeUndefined();
    }
  });

  it("does not share a Plugin-disable process-group fence with concurrent logs", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    let lockCreateStarted: (() => void) | undefined;
    const creatingLock = new Promise<void>((resolve) => {
      lockCreateStarted = resolve;
    });
    let releaseLockCreate: (() => void) | undefined;
    const holdLockCreate = new Promise<void>((resolve) => {
      releaseLockCreate = resolve;
    });
    let held = false;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.onRun = async (call) => {
          if (held || call.args[0] !== "network" || call.args[1] !== "create") return;
          held = true;
          lockCreateStarted?.();
          await holdLockCreate;
        };
        const disable = operator.pluginDisable(plugin.pluginId);
        await creatingLock;

        await operator.logs(undefined, true);
        const logs = test.runner.calls.find((call) => composeCommand(call)[0] === "logs");
        expect(logs?.processGroup).toBeUndefined();

        releaseLockCreate?.();
        await expect(disable).resolves.toMatchObject({ status: "success" });
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
  });

  it("serializes overlapping mutations in one interactive session", async () => {
    const test = runtime();
    markInitialized(test);
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let held = false;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.onRun = async (call) => {
          if (held || composeCommand(call)[0] !== "down") return;
          held = true;
          firstStarted?.();
          await holdFirst;
        };
        const firstMutation = operator.stop();
        await started;
        await expect(operator.restart()).rejects.toThrow("deployment mutation is locked by PID");
        releaseFirst?.();
        await expect(firstMutation).resolves.toBeUndefined();
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
  });

  it("bounds cleanup commands after cancellation", async () => {
    vi.useFakeTimers();
    const test = runtime();
    test.runner.hangCleanup = true;
    let cleanupStarted: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    test.runner.onCleanupStart = cleanupStarted;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        test.runner.afterSuccessfulNetworkCreate = () => operator.cancelPending();
        const operation = expect(operator.init()).rejects.toThrow("docker network inspect");
        await cleanup;
        await vi.advanceTimersByTimeAsync(130_000);
        await operation;
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
  });

  it("starts the cleanup deadline when rollback begins", async () => {
    vi.useFakeTimers();
    const test = runtime();
    test.runner.hangCleanup = true;
    let releaseForeground: (() => void) | undefined;
    const foreground = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });
    let foregroundStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      foregroundStarted = resolve;
    });
    let cleanupStarted: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let cleanupSignal: AbortSignal | undefined;
    test.runner.onCleanupStart = (signal) => {
      cleanupSignal = signal;
      cleanupStarted?.();
    };
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        let held = false;
        test.runner.onRun = async (call) => {
          if (held || composeCommand(call)[0] !== "up") return;
          held = true;
          operator.cancelPending();
          foregroundStarted?.();
          await foreground;
        };
        const operation = expect(operator.init()).rejects.toThrow("docker network inspect");
        await started;
        await vi.advanceTimersByTimeAsync(130_000);
        releaseForeground?.();
        await cleanup;
        expect(cleanupSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(129_999);
        expect(cleanupSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await operation;
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
  });

  it("does not strand a local lock when ordinary Docker lock cleanup fails", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] !== "down") return;
      test.runner.networkLabels.set(MUTATION_LOCK_NETWORK, {
        "io.atlas.core.engine": "test-engine-id",
        "io.atlas.core.lock": "mutation",
        "io.atlas.core.project": "atlas_core_production",
        "io.atlas.core.lock-id": "f".repeat(32)
      });
    };

    expect(await runCLI(["stop"], test.context)).toBe(1);

    const config = join(test.home, ".atlas", "core");
    expect(test.stderr.join("")).toContain("changed ownership before cleanup");
    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(true);
  });

  it("does not terminate a pending cleanup process when ordinary commands are cancelled", async () => {
    const runner = new ProcessCommandRunner();
    const operation = runner.run(process.execPath, ["-e", "setTimeout(() => {}, 2_000)"]);
    const cleanup = runner.runCleanup(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);

    runner.cancelAll();

    await expect(operation).resolves.toMatchObject({ status: 1 });
    await expect(cleanup).resolves.toMatchObject({ status: 0 });
  });

  it("force-terminates a command that ignores graceful cancellation", async () => {
    const runner = new ProcessCommandRunner();
    const directory = mkdtempSync(join(tmpdir(), "atlas-core-runner-test-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "ready");
    const operation = runner.run(process.execPath, [
      "-e",
      `process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ready");
      setInterval(() => {}, 30_000);`
    ]);

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    runner.cancelAll();

    await expect(operation).resolves.toMatchObject({ cancelled: true, status: 1 });
  });

  it("does not cancel a successful command waiting for inherited output to close", async () => {
    const runner = new ProcessCommandRunner();
    const directory = mkdtempSync(join(tmpdir(), "atlas-core-runner-test-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "pid");
    const operation = runner.run(process.execPath, [
      "-e",
      `const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      child.unref();
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      process.exit(0);`
    ]);

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    const childPid = Number(readFileSync(marker, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow());
    runner.cancelAll();

    await expect(operation).resolves.toEqual(result(0));
  });

  it("does not start a supervised command until its process group is durably recorded", async () => {
    const runner = new ProcessCommandRunner();
    const directory = mkdtempSync(join(tmpdir(), "atlas-core-runner-test-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "started");
    let finished = false;

    await expect(
      runner.run(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes")`], {
        processGroup: {
          started: () => {
            throw new Error("injected durable lock failure");
          },
          finished: () => {
            finished = true;
          }
        }
      })
    ).rejects.toThrow("injected durable lock failure");

    expect(existsSync(marker)).toBe(false);
    expect(finished).toBe(false);
  });

  it("runs a supervised command inside the recorded process group", async () => {
    const runner = new ProcessCommandRunner();
    let startedProcessGroup: number | undefined;
    let finishedProcessGroup: number | undefined;

    const command = await runner.run(process.execPath, ["-e", 'process.stdout.write("supervised")'], {
      processGroup: {
        started: (processGroupId) => {
          startedProcessGroup = processGroupId;
          expect(() => process.kill(-processGroupId, 0)).not.toThrow();
        },
        finished: (processGroupId) => {
          finishedProcessGroup = processGroupId;
        }
      }
    });

    expect(command).toEqual(result(0, "supervised"));
    expect(startedProcessGroup).toEqual(expect.any(Number));
    expect(finishedProcessGroup).toBe(startedProcessGroup);
  });

  it("reports a failed supervised process-group clear as recovery work", async () => {
    const runner = new ProcessCommandRunner();

    await expect(
      runner.run(process.execPath, ["-e", "process.exit(0)"], {
        processGroup: {
          started: () => undefined,
          finished: () => {
            throw new Error("injected durable process-group clear failure");
          }
        }
      })
    ).rejects.toBeInstanceOf(OperationCleanupError);
  });

  it("does not clear a supervised process-group fence while a successful descendant is still alive", async () => {
    const runner = new ProcessCommandRunner();
    const directory = mkdtempSync(join(tmpdir(), "atlas-core-runner-test-"));
    temporaryDirectories.push(directory);
    const ready = join(directory, "ready");
    const descendantSource = `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "yes");
      setInterval(() => {}, 30_000);`;
    let processGroupId: number | undefined;
    let finished = false;
    const operation = runner.run(
      process.execPath,
      [
        "-e",
        `const child = require("node:child_process").spawn(
          process.execPath,
          ["-e", ${JSON.stringify(descendantSource)}],
          { stdio: "ignore" }
        );
        child.unref();`
      ],
      {
        processGroup: {
          started: (groupId) => {
            processGroupId = groupId;
          },
          finished: () => {
            finished = true;
          }
        }
      }
    );

    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    try {
      const state = await Promise.race([
        operation.then(() => "resolved" as const),
        new Promise<"waiting">((resolveWait) => setTimeout(() => resolveWait("waiting"), 200))
      ]);
      expect(state).toBe("waiting");
      expect(finished).toBe(false);
    } finally {
      if (processGroupId !== undefined) {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {}
      }
    }

    await expect(operation).resolves.toEqual(result(0));
    expect(finished).toBe(true);
  });

  it("runs a supervised command when NODE_OPTIONS selects module eval", async () => {
    const runner = new ProcessCommandRunner();
    let startedProcessGroup: number | undefined;
    let finishedProcessGroup: number | undefined;

    const command = await runner.run(process.execPath, ["-e", 'process.stdout.write("supervised")'], {
      env: { ...process.env, NODE_OPTIONS: "--input-type=module" },
      processGroup: {
        started: (processGroupId) => {
          startedProcessGroup = processGroupId;
        },
        finished: (processGroupId) => {
          finishedProcessGroup = processGroupId;
        }
      }
    });

    expect(command).toEqual(result(0, "supervised"));
    expect(startedProcessGroup).toEqual(expect.any(Number));
    expect(finishedProcessGroup).toBe(startedProcessGroup);
  });

  it("does not clear a supervised process-group fence while a cancelled child is still alive", async () => {
    const runner = new ProcessCommandRunner();
    const directory = mkdtempSync(join(tmpdir(), "atlas-core-runner-test-"));
    temporaryDirectories.push(directory);
    const ready = join(directory, "ready");
    const survived = join(directory, "survived");
    let processGroupId: number | undefined;
    const operation = runner.run(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => {
          setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(survived)}, "yes"), 2_100);
        });
        require("node:fs").closeSync(1);
        require("node:fs").closeSync(2);
        require("node:fs").writeFileSync(${JSON.stringify(ready)}, "yes");
        setInterval(() => {}, 30_000);`
      ],
      {
        processGroup: {
          started: (groupId) => {
            processGroupId = groupId;
          },
          finished: () => undefined
        }
      }
    );

    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    const cancelledAt = Date.now();
    runner.cancelAll();

    try {
      await expect(operation).resolves.toMatchObject({ cancelled: true, status: 1 });
      const remaining = Math.max(0, 2_300 - (Date.now() - cancelledAt));
      if (remaining > 0) await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
      expect(existsSync(survived)).toBe(false);
    } finally {
      if (processGroupId !== undefined) {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {}
      }
    }
  });

  it("does not clear a supervised process-group fence while a same-group descendant is still alive", async () => {
    const runner = new ProcessCommandRunner();
    const directory = mkdtempSync(join(tmpdir(), "atlas-core-runner-test-"));
    temporaryDirectories.push(directory);
    const ready = join(directory, "ready");
    const survived = join(directory, "survived");
    const descendantSource = `process.on("SIGTERM", () => {
      setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(survived)}, "yes"), 2_100);
    });
    require("node:fs").writeFileSync(${JSON.stringify(ready)}, "yes");
    setInterval(() => {}, 30_000);`;
    let processGroupId: number | undefined;
    const operation = runner.run(
      process.execPath,
      [
        "-e",
        `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
          stdio: "ignore"
        });
        setInterval(() => {}, 30_000);`
      ],
      {
        processGroup: {
          started: (groupId) => {
            processGroupId = groupId;
          },
          finished: () => undefined
        }
      }
    );

    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    const cancelledAt = Date.now();
    runner.cancelAll();

    try {
      await expect(operation).resolves.toMatchObject({ cancelled: true, status: 1 });
      const remaining = Math.max(0, 2_300 - (Date.now() - cancelledAt));
      if (remaining > 0) await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
      expect(existsSync(survived)).toBe(false);
    } finally {
      if (processGroupId !== undefined) {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {}
      }
    }
  });

  it("rejects unknown update scopes", async () => {
    const test = runtime();
    expect(await runCLI(["update", "core"], test.context)).toBe(2);
    expect(test.stderr.join("")).toContain("update accepts cli or all");
    expect(test.runner.calls).toHaveLength(0);
  });

  it("does not install a release newer than the one reviewed in the menu", async () => {
    const test = runtime();
    test.runner.latestVersion = NEXT_PACKAGE_VERSION;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async () => undefined,
      runUpdate: async (operator) => {
        const info = await operator.checkForUpdates();
        test.runner.latestVersion = FOLLOWING_PACKAGE_VERSION;
        await operator.update("cli", info.latestVersion);
      }
    };

    expect(await runCLI(["update"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain(`changed from ${NEXT_PACKAGE_VERSION} to ${FOLLOWING_PACKAGE_VERSION}`);
    expect(test.runner.installedVersion).toBe(PACKAGE_VERSION);
  });

  it("does not accept an admin password as a command argument", async () => {
    const test = runtime();
    expect(await runCLI(["config", "correct-horse-battery-staple"], test.context)).toBe(2);
    expect(test.stderr.join("")).toContain("config does not accept arguments");
    expect(test.stderr.join("")).not.toContain("correct-horse-battery-staple");
    expect(test.runner.calls).toHaveLength(0);
  });

  it("rejects unknown commands with usage", async () => {
    const test = runtime();
    expect(await runCLI(["launch"], test.context)).toBe(2);
    expect(test.stderr.join("")).toContain("Unknown command: launch");
    expect(test.stderr.join("")).toContain("atlas-core start");
  });

  it("rejects hosts without a published image architecture", async () => {
    const test = runtime();
    test.context.architecture = "ppc64";

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("supports arm64 and x64 hosts");
    expect(test.runner.calls).toHaveLength(0);
  });

  it("rejects a remote Docker context before creating configuration", async () => {
    const test = runtime();
    test.runner.contextHost = "ssh://core.example.com";
    test.context.env = { DOCKER_CONTEXT: "remote", DOCKER_HOST: "unix:///var/run/docker.sock" };

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("requires a local Docker daemon over a Unix socket");
    expect(existsSync(join(test.home, ".atlas", "core"))).toBe(false);
  });

  it("rejects a non-Linux Docker daemon before creating configuration", async () => {
    const test = runtime();
    test.runner.dockerOperatingSystem = "windows";

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("requires a Linux Docker daemon");
    expect(existsSync(join(test.home, ".atlas", "core"))).toBe(false);
  });

  it("rejects an unsupported Docker daemon architecture before creating configuration", async () => {
    const test = runtime();
    test.runner.dockerArchitecture = "s390x";

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("supports amd64 and arm64 Docker daemons");
    expect(existsSync(join(test.home, ".atlas", "core"))).toBe(false);
  });

  it("initializes only a new durable deployment", async () => {
    const test = runtime();
    expect(await runCLI(["init"], test.context)).toBe(0);

    const config = join(test.home, ".atlas", "core");
    const env = readFileSync(join(config, ".env"), "utf8");
    expect(env).toContain("POSTGRES_PASSWORD=secret-1-");
    expect(env).toContain("MINIO_ROOT_PASSWORD=secret-2-");
    expect(env).toContain("API_AUTH_KEY=secret-3-");
    expect(env).toContain("ATLAS_ADMIN_PASSWORD=secret-4-");
    expect(JSON.parse(readFileSync(join(config, "state.json"), "utf8"))).toEqual({
      schema: 2,
      phase: "ready",
      initializedAt: "2026-08-28T12:00:00.000Z",
      packageVersion: PACKAGE_VERSION,
      dockerEngineId: "test-engine-id",
      enabledPlugins: []
    });
    expect(statSync(join(config, ".env")).mode & 0o077).toBe(0);
    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
    expect(test.runner.existingNetworks).not.toContain(MUTATION_LOCK_NETWORK);
    expect(test.runner.existingVolumes).toContain(MINIO_VOLUME);
    expect(test.runner.existingVolumes).not.toContain(POSTGRES_VOLUME);
    const composeCalls = test.runner.calls.filter((call) => composeCommand(call).length > 0);
    expect(composeCalls.every((call) => composeFile(call)?.endsWith("docker-compose.init.yml"))).toBe(true);
    expect(composeCalls.map(composeCommand)).toEqual([
      ["up", "-d", "--wait", "--wait-timeout", "120", "minio"],
      [
        "exec",
        "-T",
        "minio",
        "sh",
        "-c",
        'mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'
      ],
      ["exec", "-T", "minio", "mc", "mb", "--ignore-existing", "local/atlas-media"],
      ["exec", "-T", "minio", "mc", "anonymous", "set", "none", "local/atlas-media"],
      ["down"]
    ]);
  });

  it("refuses to create credentials over existing volumes", async () => {
    const test = runtime();
    test.runner.existingVolumes.add(POSTGRES_VOLUME);
    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("containers or durable volumes without matching CLI configuration");
  });

  it("refuses to reuse an unmatched Core container", async () => {
    const test = runtime();
    test.runner.existingContainers.add(API_CONTAINER);
    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("containers or durable volumes without matching CLI configuration");
  });

  it("refuses to reuse an unmatched MinIO initializer container", async () => {
    const test = runtime();
    test.runner.existingContainers.add(MINIO_INIT_CONTAINER);
    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("containers or durable volumes without matching CLI configuration");
  });

  it("serializes concurrent initialization", async () => {
    const test = runtime();
    const config = join(test.home, ".atlas", "core");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, ".mutation.lock"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("deployment mutation is locked");
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toHaveLength(0);
  });

  it("fails closed on a stale initialization lock", async () => {
    const test = runtime();
    const config = join(test.home, ".atlas", "core");
    const lock = join(config, ".mutation.lock");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(lock, `${JSON.stringify({ pid: 2_147_483_647 })}\n`, { mode: 0o600 });

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("If no atlas-core process is changing the deployment, remove that file");
    expect(existsSync(lock)).toBe(true);
  });

  it("serializes initialization across configuration directories on one Docker engine", async () => {
    const test = runtime();
    test.runner.existingNetworks.add(MUTATION_LOCK_NETWORK);
    test.context.env = { ATLAS_CORE_HOME: join(test.home, "another-core-home") };

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("deployment mutation is already locked on Docker engine");
    expect(existsSync(join(test.home, "another-core-home", ".env"))).toBe(false);
  });

  it("rejects Docker Compose versions without the required wait timeout", async () => {
    const test = runtime();
    test.runner.composeVersion = "2.16.0";

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("requires Docker Compose 2.17.0 or newer");
    expect(existsSync(join(test.home, ".atlas", "core"))).toBe(false);
  });

  it("rejects arbitrary credentials without matching initialization state", async () => {
    const test = runtime();
    const config = join(test.home, ".atlas", "core");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, ".env"), "POSTGRES_PASSWORD=unmatched\n", { mode: 0o600 });

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("without matching initialization state");
  });

  it("resumes interrupted initialization when no lock remains", async () => {
    const test = runtime();
    const config = join(test.home, ".atlas", "core");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, ".env"), "POSTGRES_PASSWORD=initializing\n", { mode: 0o600 });
    writeFileSync(
      join(config, "state.json"),
      `${JSON.stringify({
        schema: 1,
        phase: "initializing",
        initializedAt: "2026-08-28T12:00:00.000Z",
        packageVersion: PACKAGE_VERSION,
        dockerEngineId: "test-engine-id"
      })}\n`,
      { mode: 0o600 }
    );

    expect(await runCLI(["init"], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("Atlas Core initialized");
  });

  it("reads a quoted bucket name like Compose", async () => {
    const test = runtime();
    const config = join(test.home, ".atlas", "core");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, ".env"), 'MINIO_BUCKET="custom-bucket"   \n', { mode: 0o600 });
    writeFileSync(
      join(config, "state.json"),
      `${JSON.stringify({
        schema: 1,
        phase: "initializing",
        initializedAt: "2026-08-28T12:00:00.000Z",
        packageVersion: PACKAGE_VERSION,
        dockerEngineId: "test-engine-id"
      })}\n`,
      { mode: 0o600 }
    );
    test.runner.existingVolumes.add(MINIO_VOLUME);

    expect(await runCLI(["init"], test.context)).toBe(0);
    expect(test.runner.calls.map(composeCommand)).toContainEqual([
      "exec",
      "-T",
      "minio",
      "mc",
      "mb",
      "--ignore-existing",
      "local/custom-bucket"
    ]);
  });

  it("reports a failed cleanup after initialization fails", async () => {
    const test = runtime();
    test.runner.failComposeUp = true;
    test.runner.failComposeDown = true;

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("Cleanup also failed");
    expect(test.stderr.join("")).toContain("injected compose down failure");
  });

  it("propagates Docker inspection failures", async () => {
    const test = runtime();
    test.runner.inspectionError = { kind: "volume", name: POSTGRES_VOLUME };

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("permission denied");
  });

  it("rejects same-name storage without Compose ownership labels", async () => {
    const test = runtime();
    const volume = POSTGRES_VOLUME;
    test.runner.existingVolumes.add(volume);
    test.runner.mismatchedResources.add(volume);

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("ownership label");
  });

  it("reads container ownership labels from the Docker container config", async () => {
    const test = runtime();
    const container = API_CONTAINER;
    test.runner.existingContainers.add(container);

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("containers or durable volumes without matching CLI configuration");
    expect(test.runner.calls).toContainEqual(
      expect.objectContaining({
        command: "docker",
        args: ["container", "inspect", "--format", "{{json .Config.Labels}}", container]
      })
    );
  });

  it("does not reprovision an initialized deployment", async () => {
    const test = runtime();
    markInitialized(test);
    expect(await runCLI(["init"], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("already initialized");
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "up")).toBe(false);
  });

  it("cancels reset unless the operator confirms", async () => {
    const test = runtime();
    markInitialized(test);

    expect(await runCLI(["reset"], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("Reset permanently deletes Atlas Core containers");
    expect(test.stdout.join("")).toContain("Atlas Core reset cancelled");
    expect(test.runner.calls).toHaveLength(0);
    expect(existsSync(join(test.home, ".atlas", "core", ".env"))).toBe(true);
    expect(test.runner.existingVolumes).toContain(POSTGRES_VOLUME);
  });

  it("deletes an existing deployment and starts fresh with the installed release", async () => {
    const test = runtime();
    test.context.confirmReset = async (question) => question === "Continue? [y/N] ";
    const containers = [
      API_CONTAINER,
      SOURCE_GATEWAY_CONTAINER,
      POSTGRES_CONTAINER,
      MINIO_CONTAINER,
      MINIO_INIT_CONTAINER
    ];
    for (const container of containers) test.runner.existingContainers.add(container);
    test.runner.existingVolumes.add(POSTGRES_VOLUME);
    test.runner.existingVolumes.add(MINIO_VOLUME);
    test.runner.volumeUsers.set(POSTGRES_VOLUME, new Set([POSTGRES_CONTAINER]));
    test.runner.volumeUsers.set(MINIO_VOLUME, new Set([MINIO_CONTAINER]));

    expect(await runCLI(["reset"], test.context)).toBe(0);

    expect(test.runner.existingContainers).not.toContain(API_CONTAINER);
    expect(test.runner.existingVolumes).toContain(POSTGRES_VOLUME);
    expect(test.runner.existingVolumes).toContain(MINIO_VOLUME);
    expect(test.runner.calls).toContainEqual(
      expect.objectContaining({ command: "docker", args: ["pull", TEST_IMAGE] })
    );
    for (const container of containers) {
      expect(test.runner.calls).toContainEqual(
        expect.objectContaining({ command: "docker", args: ["container", "rm", "--force", container] })
      );
    }
    const state = JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"));
    expect(state).toMatchObject({ phase: "ready", packageVersion: PACKAGE_VERSION, dockerEngineId: "test-engine-id" });
    expect(test.stdout.join("")).toContain(`Atlas Core ${PACKAGE_VERSION} reset is complete`);
  });

  it("allows an installed release to reset a deployment initialized by an older CLI", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    markInitialized(test);
    test.runner.existingContainers.add(POSTGRES_CONTAINER);
    test.runner.existingContainers.add(MINIO_CONTAINER);
    test.runner.volumeUsers.set(POSTGRES_VOLUME, new Set([POSTGRES_CONTAINER]));
    test.runner.volumeUsers.set(MINIO_VOLUME, new Set([MINIO_CONTAINER]));
    const statePath = join(test.home, ".atlas", "core", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, `${JSON.stringify({ ...state, packageVersion: "0.1.0" })}\n`, { mode: 0o600 });

    expect(await runCLI(["reset"], test.context)).toBe(0);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ packageVersion: PACKAGE_VERSION });
  });

  it("resets when recorded Plugin Compose fragments are already missing", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    markInitialized(test);
    const statePath = join(test.home, ".atlas", "core", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, `${JSON.stringify({ ...state, schema: 2, enabledPlugins: ["missing_plugin"] })}\n`, {
      mode: 0o600
    });

    expect(await runCLI(["reset"], test.context)).toBe(0);
    expect(test.runner.calls.some((call) => call.args.includes("missing_plugin/compose.yml"))).toBe(false);
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["down", "--remove-orphans"]);
  });

  it("removes project Plugin containers when reset configuration is incomplete", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    markInitialized(test);
    const pluginContainer = `${PROJECT_NAME}_spatial_fixture`;
    test.runner.existingContainers.add(pluginContainer);
    rmSync(join(test.home, ".atlas", "core", ".env"));

    expect(await runCLI(["reset"], test.context)).toBe(0);
    expect(test.runner.existingContainers).not.toContain(pluginContainer);
    expect(test.runner.calls).toContainEqual(
      expect.objectContaining({
        command: "docker",
        args: ["container", "rm", "--force", pluginContainer]
      })
    );
  });

  it("refuses to reset a same-name resource without matching ownership labels", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    const container = API_CONTAINER;
    test.runner.existingContainers.add(container);
    test.runner.mismatchedResources.add(container);

    expect(await runCLI(["reset"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("ownership label");
    expect(test.runner.existingContainers).toContain(container);
    expect(
      test.runner.calls.some(
        (call) => (call.args[0] === "container" || call.args[0] === "volume") && call.args[1] === "rm"
      )
    ).toBe(false);
  });

  it("refuses to reset a volume used by an unknown container", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    const volume = POSTGRES_VOLUME;
    test.runner.existingVolumes.add(volume);
    test.runner.volumeUsers.set(volume, new Set(["backup-reader"]));

    expect(await runCLI(["reset"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("backup-reader");
    expect(test.stderr.join("")).toContain("before deleting anything");
    expect(test.runner.existingVolumes).toContain(volume);
    expect(
      test.runner.calls.some(
        (call) => (call.args[0] === "container" || call.args[0] === "volume") && call.args[1] === "rm"
      )
    ).toBe(false);
  });

  it("requires init before starting", async () => {
    const test = runtime();
    expect(await runCLI(["start"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("Run atlas-core init first");
    expect(test.runner.calls).toHaveLength(0);
  });

  it("starts the package-matched Core image", async () => {
    const test = runtime();
    markInitialized(test, false);
    expect(await runCLI(["start"], test.context)).toBe(0);
    const up = test.runner.calls.find((call) => composeCommand(call)[0] === "up");
    expect(up?.env.ATLAS_CORE_IMAGE).toBe(TEST_IMAGE);
    expect(up && composeCommand(up)).toEqual([
      "up",
      "-d",
      "--pull",
      "always",
      "--remove-orphans",
      "--wait",
      "--wait-timeout",
      "120"
    ]);
    expect(test.runner.existingVolumes).toContain(POSTGRES_VOLUME);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      startedAt: "2026-08-28T12:00:00.000Z"
    });
  });

  it("refuses to start from an unreleased package without a pinned image", async () => {
    const test = runtime();
    markInitialized(test, false);
    test.context.imageReference = "";

    expect(await runCLI(["start"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("has no pinned Core image");
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "up")).toBe(false);
  });

  it("does not let caller environment variables override generated configuration", async () => {
    const test = runtime();
    markInitialized(test, false);
    test.context.env = {
      PATH: "/usr/bin:/bin",
      COMPOSE_FILE: "/tmp/attacker.yml",
      COMPOSE_IGNORE_ORPHANS: "1",
      COMPOSE_REMOVE_ORPHANS: "1",
      ATLAS_PLUGINS: '[{"id":"caller","base_url":"http://caller:8080"}]',
      ATLAS_SOURCE_GATEWAY_CONFIG_FILE: "/tmp/caller-gateway.json",
      POSTGRES_PASSWORD: "caller-postgres",
      MINIO_ROOT_PASSWORD: "caller-minio"
    };

    expect(await runCLI(["start"], test.context)).toBe(0);
    const up = test.runner.calls.find((call) => composeCommand(call)[0] === "up");
    expect(up?.env.PATH).toBe("/usr/bin:/bin");
    expect(up?.env.POSTGRES_PASSWORD).toBeUndefined();
    expect(up?.env.MINIO_ROOT_PASSWORD).toBeUndefined();
    expect(up?.env.ATLAS_PLUGINS).toBeUndefined();
    expect(up?.env.ATLAS_SOURCE_GATEWAY_CONFIG_FILE).toBeUndefined();
    expect(up?.env.COMPOSE_FILE).toBeUndefined();
    expect(up?.env.COMPOSE_IGNORE_ORPHANS).toBe("0");
    expect(up?.env.COMPOSE_REMOVE_ORPHANS).toBe("0");
  });

  it("pulls a restart image before stopping the running deployment", async () => {
    const test = runtime();
    markInitialized(test);

    expect(await runCLI(["restart"], test.context)).toBe(0);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["pull"],
      ["down"],
      ["up", "-d", "--pull", "never", "--remove-orphans", "--wait", "--wait-timeout", "120"]
    ]);
  });

  it("changes only the admin password and defers applying it while stopped", async () => {
    const test = runtime();
    markInitialized(test, false);
    test.runner.serviceStates = [];
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("correct-horse-battery-staple");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(0);

    const env = readFileSync(join(test.home, ".atlas", "core", ".env"), "utf8");
    expect(env).toContain("MINIO_BUCKET=atlas-media");
    expect(env).toContain('ATLAS_ADMIN_PASSWORD="correct-horse-battery-staple"');
    expect(statSync(join(test.home, ".atlas", "core", ".env")).mode & 0o077).toBe(0);
    expect(test.stdout.join("")).not.toContain("correct-horse-battery-staple");
    expect(test.stdout.join("")).toContain("take effect the next time Atlas Core starts");
    expect(test.runner.calls.map(composeCommand).filter((args) => args[0] === "down" || args[0] === "up")).toEqual([]);
  });

  it("quotes admin passwords without changing Compose-literal characters", async () => {
    const test = runtime();
    markInitialized(test, false);
    test.runner.serviceStates = [];
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("correct$horse#battery'staple\\end\"quoted");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(0);
    expect(readFileSync(join(test.home, ".atlas", "core", ".env"), "utf8")).toContain(
      `ATLAS_ADMIN_PASSWORD="correct$$horse#battery'staple\\\\end\\"quoted"`
    );
  });

  it("quotes an admin password ending in a backslash", async () => {
    const test = runtime();
    markInitialized(test, false);
    test.runner.serviceStates = [];
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("correct-horse-battery-staple\\");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(0);
    expect(readFileSync(join(test.home, ".atlas", "core", ".env"), "utf8")).toContain(
      `ATLAS_ADMIN_PASSWORD="correct-horse-battery-staple\\\\"`
    );
  });

  it("restarts a running deployment after changing the admin password", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    test.runner.calls.length = 0;
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(0);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["ps", "--all", "--format", "json"],
      ["pull"],
      ["down"],
      ["up", "-d", "--pull", "never", "--remove-orphans", "--wait", "--wait-timeout", "120"]
    ]);
    const pluginCompose = join(test.home, ".atlas", "core", "plugins", plugin.pluginId, "compose.yml");
    for (const call of test.runner.calls.filter((candidate) => composeCommand(candidate).length > 0)) {
      expect(call.args).toContain(pluginCompose);
    }
    expect(readFileSync(join(test.home, ".atlas", "core", ".env"), "utf8")).toContain(
      'ATLAS_ADMIN_PASSWORD="new-production-password"'
    );
    expect(test.stdout.join("")).toContain("Atlas Core admin password updated for username admin");
  });

  it("refuses to change a running admin password when paired durable storage is missing", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.existingVolumes.delete(POSTGRES_VOLUME);
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("durable storage is missing");
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.runner.calls.some((call) => ["pull", "down", "up"].includes(composeCommand(call)[0] ?? ""))).toBe(
      false
    );
  });

  it("pulls before disruption and preserves the running password when the pull fails", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.failComposePull = true;
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["ps", "--all", "--format", "json"],
      ["pull"]
    ]);
    expect(test.stdout.join("")).not.toContain("admin password updated");
  });

  it("refuses to change a running admin password while a required Core service is degraded", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.serviceStates = test.runner.serviceStates.map((service) =>
      service.Service === "api" ? { ...service, Health: "unhealthy" } : service
    );
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("Running admin password changes require the current deployment");
    expect(test.stderr.join("")).toContain("api is unhealthy");
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["ps", "--all", "--format", "json"]
    ]);
  });

  it("refuses to change a running admin password while an enabled Plugin service is missing", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    test.runner.serviceStates = test.runner.serviceStates.filter((service) => service.Service !== plugin.service);
    test.runner.calls.length = 0;
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain(`${plugin.service} is missing`);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["ps", "--all", "--format", "json"]
    ]);
  });

  it("restores the prior password and deployment after a partial stop failure", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.failComposeDown = true;
    let downCalls = 0;
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] !== "down") return;
      downCalls++;
      if (downCalls === 2) test.runner.failComposeDown = false;
    };
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.stderr.join("")).toContain("previous admin password and running deployment were restored");
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["ps", "--all", "--format", "json"],
      ["pull"],
      ["down"],
      ["down"],
      ["up", "-d", "--pull", "never", "--remove-orphans", "--wait", "--wait-timeout", "120"]
    ]);
  });

  it("restores the prior password and deployment after replacement startup fails", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.failComposeUp = true;
    let upCalls = 0;
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] !== "up") return;
      upCalls++;
      if (upCalls === 2) test.runner.failComposeUp = false;
    };
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.stderr.join("")).toContain("previous admin password and running deployment were restored");
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["ps", "--all", "--format", "json"],
      ["pull"],
      ["down"],
      ["up", "-d", "--pull", "never", "--remove-orphans", "--wait", "--wait-timeout", "120"],
      ["down"],
      ["up", "-d", "--pull", "never", "--remove-orphans", "--wait", "--wait-timeout", "120"]
    ]);
    expect(test.stdout.join("")).not.toContain("admin password updated");
  });

  it("preserves cancellation after restoring the prior password and deployment", async () => {
    const test = runtime();
    markInitialized(test);
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        let cancelled = false;
        test.runner.onRun = (call) => {
          if (cancelled || composeCommand(call)[0] !== "up") return;
          cancelled = true;
          operator.cancelPending();
        };
        await expect(operator.configureAdminPassword("new-production-password")).rejects.toMatchObject({
          message: "Atlas Core command was cancelled.",
          name: "CommandCancelledError"
        });
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(0);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["ps", "--all", "--format", "json"],
      ["pull"],
      ["down"],
      ["up", "-d", "--pull", "never", "--remove-orphans", "--wait", "--wait-timeout", "120"],
      ["down"],
      ["up", "-d", "--pull", "never", "--remove-orphans", "--wait", "--wait-timeout", "120"]
    ]);
    expect(test.stdout.join("")).not.toContain("admin password updated");
  });

  it("preserves cancellation that arrives after a successful replacement command result", async () => {
    const test = runtime();
    markInitialized(test);
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        test.runner.afterSuccessfulComposeUp = () => operator.cancelPending();
        await expect(operator.configureAdminPassword("new-production-password")).rejects.toMatchObject({
          message: "Atlas Core command was cancelled.",
          name: "CommandCancelledError"
        });
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(0);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.runner.calls.filter((call) => composeCommand(call)[0] === "up")).toHaveLength(2);
    expect(test.stdout.join("")).not.toContain("admin password updated");
  });

  it("reports when the prior deployment cannot be restored", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.failComposeUp = true;
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.stderr.join("")).toContain("Rollback also reported");
    expect(test.runner.calls.filter((call) => composeCommand(call)[0] === "up")).toHaveLength(2);
    expect(test.stdout.join("")).not.toContain("admin password updated");
  });

  it("does not restart when the previous configuration cannot be restored", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.failComposeUp = true;
    const envPath = join(test.home, ".atlas", "core", ".env");
    let replacementStarted = false;
    test.runner.onRun = (call) => {
      if (replacementStarted || composeCommand(call)[0] !== "up") return;
      replacementStarted = true;
      rmSync(envPath);
      mkdirSync(envPath);
    };
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(statSync(envPath).isDirectory()).toBe(true);
    expect(test.stderr.join("")).toContain("Rollback also reported");
    expect(test.runner.calls.filter((call) => composeCommand(call)[0] === "up")).toHaveLength(1);
    expect(test.stdout.join("")).not.toContain("admin password updated");
  });

  it("rejects a weak admin password without changing configuration", async () => {
    const test = runtime();
    markInitialized(test);
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("development default");
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.runner.calls).toHaveLength(0);
  });

  it("rejects an uppercase example password", async () => {
    const test = runtime();
    markInitialized(test);
    const envPath = join(test.home, ".atlas", "core", ".env");
    const before = readFileSync(envPath, "utf8");
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("REPLACE_WITH_SECURE_ADMIN_PASSWORD");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("development default");
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(test.runner.calls).toHaveLength(0);
  });

  it("can retry a failed first full-stack start", async () => {
    const test = runtime();
    markInitialized(test, false);
    test.runner.failComposeUp = true;

    expect(await runCLI(["start"], test.context)).toBe(1);
    const statePath = join(test.home, ".atlas", "core", "state.json");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      startAttemptedAt: "2026-08-28T12:00:00.000Z"
    });

    test.runner.failComposeUp = false;
    expect(await runCLI(["start"], test.context)).toBe(0);
  });

  it("refuses to recreate missing durable storage", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.existingVolumes.delete(POSTGRES_VOLUME);
    expect(await runCLI(["start"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("durable storage is missing");
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "up")).toBe(false);
  });

  it("blocks an implicit Core version upgrade", async () => {
    const test = runtime();
    markInitialized(test);
    setCoreVersion(test, "0.0.9");
    expect(await runCLI(["start"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("Run atlas-core update all");
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "up")).toBe(false);
  });

  it("lets a newer CLI inspect an older running Core", async () => {
    const test = runtime();
    markInitialized(test);
    setCoreVersion(test, "0.1.2");

    expect(await runCLI(["status"], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("Atlas Core is running");
  });

  it("updates only the global CLI when requested", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.latestVersion = NEXT_PACKAGE_VERSION;

    expect(await runCLI(["update", "cli"], test.context)).toBe(0);
    expect(test.runner.installedVersion).toBe(NEXT_PACKAGE_VERSION);
    expect(test.runner.calls).toContainEqual(
      expect.objectContaining({
        command: "npm",
        args: ["install", "--global", `atlas-core@${NEXT_PACKAGE_VERSION}`],
        inherit: true
      })
    );
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8")).packageVersion).toBe(
      PACKAGE_VERSION
    );
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "down")).toBe(false);
  });

  it("can update the CLI when deployment configuration is incomplete", async () => {
    const test = runtime();
    mkdirSync(join(test.home, ".atlas", "core"), { recursive: true, mode: 0o700 });
    test.runner.latestVersion = NEXT_PACKAGE_VERSION;

    expect(await runCLI(["update", "cli"], test.context)).toBe(0);
    expect(test.runner.installedVersion).toBe(NEXT_PACKAGE_VERSION);
  });

  it("identifies an invalid npm release version", async () => {
    const test = runtime();
    test.runner.latestVersion = "next";

    expect(await runCLI(["update", "cli"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("npm has an invalid Atlas Core version: next");
  });

  it("cancels a Core update without a confirmed paired backup", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.latestVersion = NEXT_PACKAGE_VERSION;

    expect(await runCLI(["update", "all"], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("paired PostgreSQL and MinIO backup");
    expect(test.stdout.join("")).toContain("Atlas Core update cancelled");
    expect(test.runner.installedVersion).toBe(PACKAGE_VERSION);
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "down")).toBe(false);
  });

  it("uses the newly installed CLI to update Core", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.latestVersion = NEXT_PACKAGE_VERSION;
    test.context.confirmCoreUpdate = async () => true;

    expect(await runCLI(["update", "all"], test.context)).toBe(0);
    expect(test.runner.installedVersion).toBe(NEXT_PACKAGE_VERSION);
    expect(test.runner.calls).toContainEqual(
      expect.objectContaining({
        command: process.execPath,
        args: [
          join(test.runner.globalRoot, PACKAGE_NAME, "dist", "cli.js"),
          "__apply-core-update",
          PACKAGE_VERSION,
          TEST_IMAGE
        ],
        inherit: true
      })
    );
  });

  it("reports a failure from the newly installed Core updater", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.latestVersion = NEXT_PACKAGE_VERSION;
    test.runner.failInstalledCoreUpdate = true;
    test.context.confirmCoreUpdate = async () => true;

    expect(await runCLI(["update", "all"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("injected installed update failure");
  });

  it("updates Core in place and advances state only after it is healthy", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    setCoreVersion(test, "0.1.2");
    test.context.confirmCoreUpdate = async () => true;
    const envPath = join(test.home, ".atlas", "core", ".env");
    const configuredEnvironment = readFileSync(envPath, "utf8");
    writeFileSync(envPath, configuredEnvironment, { mode: 0o600 });

    expect(await runCLI(["update", "all"], test.context)).toBe(0);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toContainEqual(["pull"]);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toContainEqual(["down"]);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toContainEqual([
      "up",
      "-d",
      "--pull",
      "never",
      "--remove-orphans",
      "--wait",
      "--wait-timeout",
      "120"
    ]);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8")).packageVersion).toBe(
      PACKAGE_VERSION
    );
    expect(test.runner.existingVolumes).toContain(POSTGRES_VOLUME);
    expect(test.runner.existingVolumes).toContain(MINIO_VOLUME);
    expect(test.runner.calls.some((call) => call.args[0] === "volume" && call.args[1] === "rm")).toBe(false);
    expect(readFileSync(envPath, "utf8")).toBe(configuredEnvironment);
    expect(test.runner.serviceStates.some((service) => service.Service === plugin.service)).toBe(true);
  });

  it("refuses a Core update when the installed package pins another image", async () => {
    const test = runtime();
    markInitialized(test);
    setCoreVersion(test, "0.1.2");
    test.runner.latestImage = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"b".repeat(64)}`;
    test.context.confirmCoreUpdate = async () => true;

    expect(await runCLI(["update", "all"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("pins");
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "down")).toBe(false);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8")).packageVersion).toBe(
      "0.1.2"
    );
  });

  it("identifies an invalid recorded Core version", async () => {
    const test = runtime();
    markInitialized(test);
    setCoreVersion(test, "legacy");

    expect(await runCLI(["update", "all"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("running Atlas Core has an invalid Atlas Core version: legacy");
  });

  it("does not advance Core state when the updated deployment fails health checks", async () => {
    const test = runtime();
    markInitialized(test);
    setCoreVersion(test, "0.1.2");
    test.runner.failComposeUp = true;
    test.context.confirmCoreUpdate = async () => true;

    expect(await runCLI(["update", "all"], test.context)).toBe(1);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8")).packageVersion).toBe(
      "0.1.2"
    );
    expect(test.runner.existingVolumes).toContain(POSTGRES_VOLUME);
    expect(test.runner.existingVolumes).toContain(MINIO_VOLUME);
  });

  it("uses the previous Core image only when rolling back a disrupted update", async () => {
    const test = runtime();
    const previousImage = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"c".repeat(64)}`;
    markInitialized(test);
    setCoreVersion(test, "0.1.2");
    test.runner.runningCoreImage = previousImage;
    test.runner.failComposeUp = true;
    test.context.confirmCoreUpdate = async () => true;

    expect(await runCLI(["update", "all"], test.context)).toBe(1);
    const upCalls = test.runner.calls.filter((call) => composeCommand(call)[0] === "up");
    expect(upCalls).toHaveLength(2);
    expect(upCalls[0]?.env.ATLAS_CORE_IMAGE).toBe(TEST_IMAGE);
    expect(upCalls[1]?.env.ATLAS_CORE_IMAGE).toBe(previousImage);
  });

  it("updates a stopped deployment without starting it", async () => {
    const test = runtime();
    markInitialized(test);
    setCoreVersion(test, "0.1.2");
    test.runner.serviceStates = [];
    test.context.confirmCoreUpdate = async () => true;

    expect(await runCLI(["update", "all"], test.context)).toBe(0);
    const composeCalls = test.runner.calls.map(composeCommand).filter((args) => args.length > 0);
    expect(composeCalls).toContainEqual(["pull"]);
    expect(composeCalls.some((args) => args[0] === "down" || args[0] === "up")).toBe(false);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8")).packageVersion).toBe(
      PACKAGE_VERSION
    );
  });

  it("refuses to operate the deployment through another Docker engine", async () => {
    const test = runtime();
    markInitialized(test);
    const statePath = join(test.home, ".atlas", "core", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, `${JSON.stringify({ ...state, dockerEngineId: "another-engine" })}\n`);

    expect(await runCLI(["start"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("Restore the original Docker context");
  });

  it("refuses to use credentials that are readable by other users", async () => {
    const test = runtime();
    markInitialized(test);
    chmodSync(join(test.home, ".atlas", "core", ".env"), 0o644);

    expect(await runCLI(["status"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("must have mode 600");
    expect(test.runner.calls).toHaveLength(0);
  });

  it("refuses to follow a symlinked credential file", async () => {
    const test = runtime();
    markInitialized(test);
    const envPath = join(test.home, ".atlas", "core", ".env");
    const targetPath = `${envPath}.real`;
    renameSync(envPath, targetPath);
    symlinkSync(targetPath, envPath);

    expect(await runCLI(["status"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("must be a regular file");
    expect(test.runner.calls).toHaveLength(0);
  });

  it("stops without deleting durable volumes", async () => {
    const test = runtime();
    markInitialized(test);
    expect(await runCLI(["stop"], test.context)).toBe(0);
    const down = test.runner.calls.find((call) => composeCommand(call)[0] === "down");
    expect(down && composeCommand(down)).toEqual(["down", "--remove-orphans"]);
    expect(down?.args).not.toContain("--volumes");
  });

  it("maps core logs to the api service", async () => {
    const test = runtime();
    markInitialized(test);
    expect(await runCLI(["logs", "core", "--follow"], test.context)).toBe(0);
    const logs = test.runner.calls.find((call) => composeCommand(call)[0] === "logs");
    expect(logs && composeCommand(logs)).toEqual(["logs", "--tail", "200", "--follow", "api"]);
    expect(logs?.inherit).toBe(true);
  });

  it("targets Source Gateway logs directly", async () => {
    const test = runtime();
    markInitialized(test);
    expect(await runCLI(["logs", "source-gateway"], test.context)).toBe(0);
    const logs = test.runner.calls.find((call) => composeCommand(call)[0] === "logs");
    expect(logs && composeCommand(logs)).toEqual(["logs", "--tail", "200", "source-gateway"]);
  });

  it("reports health and Docker performance for each service", async () => {
    const test = runtime();
    markInitialized(test);
    let details: DeploymentDetails | undefined;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async (operator) => {
        details = await operator.details();
      },
      runUpdate: async () => undefined
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(details).toMatchObject({
      snapshot: { status: "ready" },
      cliVersion: PACKAGE_VERSION,
      coreVersion: PACKAGE_VERSION,
      image: TEST_IMAGE,
      services: [
        {
          id: "api",
          cpuPercent: "1.00%",
          memoryUsage: "128MiB / 1GiB",
          uptime: "4h 0m",
          restarts: 1
        },
        { id: "source-gateway", cpuPercent: "2.00%" },
        { id: "postgres", cpuPercent: "3.00%" },
        { id: "minio", cpuPercent: "4.00%" }
      ]
    });
  });

  it("uses the status cancellation signal for every Docker details command", async () => {
    const test = runtime();
    markInitialized(test);
    const controller = new AbortController();
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async (operator) => {
        await operator.details(controller.signal);
      },
      runUpdate: async () => undefined
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(test.runner.calls.length).toBeGreaterThan(0);
    expect(test.runner.calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it("keeps health available when Docker statistics fail", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.failStats = true;
    let details: DeploymentDetails | undefined;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async (operator) => {
        details = await operator.details();
      },
      runUpdate: async () => undefined
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(details?.snapshot.status).toBe("ready");
    expect(details?.performanceError).toContain("docker stats failed");
    expect(details?.services[0]).toMatchObject({ id: "api", health: "healthy" });
    expect(details?.services[0]?.cpuPercent).toBeUndefined();
  });

  it("returns unhealthy status when a required service is missing", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.serviceStates = test.runner.serviceStates.filter((service) => service.Service !== "api");
    expect(await runCLI(["status"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("api is missing");
  });

  it("returns unhealthy status when the Source Gateway is missing", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.serviceStates = test.runner.serviceStates.filter((service) => service.Service !== "source-gateway");
    expect(await runCLI(["status"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("source-gateway is missing");
  });

  it("returns unhealthy status when a running service fails its health check", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.serviceStates = test.runner.serviceStates.map((service) =>
      service.Service === "api" ? { ...service, Health: "unhealthy" } : service
    );

    expect(await runCLI(["status"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("api is unhealthy");
  });

  it("migrates schema 1 state and lists catalog Plugins without changing deployment versions", async () => {
    const test = runtime();
    markInitialized(test);
    installTestPluginCatalog(test);
    setCoreVersion(test, "0.1.2");

    expect(await runCLI(["plugins"], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("spatial_fixture\tSpatial Fixture\tdisabled");
    const state = JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"));
    expect(state).toMatchObject({ schema: 2, enabledPlugins: [], packageVersion: "0.1.2" });
  });

  it("enables a pinned query-only Plugin transactionally and includes its overlay", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const configRoot = join(test.home, ".atlas", "core", "plugins", plugin.pluginId);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      schema: 2,
      enabledPlugins: [plugin.pluginId]
    });
    for (const file of ["compose.yml", "core-endpoint.json", "source-connector.json", "deployment.json"]) {
      expect(existsSync(join(configRoot, file))).toBe(true);
      expect(statSync(join(configRoot, file)).mode & 0o777).toBe(
        file === "compose.yml" || file === "deployment.json" ? 0o600 : 0o644
      );
    }
    expect(JSON.parse(readFileSync(join(configRoot, "deployment.json"), "utf8"))).toEqual({
      schema: 1,
      pluginId: plugin.pluginId,
      displayName: plugin.displayName,
      lifecycle: plugin.lifecycle,
      service: plugin.service
    });
    expect(test.runner.calls.some((call) => call.args[0] === "pull" && call.args[1] === TEST_PLUGIN_IMAGE)).toBe(true);
    const configCall = test.runner.calls.find((call) => composeCommand(call)[0] === "config");
    expect(configCall?.args).toContain(join(configRoot, "compose.yml"));
    expect(test.runner.calls.map(composeCommand)).toContainEqual([
      "up",
      "-d",
      "--pull",
      "never",
      "--remove-orphans",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "120",
      "api",
      "source-gateway",
      plugin.service
    ]);
    expect(test.stdout.join("")).toContain("[work] Pulling Spatial Fixture image");
    expect(test.stdout.join("")).toContain("[done] Deployment configuration valid");
    expect(test.stdout.join("")).toContain("[done] Spatial Fixture enabled and healthy");
  });

  it("enables a Plugin without starting a stopped deployment", async () => {
    const test = runtime();
    markInitialized(test, false);
    const plugin = installTestPluginCatalog(test);
    test.runner.serviceStates = [];

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    expect(test.runner.calls.map(composeCommand)).not.toContainEqual(expect.arrayContaining(["up"]));
    expect(test.stdout.join("")).toContain("It will start with Atlas Core");
  });

  it("does not touch running services when Plugin configuration validation fails", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    test.runner.failComposeConfig = true;

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(1);
    const composeCalls = test.runner.calls.map(composeCommand);
    expect(composeCalls).not.toContainEqual(expect.arrayContaining(["rm"]));
    expect(composeCalls).not.toContainEqual(expect.arrayContaining(["up"]));
    expect(existsSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId))).toBe(false);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: []
    });
  });

  it("rejects Plugin enable while a required Core service is stopped", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    test.runner.serviceStates = test.runner.serviceStates.map((service) =>
      service.Service === "api" ? { ...service, State: "exited" } : service
    );

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("api is exited");
    expect(test.runner.calls.map(composeCommand)).not.toContainEqual(expect.arrayContaining(["up"]));
    expect(existsSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId))).toBe(false);
  });

  it("rolls back Plugin state and private assets when a running enable fails", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    test.runner.failComposeUp = true;
    let composeUpCalls = 0;
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] !== "up") return;
      composeUpCalls++;
      if (composeUpCalls === 2) test.runner.failComposeUp = false;
    };

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(1);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: []
    });
    expect(existsSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId))).toBe(false);
    expect(test.stderr.join("")).toContain("injected compose up failure");
    expect(test.stdout.join("")).toContain("[work] Restoring previous deployment");
    expect(test.stdout.join("")).toContain("[done] Previous deployment restored");
  });

  it("completes Plugin enable rollback after cancellation", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runUpdate: async () => undefined,
      runMenu: async (operator) => {
        let cancelled = false;
        test.runner.onRun = (call) => {
          if (cancelled || composeCommand(call)[0] !== "up") return;
          cancelled = true;
          operator.cancelPending();
        };
        await expect(operator.pluginEnable(plugin.pluginId)).resolves.toEqual({
          previousDeploymentPreserved: true,
          status: "cancelled"
        });
      }
    };

    expect(await runCLI([], test.context)).toBe(0);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: []
    });
    expect(existsSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId))).toBe(false);
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["rm", "-s", "-f", plugin.service]);
    expect(
      test.runner.calls
        .map(composeCommand)
        .filter((args) => args[0] === "up" && args.includes("api") && !args.includes(plugin.service))
    ).toHaveLength(1);
  });

  it("handles SIGINT for direct Plugin changes and exits after rollback", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    const initialSignalListeners = process.listenerCount("SIGINT");
    let interrupted = false;
    test.runner.onRun = (call) => {
      if (interrupted || composeCommand(call)[0] !== "up" || !composeCommand(call).includes(plugin.service)) return;
      interrupted = true;
      process.emit("SIGINT");
    };

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(initialSignalListeners);
    expect(test.stdout.join("")).toContain("[cancel] Enable cancelled. The previous deployment is preserved.");
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: []
    });
    expect(existsSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId))).toBe(false);
  });

  it("serializes Plugin mutations with the deployment lock", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    const config = join(test.home, ".atlas", "core");
    writeFileSync(join(config, ".mutation.lock"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("deployment mutation is locked");
    expect(test.runner.calls.some((call) => call.args[0] === "pull" && call.args[1] === TEST_PLUGIN_IMAGE)).toBe(false);
    expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
  });

  it("disables with the old composition, preserves the cached image, and removes staged assets", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["rm", "-s", "-f", plugin.service]);
    expect(test.runner.calls.some((call) => call.args[0] === "image" && call.args[1] === "rm")).toBe(false);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: []
    });
    expect(existsSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId))).toBe(false);
  });

  it("refuses to disable through a symlinked Plugin root", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const pluginRoot = join(config, "plugins");
    const externalRoot = join(test.home, "external-plugins");
    renameSync(pluginRoot, externalRoot);
    symlinkSync(externalRoot, pluginRoot);
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain(`${pluginRoot} must be a regular directory`);
    expect(existsSync(join(externalRoot, plugin.pluginId, "compose.yml"))).toBe(true);
    expect(test.runner.calls.map(composeCommand)).not.toContainEqual(["rm", "-s", "-f", plugin.service]);
  });

  it("refuses to disable through a symlinked per-Plugin deployment directory", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const pluginPath = join(config, "plugins", plugin.pluginId);
    const externalPath = join(test.home, "external-plugin");
    renameSync(pluginPath, externalPath);
    symlinkSync(externalPath, pluginPath);
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain(`${pluginPath} must be a regular directory`);
    expect(existsSync(join(externalPath, "compose.yml"))).toBe(true);
    expect(test.runner.calls.map(composeCommand)).not.toContainEqual(["rm", "-s", "-f", plugin.service]);
  });

  it("commits disabled state before removing a Plugin service or its staged overlay", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    let observedCommit = false;
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] !== "rm") return;
      observedCommit = true;
      expect(JSON.parse(readFileSync(join(config, "state.json"), "utf8"))).toMatchObject({ enabledPlugins: [] });
      expect(existsSync(join(config, "plugins", plugin.pluginId, "compose.yml"))).toBe(true);
      expect(existsSync(join(config, "plugins", plugin.pluginId, "disable.json"))).toBe(true);
    };

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    expect(observedCommit).toBe(true);
    expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
  });

  it("retries an interrupted disable on either side of the state commit", async () => {
    for (const stateCommitted of [false, true]) {
      const test = runtime();
      markInitialized(test);
      const plugin = installTestPluginCatalog(test);
      expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
      simulateInterruptedPluginDisable(test, plugin, stateCommitted);
      test.runner.calls.length = 0;

      expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

      const config = join(test.home, ".atlas", "core");
      expect(JSON.parse(readFileSync(join(config, "state.json"), "utf8"))).toMatchObject({ enabledPlugins: [] });
      expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
      expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
      expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
      expect(test.runner.calls.map(composeCommand)).toContainEqual(["rm", "-s", "-f", plugin.service]);
    }
  });

  it("does not reclaim an interrupted disable while its fenced Docker process group is alive", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    const lockPath = join(test.home, ".atlas", "core", ".mutation.lock");
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      detached: true,
      stdio: "ignore"
    });
    if (orphan.pid === undefined) throw new Error("test process group did not start");
    const processGroupId = orphan.pid;
    writeFileSync(lockPath, `${JSON.stringify({ ...owner, processGroupId })}\n`, { mode: 0o600 });

    try {
      await vi.waitFor(() => expect(() => process.kill(-processGroupId, 0)).not.toThrow());
      expect(await runCLI(["stop"], test.context)).toBe(1);
      expect(test.stderr.join("")).toContain("deployment mutation is locked");
    } finally {
      process.kill(-processGroupId, "SIGKILL");
      await new Promise<void>((resolveClose) => orphan.once("close", () => resolveClose()));
    }

    test.stderr.length = 0;
    expect(await runCLI(["stop"], test.context)).toBe(0);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("keeps status and logs useful after a destructive disable crash", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    test.context.pluginCatalog = [];
    test.runner.calls.length = 0;
    test.stdout.length = 0;
    let details: DeploymentDetails | undefined;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async (operator) => {
        details = await operator.details();
      },
      runUpdate: async () => undefined
    };

    for (const pluginServicePresent of [true, false]) {
      if (!pluginServicePresent) {
        test.runner.serviceStates = test.runner.serviceStates.filter((service) => service.Service !== plugin.service);
      }
      expect(await runCLI(["plugins", "status"], test.context)).toBe(0);
      expect(await runCLI(["plugins", "status", plugin.pluginId], test.context)).toBe(0);
      expect(await runCLI(["status"], test.context)).toBe(0);
      expect(await runCLI(["logs", "core"], test.context)).toBe(0);
      expect(await runCLI([], test.context)).toBe(0);
    }

    expect(test.stdout.join("")).toContain(`${plugin.pluginId}\t${plugin.displayName}\tdisabled`);
    expect(details?.snapshot).toMatchObject({ status: "ready" });
    const pendingOverlay = join(test.home, ".atlas", "core", "plugins", plugin.pluginId, "compose.yml");
    expect(
      test.runner.calls
        .filter((call) => composeCommand(call).length > 0)
        .every((call) => !call.args.includes(pendingOverlay))
    ).toBe(true);
  });

  it("rejects a configuration mutation while Plugin-disable recovery is pending", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    test.runner.calls.length = 0;
    test.context.interactive = {
      configureAdmin: async () => undefined,
      runMenu: async (operator) => {
        await expect(operator.configureAdminPassword("correct-horse-battery-staple")).rejects.toThrow(
          "must finish disabling spatial_fixture"
        );
      },
      runUpdate: async () => undefined
    };

    expect(await runCLI([], test.context)).toBe(0);

    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toHaveLength(0);
    expect(test.runner.serviceStates.some((service) => service.Service === plugin.service)).toBe(true);
    expect(existsSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId, "disable.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", ".mutation.lock"), "utf8"))).toMatchObject({
      operation: "plugin-disable"
    });
  });

  it("rejects a Core update while Plugin-disable recovery is pending", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    setCoreVersion(test, "0.1.2");
    test.context.confirmCoreUpdate = async () => true;
    test.runner.calls.length = 0;

    expect(await runCLI(["update", "all"], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain("must finish disabling spatial_fixture");
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toHaveLength(0);
    expect(existsSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId, "disable.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", ".mutation.lock"), "utf8"))).toMatchObject({
      operation: "plugin-disable"
    });
  });

  it("keeps a stopped recovery target consistent while preparing a generic disable", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, false);
    const config = join(test.home, ".atlas", "core");
    const intentPath = join(config, "plugins", plugin.pluginId, "disable.json");
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    writeFileSync(intentPath, `${JSON.stringify({ ...intent, previousStatus: "stopped" })}\n`, { mode: 0o600 });
    let observedOwner: unknown;
    let observedIntent: unknown;
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] !== "down") return;
      observedOwner = JSON.parse(readFileSync(join(config, ".mutation.lock"), "utf8"));
      observedIntent = JSON.parse(readFileSync(intentPath, "utf8"));
    };

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);
    expect(observedOwner).toMatchObject({ operation: "plugin-disable", pluginDisableTarget: "stopped" });
    expect(observedIntent).toMatchObject({ previousStatus: "stopped" });
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "down")).toBe(true);
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "rm")).toBe(false);
  });

  it.each(["start", "restart"] as const)("removes a pending disabled Plugin during %s", async (command) => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    test.runner.calls.length = 0;

    expect(await runCLI([command], test.context)).toBe(0);

    expect(test.runner.serviceStates.some((service) => service.Service === plugin.service)).toBe(false);
    expect(
      test.runner.calls.map(composeCommand).some((args) => args[0] === "up" && args.includes("--remove-orphans"))
    ).toBe(true);
  });

  it("stops without starting after disable convergence persistently fails", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    test.runner.serviceStates = test.runner.serviceStates.filter((service) => service.Service !== plugin.service);
    test.runner.failComposeUp = true;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);
    const config = join(test.home, ".atlas", "core");
    expect(existsSync(join(config, "plugins", plugin.pluginId, "disable.json"))).toBe(true);

    test.runner.calls.length = 0;
    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(test.runner.calls.map(composeCommand)).toContainEqual(["down", "--remove-orphans"]);
    expect(test.runner.calls.map(composeCommand).some((args) => args[0] === "up")).toBe(false);
    expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
  });

  it("durably targets stopped and fences down before settling a pending disable", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    rmSync(lockPath);
    test.runner.existingNetworks.clear();
    test.runner.networkIds.clear();
    test.runner.networkLabels.clear();
    test.runner.calls.length = 0;
    test.runner.failAfterComposeDown = true;
    let fencedAcquisition = false;
    let fencedDown = false;
    test.runner.onRun = (call) => {
      if (call.args[0] === "network" && call.args[1] === "create") {
        expect(call.processGroup).toBeDefined();
        expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });
        expect(
          JSON.parse(readFileSync(join(config, "plugins", plugin.pluginId, "disable.json"), "utf8"))
        ).toMatchObject({ previousStatus: "stopped" });
        fencedAcquisition = true;
        return;
      }
      if (composeCommand(call)[0] !== "down") return;
      const intent = JSON.parse(readFileSync(join(config, "plugins", plugin.pluginId, "disable.json"), "utf8"));
      expect(intent).toMatchObject({ previousStatus: "stopped" });
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });
      expect(call.processGroup).toBeDefined();
      const processGroupId = 123_456;
      call.processGroup?.started(processGroupId);
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ processGroupId });
      call.processGroup?.finished(processGroupId);
      fencedDown = true;
    };

    expect(await runCLI(["stop"], test.context)).toBe(1);

    expect(fencedAcquisition).toBe(true);
    expect(fencedDown).toBe(true);
    expect(test.runner.serviceStates).toEqual([]);
    expect(JSON.parse(readFileSync(join(config, "plugins", plugin.pluginId, "disable.json"), "utf8"))).toMatchObject({
      previousStatus: "stopped"
    });
    expect(existsSync(lockPath)).toBe(false);

    test.runner.onRun = undefined;
    test.runner.calls.length = 0;
    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    expect(test.runner.calls.map(composeCommand).some((args) => args[0] === "up")).toBe(false);
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["down", "--remove-orphans"]);
    expect(test.runner.serviceStates).toEqual([]);
    expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
  });

  it("supervises recovered Docker lock creation behind the durable Plugin-disable fence", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    let supervisedCreate = false;
    test.runner.onRun = (call) => {
      if (call.args[0] !== "network" || call.args[1] !== "create") return;
      expect(call.processGroup).toBeDefined();
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });
      const processGroupId = 123_457;
      call.processGroup?.started(processGroupId);
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ processGroupId });
      call.processGroup?.finished(processGroupId);
      supervisedCreate = true;
    };

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(supervisedCreate).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("fences a fresh Plugin disable before acquiring its Docker lock", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const lockPath = join(test.home, ".atlas", "core", ".mutation.lock");
    test.runner.calls.length = 0;
    let fencedCreate = false;
    test.runner.onRun = (call) => {
      if (call.args[0] !== "network" || call.args[1] !== "create") return;
      expect(call.processGroup).toBeDefined();
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });
      const processGroupId = 123_458;
      call.processGroup?.started(processGroupId);
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ processGroupId });
      call.processGroup?.finished(processGroupId);
      fencedCreate = true;
    };

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    expect(fencedCreate).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fences pending disable convergence before a Plugin enable acquires its Docker lock", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    rmSync(lockPath);
    test.runner.existingNetworks.clear();
    test.runner.networkIds.clear();
    test.runner.networkLabels.clear();
    test.runner.calls.length = 0;
    let fencedCreate = false;
    test.runner.onRun = (call) => {
      if (call.args[0] !== "network" || call.args[1] !== "create") return;
      expect(call.processGroup).toBeDefined();
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });
      fencedCreate = true;
    };

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);

    expect(fencedCreate).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(config, "plugins", plugin.pluginId, "disable.json"))).toBe(false);
  });

  it("retargets a stopped disable intent before start can recreate Atlas Core", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    test.runner.serviceStates = [];
    simulateInterruptedPluginDisable(test, plugin, true);
    const config = join(test.home, ".atlas", "core");
    const pluginRoot = join(config, "plugins", plugin.pluginId);
    const intentPath = join(pluginRoot, "disable.json");
    const lockPath = join(config, ".mutation.lock");
    rmSync(lockPath);
    test.runner.existingNetworks.clear();
    test.runner.networkIds.clear();
    test.runner.networkLabels.clear();
    test.runner.calls.length = 0;
    let retargetedBeforeAcquisition = false;
    test.runner.onRun = (call) => {
      if (call.args[0] !== "network" || call.args[1] !== "create") return;
      expect(JSON.parse(readFileSync(intentPath, "utf8"))).toMatchObject({ previousStatus: "ready" });
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });
      expect(call.processGroup).toBeDefined();
      retargetedBeforeAcquisition = true;
    };

    expect(await runCLI(["start"], test.context)).toBe(0);

    expect(retargetedBeforeAcquisition).toBe(true);
    expect(existsSync(pluginRoot)).toBe(false);
    test.runner.onRun = undefined;
    test.runner.calls.length = 0;
    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);
    expect(test.runner.calls.map(composeCommand).some((args) => args[0] === "down")).toBe(false);
  });

  it("reapplies a recovered stop target before generic disable convergence", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    const intentPath = join(config, "plugins", plugin.pluginId, "disable.json");
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, `${JSON.stringify({ ...owner, pluginDisableTarget: "stopped" })}\n`, { mode: 0o600 });
    test.runner.calls.length = 0;
    let retargetedBeforeAcquisition = false;
    test.runner.onRun = (call) => {
      if (call.args[0] !== "network" || call.args[1] !== "create") return;
      expect(JSON.parse(readFileSync(intentPath, "utf8"))).toMatchObject({ previousStatus: "stopped" });
      retargetedBeforeAcquisition = true;
    };

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    expect(retargetedBeforeAcquisition).toBe(true);
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["down", "--remove-orphans"]);
    expect(test.runner.calls.map(composeCommand).some((args) => args[0] === "up")).toBe(false);
  });

  it("pins the validated Docker socket across a Plugin-disable mutation", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    test.runner.calls.length = 0;
    const validatedHost = test.runner.contextHost;
    test.runner.onRun = (call) => {
      if (call.args[0] !== "network" || call.args[1] !== "create") return;
      test.runner.contextHost = "unix:///alternate-docker.sock";
    };

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    const createIndex = test.runner.calls.findIndex((call) => call.args[0] === "network" && call.args[1] === "create");
    expect(createIndex).toBeGreaterThanOrEqual(0);
    for (const call of test.runner.calls.slice(createIndex).filter((candidate) => candidate.command === "docker")) {
      expect(call.env.DOCKER_HOST).toBe(validatedHost);
      expect(call.env.DOCKER_CONTEXT).toBeUndefined();
    }
  });

  it("retains the Plugin-disable fence when a missing lock belongs to another engine", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    test.runner.afterSuccessfulComposeUp = () => {
      test.runner.existingNetworks.clear();
      test.runner.networkIds.clear();
      test.runner.networkLabels.clear();
      test.runner.dockerEngineId = "replacement-engine";
    };

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain("Docker engine changed during deployment mutation");
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });

    test.runner.dockerEngineId = "test-engine-id";
    const retainedOwner = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, `${JSON.stringify({ ...retainedOwner, pid: 2_147_483_647 })}\n`, { mode: 0o600 });
    test.stderr.length = 0;
    expect(await runCLI(["stop"], test.context)).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("retains a recovered Plugin-disable fence when a replacement engine reports its lock missing", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    const lockPath = join(test.home, ".atlas", "core", ".mutation.lock");
    test.runner.calls.length = 0;
    let replacedEngine = false;
    test.runner.onRun = (call) => {
      if (replacedEngine || call.args[0] !== "network" || call.args[1] !== "inspect") return;
      replacedEngine = true;
      test.runner.existingNetworks.clear();
      test.runner.networkIds.clear();
      test.runner.networkLabels.clear();
      test.runner.dockerEngineId = "replacement-engine";
    };

    expect(await runCLI(["stop"], test.context)).toBe(1);

    expect(replacedEngine).toBe(true);
    expect(test.stderr.join("")).toContain("Docker engine changed during deployment mutation");
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ operation: "plugin-disable" });
    expect(test.runner.calls.some((call) => call.args[0] === "network" && call.args[1] === "create")).toBe(false);
    expect(test.runner.calls.map(composeCommand).some((args) => args[0] === "down")).toBe(false);
  });

  it("rejects a replacement Docker engine immediately after creating its mutation lock", async () => {
    const test = runtime();
    markInitialized(test);
    const lockPath = join(test.home, ".atlas", "core", ".mutation.lock");
    let replacedEngine = false;
    test.runner.onRun = (call) => {
      if (replacedEngine || call.args[0] !== "network" || call.args[1] !== "create") return;
      replacedEngine = true;
      test.runner.dockerEngineId = "replacement-engine";
    };

    expect(await runCLI(["stop"], test.context)).toBe(1);

    expect(replacedEngine).toBe(true);
    expect(test.stderr.join("")).toContain("Docker engine changed during deployment mutation");
    expect(test.runner.calls.map(composeCommand).some((args) => args[0] === "down")).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("keeps destructive Compose work in the pinned engine namespace after a same-socket swap", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.afterSuccessfulNetworkCreate = () => {
      test.runner.afterDockerInfo = () => {
        test.runner.dockerEngineId = "replacement-engine";
      };
    };

    expect(await runCLI(["stop"], test.context)).toBe(0);

    const down = test.runner.calls.find((call) => composeCommand(call)[0] === "down");
    expect(down).toBeDefined();
    expect(down?.args).toContain(PROJECT_NAME);
    expect(down?.args).not.toContain(projectName("replacement-engine"));
    expect(down?.env).toMatchObject({ ATLAS_CORE_ENGINE_ID: TEST_ENGINE_ID, ATLAS_CORE_PROJECT: PROJECT_NAME });
  });

  it("finishes a pending disable before enabling the Plugin again", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);

    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: [plugin.pluginId]
    });
    expect(test.stderr.join("")).not.toContain("has staged files");
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["rm", "-s", "-f", plugin.service]);
  });

  it("leaves a coherent disabled deployment when re-enable pulling fails after pending recovery", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, true);
    const config = join(test.home, ".atlas", "core");
    const pluginCompose = join(config, "plugins", plugin.pluginId, "compose.yml");
    test.runner.calls.length = 0;
    test.runner.failDockerPullImage = plugin.image ?? undefined;

    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(1);

    expect(JSON.parse(readFileSync(join(config, "state.json"), "utf8"))).toMatchObject({ enabledPlugins: [] });
    expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
    expect(test.runner.serviceStates.some((service) => service.Service === plugin.service)).toBe(false);
    const baseRecreation = test.runner.calls.find(
      (call) => composeCommand(call)[0] === "up" && composeCommand(call).includes("api")
    );
    expect(baseRecreation).toBeDefined();
    expect(baseRecreation?.args).not.toContain(pluginCompose);
    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
  });

  it("reclaims a completed disable whose process died before releasing its locks", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const lockId = "e".repeat(32);
    writeFileSync(
      join(config, ".mutation.lock"),
      `${JSON.stringify({ schema: 1, id: lockId, pid: 2_147_483_647, operation: "plugin-disable" })}\n`,
      { mode: 0o600 }
    );
    test.runner.existingNetworks.add(MUTATION_LOCK_NETWORK);
    test.runner.networkLabels.set(MUTATION_LOCK_NETWORK, {
      "io.atlas.core.engine": "test-engine-id",
      "io.atlas.core.lock": "mutation",
      "io.atlas.core.project": "atlas_core_production",
      "io.atlas.core.lock-id": lockId
    });

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.stdout.join("")).toContain("Atlas Core stopped");
  });

  it("reclaims a completed disable when Docker lock removal loses the inspect/remove race", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const lockId = "e".repeat(32);
    writeFileSync(
      join(config, ".mutation.lock"),
      `${JSON.stringify({ schema: 1, id: lockId, pid: 2_147_483_647, operation: "plugin-disable" })}\n`,
      { mode: 0o600 }
    );
    test.runner.existingNetworks.add(MUTATION_LOCK_NETWORK);
    test.runner.networkLabels.set(MUTATION_LOCK_NETWORK, {
      "io.atlas.core.engine": "test-engine-id",
      "io.atlas.core.lock": "mutation",
      "io.atlas.core.project": "atlas_core_production",
      "io.atlas.core.lock-id": lockId
    });
    test.runner.nextNetworkRemovalError = (name) => `Error response from daemon: network ${name} not found`;

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.stdout.join("")).toContain("Atlas Core stopped");
  });

  it("reclaims a completed disable when Docker reports its lock network as not found", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    writeFileSync(
      join(config, ".mutation.lock"),
      `${JSON.stringify({
        schema: 1,
        id: "e".repeat(32),
        pid: 2_147_483_647,
        operation: "plugin-disable"
      })}\n`,
      { mode: 0o600 }
    );
    test.runner.missingNetworkError = (name) => `Error response from daemon: network ${name} not found`;

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
    expect(test.stdout.join("")).toContain("Atlas Core stopped");
  });

  it("ignores a recovery-claim temp file while reclaiming a completed disable", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);
    const config = join(test.home, ".atlas", "core");
    const recoveredLockId = "e".repeat(32);
    const abandonedClaim = join(config, `.mutation.lock.recovering.${2_147_483_647}.${"d".repeat(16)}`);
    const recoveredOwner = {
      schema: 1,
      id: recoveredLockId,
      pid: 2_147_483_646,
      operation: "plugin-disable"
    } as const;
    writeFileSync(abandonedClaim, `${JSON.stringify(recoveredOwner)}\n`, { mode: 0o600 });
    const abandonedTemp = `${abandonedClaim}.${process.pid}.${"a".repeat(12)}.tmp`;
    writeFileSync(abandonedTemp, `${JSON.stringify(recoveredOwner)}\n`, { mode: 0o600 });
    writeFileSync(
      join(config, ".mutation.lock"),
      `${JSON.stringify({ schema: 1, id: "f".repeat(32), pid: 2_147_483_645 })}\n`,
      { mode: 0o600 }
    );
    test.runner.existingNetworks.add(MUTATION_LOCK_NETWORK);
    test.runner.networkLabels.set(MUTATION_LOCK_NETWORK, {
      "io.atlas.core.engine": "test-engine-id",
      "io.atlas.core.lock": "mutation",
      "io.atlas.core.project": "atlas_core_production",
      "io.atlas.core.lock-id": recoveredLockId
    });

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(existsSync(abandonedClaim)).toBe(false);
    expect(existsSync(abandonedTemp)).toBe(true);
    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.stdout.join("")).toContain("Atlas Core stopped");
  });

  it("rejects Plugin disable while an enabled Plugin service is stopped", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    test.runner.serviceStates = test.runner.serviceStates.map((service) =>
      service.Service === plugin.service ? { ...service, State: "exited" } : service
    );
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain(`${plugin.service} is exited`);
    expect(test.runner.calls.map(composeCommand)).not.toContainEqual(["rm", "-s", "-f", plugin.service]);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: [plugin.pluginId]
    });
  });

  it("does not remove a Plugin container when its rollback backup cannot be created", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    rmSync(join(test.home, ".atlas", "core", "plugins", plugin.pluginId), { recursive: true, force: true });
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);
    expect(test.runner.calls.map(composeCommand)).not.toContainEqual(["rm", "-s", "-f", plugin.service]);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: [plugin.pluginId]
    });
  });

  it("uses staged metadata for Plugin status and logs across CLI-only catalog drift", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    setCoreVersion(test, "0.1.2");
    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("update all");
    test.context.pluginCatalog = [
      {
        ...plugin,
        displayName: "Renamed Spatial Fixture",
        service: "renamed-spatial-fixture"
      }
    ];
    test.stdout.length = 0;
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "status"], test.context)).toBe(0);
    expect(await runCLI(["plugins", "status", plugin.pluginId], test.context)).toBe(0);
    expect(await runCLI(["plugins", "logs", plugin.pluginId], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain(`${plugin.pluginId}\t${plugin.displayName}\tenabled`);
    expect(test.stdout.join("")).not.toContain("Renamed Spatial Fixture");
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["logs", "--tail", "200", plugin.service]);
  });

  it("rejects arbitrary Plugin IDs and bundles", async () => {
    const test = runtime();
    markInitialized(test);
    installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", "not_cataloged"], test.context)).toBe(1);
    expect(await runCLI(["plugins", "enable", "spatial_fixture", "/tmp/bundle"], test.context)).toBe(2);
  });

  it("resolves a relative ATLAS_CORE_HOME before invoking Compose", async () => {
    const test = runtime();
    const previousDirectory = process.cwd();
    process.chdir(test.home);
    try {
      test.context.env = { ATLAS_CORE_HOME: "relative-core" };
      expect(await runCLI(["init"], test.context)).toBe(0);
      const compose = test.runner.calls.find((call) => composeCommand(call)[0] === "up");
      const config = resolve("relative-core");
      expect(compose?.cwd).toBe(config);
      expect(compose?.args).toContain(join(config, ".env"));
    } finally {
      process.chdir(previousDirectory);
    }
  });
});
