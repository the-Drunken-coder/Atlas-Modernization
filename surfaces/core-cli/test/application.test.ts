import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-metadata.js";
import type { PluginCatalogEntry } from "../src/plugin-catalog.js";
import type { DeploymentDetails } from "../src/terminal-ui.js";

const TEST_IMAGE = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"a".repeat(64)}`;
const TEST_PLUGIN_IMAGE = `ghcr.io/the-drunken-coder/atlas-spatial-fixture@sha256:${"b".repeat(64)}`;
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
  failComposeUpImage: string | undefined;
  failStats = false;
  failInstalledCoreUpdate = false;
  composeVersion = "5.1.2";
  contextHost = "unix:///var/run/docker.sock";
  dockerArchitecture = "arm64";
  dockerOperatingSystem = "linux";
  globalRoot = "";
  latestVersion = PACKAGE_VERSION;
  latestImage = TEST_IMAGE;
  runningCoreImage = TEST_IMAGE;
  installedVersion = PACKAGE_VERSION;
  onRun: ((call: Call) => void | Promise<void>) | undefined;
  afterSuccessfulNetworkCreate: (() => void) | undefined;
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
    options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean; signal?: AbortSignal } = {}
  ): Promise<{ cancelled?: true; status: number; stdout: string; stderr: string }> {
    const call = {
      command,
      args,
      cwd: options.cwd,
      env: { ...options.env },
      inherit: options.inherit ?? false,
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
      const cancelAfterNetworkCreate = this.cancelAfterNetworkCreate;
      this.cancelAfterNetworkCreate = undefined;
      if (cancelAfterNetworkCreate) {
        cancelAfterNetworkCreate();
        return { ...result(1), cancelled: true };
      }
      const afterSuccessfulNetworkCreate = this.afterSuccessfulNetworkCreate;
      this.afterSuccessfulNetworkCreate = undefined;
      if (afterSuccessfulNetworkCreate) queueMicrotask(afterSuccessfulNetworkCreate);
      return result(0, `${networkId}\n`);
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const requested = args.at(-1) ?? "";
      const name = this.existingNetworks.has(requested)
        ? requested
        : ([...this.networkIds].find(([, id]) => id === requested)?.[0] ?? requested);
      if (!this.existingNetworks.has(name)) return result(1, "", `Error: No such network: ${name}`);
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
      this.existingNetworks.delete(name);
      this.networkLabels.delete(name);
      this.networkIds.delete(name);
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
      if (filter === "label=com.docker.compose.project=atlas_core_production") {
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
          "com.docker.compose.project": this.mismatchedResources.has(name) ? "other" : "atlas_core_production",
          "com.docker.compose.volume": volume
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
          "com.docker.compose.project": this.mismatchedResources.has(name) ? "other" : "atlas_core_production",
          "com.docker.compose.service": service
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
      return result(
        0,
        JSON.stringify({
          ID: "test-engine-id",
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
    if (compose[0] === "rm") {
      const removedService = compose.at(-1);
      if (removedService)
        this.serviceStates = this.serviceStates.filter((service) => service.Service !== removedService);
    }
    if (compose[0] === "up") {
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
    options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean; signal?: AbortSignal } = {}
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
  test.runner.existingVolumes.add("atlas_core_production_minio_data");
  if (started) test.runner.existingVolumes.add("atlas_core_production_postgres_data");
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
  phase: "prepared" | "committed"
): void {
  const config = join(test.home, ".atlas", "core");
  const statePath = join(config, "state.json");
  const pluginPath = join(config, "plugins", plugin.pluginId);
  const transaction = join(config, "transaction");
  const before = join(transaction, "before");
  const base = join(before, "base");
  const lockId = "c".repeat(32);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  cpSync(statePath, join(before, "state.json"));
  cpSync(pluginPath, join(before, "plugin"), { recursive: true });
  cpSync(join(test.context.packageRoot ?? "", "assets", "docker-compose.yml"), join(base, "docker-compose.yml"));
  cpSync(
    join(test.context.packageRoot ?? "", "assets", "source_gateway.production.json"),
    join(base, "source_gateway.production.json")
  );
  chmodSync(join(base, "docker-compose.yml"), 0o600);
  chmodSync(join(base, "source_gateway.production.json"), 0o644);
  writeFileSync(
    join(transaction, "journal.json"),
    `${JSON.stringify({
      schema: 1,
      coreImage: TEST_IMAGE,
      operation: "plugin-disable",
      phase,
      lockId,
      pluginId: plugin.pluginId,
      previousStatus: test.runner.serviceStates.length === 0 ? "stopped" : "ready"
    })}\n`,
    { mode: 0o600 }
  );
  rmSync(pluginPath, { recursive: true, force: true });
  test.runner.serviceStates = test.runner.serviceStates.filter((service) => service.Service !== plugin.service);
  if (phase === "committed") {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(
      statePath,
      `${JSON.stringify({ ...state, enabledPlugins: state.enabledPlugins.filter((id: string) => id !== plugin.pluginId) })}\n`,
      { mode: 0o600 }
    );
  }

  writeFileSync(join(config, ".mutation.lock"), `${JSON.stringify({ schema: 1, id: lockId, pid: 2_147_483_647 })}\n`, {
    mode: 0o600
  });
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
    expect(test.runner.existingVolumes).toContain("atlas_core_production_minio_data");
    expect(test.runner.existingVolumes).not.toContain("atlas_core_production_postgres_data");
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
    test.runner.existingVolumes.add("atlas_core_production_postgres_data");
    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("containers or durable volumes without matching CLI configuration");
  });

  it("refuses to reuse an unmatched Core container", async () => {
    const test = runtime();
    test.runner.existingContainers.add("atlas_core_production_api");
    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("containers or durable volumes without matching CLI configuration");
  });

  it("refuses to reuse an unmatched MinIO initializer container", async () => {
    const test = runtime();
    test.runner.existingContainers.add("atlas_core_production_minio_init");
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
    test.runner.existingVolumes.add("atlas_core_production_minio_data");

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
    test.runner.inspectionError = { kind: "volume", name: "atlas_core_production_postgres_data" };

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("permission denied");
  });

  it("rejects same-name storage without Compose ownership labels", async () => {
    const test = runtime();
    const volume = "atlas_core_production_postgres_data";
    test.runner.existingVolumes.add(volume);
    test.runner.mismatchedResources.add(volume);

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("ownership label");
  });

  it("reads container ownership labels from the Docker container config", async () => {
    const test = runtime();
    const container = "atlas_core_production_api";
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
    expect(test.runner.existingVolumes).toContain("atlas_core_production_postgres_data");
  });

  it("deletes an existing deployment and starts fresh with the installed release", async () => {
    const test = runtime();
    test.context.confirmReset = async (question) => question === "Continue? [y/N] ";
    const containers = [
      "atlas_core_production_api",
      "atlas_core_production_source_gateway",
      "atlas_core_production_postgres",
      "atlas_core_production_minio",
      "atlas_core_production_minio_init"
    ];
    for (const container of containers) test.runner.existingContainers.add(container);
    test.runner.existingVolumes.add("atlas_core_production_postgres_data");
    test.runner.existingVolumes.add("atlas_core_production_minio_data");
    test.runner.volumeUsers.set("atlas_core_production_postgres_data", new Set(["atlas_core_production_postgres"]));
    test.runner.volumeUsers.set("atlas_core_production_minio_data", new Set(["atlas_core_production_minio"]));

    expect(await runCLI(["reset"], test.context)).toBe(0);

    expect(test.runner.existingContainers).not.toContain("atlas_core_production_api");
    expect(test.runner.existingVolumes).toContain("atlas_core_production_postgres_data");
    expect(test.runner.existingVolumes).toContain("atlas_core_production_minio_data");
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
    test.runner.existingContainers.add("atlas_core_production_postgres");
    test.runner.existingContainers.add("atlas_core_production_minio");
    test.runner.volumeUsers.set("atlas_core_production_postgres_data", new Set(["atlas_core_production_postgres"]));
    test.runner.volumeUsers.set("atlas_core_production_minio_data", new Set(["atlas_core_production_minio"]));
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

  it("lets confirmed reset abandon an interrupted disable that cannot restore its captured image", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    const journalPath = join(config, "transaction", "journal.json");
    const oldImage = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"f".repeat(64)}`;
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    writeFileSync(journalPath, `${JSON.stringify({ ...journal, coreImage: oldImage })}\n`, { mode: 0o600 });
    test.runner.failComposeUpImage = oldImage;
    test.runner.calls.length = 0;
    let ownerDuringResetDown: unknown;
    test.runner.onRun = (call) => {
      if (ownerDuringResetDown === undefined && composeCommand(call)[0] === "down") {
        ownerDuringResetDown = JSON.parse(readFileSync(join(config, ".mutation.lock"), "utf8"));
      }
    };

    expect(await runCLI(["reset"], test.context)).toBe(0);

    expect(existsSync(join(config, "transaction"))).toBe(false);
    expect(ownerDuringResetDown).toMatchObject({ schema: 1, pid: process.pid });
    expect(ownerDuringResetDown).not.toHaveProperty("operation");
    expect(test.runner.calls.some((call) => call.env.ATLAS_CORE_IMAGE === oldImage)).toBe(false);
    expect(JSON.parse(readFileSync(join(config, "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: [],
      packageVersion: PACKAGE_VERSION
    });
    expect(test.stdout.join("")).toContain(`Atlas Core ${PACKAGE_VERSION} reset is complete`);
  });

  it("lets confirmed reset abandon an interrupted disable with a malformed journal", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    writeFileSync(join(config, "transaction", "journal.json"), "malformed\n", { mode: 0o600 });
    writeFileSync(
      join(config, ".mutation.lock"),
      `${JSON.stringify({ schema: 1, id: "c".repeat(32), pid: 2_147_483_647, operation: "plugin-disable" })}\n`,
      { mode: 0o600 }
    );

    expect(await runCLI(["reset"], test.context)).toBe(0);

    expect(existsSync(join(config, "transaction"))).toBe(false);
    expect(JSON.parse(readFileSync(join(config, "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: [],
      packageVersion: PACKAGE_VERSION
    });
  });

  it("removes project Plugin containers when reset configuration is incomplete", async () => {
    const test = runtime();
    test.context.confirmReset = async () => true;
    markInitialized(test);
    const pluginContainer = "atlas_core_production_spatial_fixture";
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
    const container = "atlas_core_production_api";
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
    const volume = "atlas_core_production_postgres_data";
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
    expect(up && composeCommand(up)).toEqual(["up", "-d", "--pull", "always", "--wait", "--wait-timeout", "120"]);
    expect(test.runner.existingVolumes).toContain("atlas_core_production_postgres_data");
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
      ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120"]
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
      ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120"]
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
    test.runner.existingVolumes.delete("atlas_core_production_postgres_data");
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
      ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120"]
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
      ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120"],
      ["down"],
      ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120"]
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
      ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120"],
      ["down"],
      ["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120"]
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
    test.runner.existingVolumes.delete("atlas_core_production_postgres_data");
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
      "--wait",
      "--wait-timeout",
      "120"
    ]);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8")).packageVersion).toBe(
      PACKAGE_VERSION
    );
    expect(test.runner.existingVolumes).toContain("atlas_core_production_postgres_data");
    expect(test.runner.existingVolumes).toContain("atlas_core_production_minio_data");
    expect(test.runner.calls.some((call) => call.args[0] === "volume" && call.args[1] === "rm")).toBe(false);
    expect(readFileSync(envPath, "utf8")).toBe(configuredEnvironment);
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
    expect(test.runner.existingVolumes).toContain("atlas_core_production_postgres_data");
    expect(test.runner.existingVolumes).toContain("atlas_core_production_minio_data");
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
    expect(down && composeCommand(down)).toEqual(["down"]);
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

  it("keeps the captured Source Gateway bind mount readable by its non-root container", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    let capturedMode: number | undefined;
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] !== "rm") return;
      capturedMode = statSync(
        join(test.home, ".atlas", "core", "transaction", "before", "base", "source_gateway.production.json")
      ).mode;
    };

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    expect((capturedMode ?? 0) & 0o777).toBe(0o644);
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
    expect(existsSync(join(config, "transaction"))).toBe(false);
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
    expect(existsSync(join(config, "transaction"))).toBe(false);
    expect(test.runner.calls.map(composeCommand)).not.toContainEqual(["rm", "-s", "-f", plugin.service]);
  });

  it("reclaims matching dead-owner locks, rolls back an interrupted disable, and completes the retry", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    const config = join(test.home, ".atlas", "core");
    expect(JSON.parse(readFileSync(join(config, "state.json"), "utf8"))).toMatchObject({ enabledPlugins: [] });
    expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
    expect(existsSync(join(config, "transaction"))).toBe(false);
    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
    expect(test.stdout.join("")).toContain(`Interrupted disable for Plugin ${plugin.pluginId} rolled back.`);
    expect(test.runner.calls.map(composeCommand)).toContainEqual([
      "up",
      "-d",
      "--pull",
      "never",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "120",
      "api",
      "source-gateway",
      plugin.service
    ]);
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["rm", "-s", "-f", plugin.service]);
    expect(test.runner.calls.some((call) => call.args[0] === "image" && call.args[1] === "rm")).toBe(false);
  });

  it("allows only one live process to own interrupted-disable recovery", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    const recoveryClaim = join(config, `.mutation.lock.recovering.${process.pid}.${"d".repeat(16)}`);
    renameSync(join(config, ".mutation.lock"), recoveryClaim);

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain(`deployment recovery is locked by PID ${process.pid}`);
    expect(existsSync(recoveryClaim)).toBe(true);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(true);
  });

  it("does not reclaim a dead claimant's recovery file while its recorded owner is still alive", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    const recoveryClaim = join(config, `.mutation.lock.recovering.${2_147_483_647}.${"d".repeat(16)}`);
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    renameSync(lockPath, recoveryClaim);
    writeFileSync(recoveryClaim, `${JSON.stringify({ ...owner, pid: process.pid })}\n`, { mode: 0o600 });

    expect(await runCLI(["stop"], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain(`deployment mutation is locked by PID ${process.pid}`);
    expect(existsSync(recoveryClaim)).toBe(true);
    expect(existsSync(join(config, "transaction"))).toBe(true);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(true);
  });

  it("waits for an orphaned Docker process group before recovering an interrupted disable", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    const lockPath = join(config, ".mutation.lock");
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      detached: true,
      stdio: "ignore"
    });
    if (orphan.pid === undefined) throw new Error("test process group did not start");
    const processGroupId = orphan.pid;
    writeFileSync(lockPath, `${JSON.stringify({ ...owner, operation: "plugin-disable", processGroupId })}\n`, {
      mode: 0o600
    });

    try {
      await vi.waitFor(() => expect(() => process.kill(-processGroupId, 0)).not.toThrow());

      expect(await runCLI(["stop"], test.context)).toBe(1);

      expect(test.stderr.join("")).toContain("deployment mutation is locked");
      expect(existsSync(join(config, "transaction"))).toBe(true);
      expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(true);
    } finally {
      process.kill(-processGroupId, "SIGKILL");
      await new Promise<void>((resolveClose) => orphan.once("close", () => resolveClose()));
    }

    test.stderr.length = 0;
    expect(await runCLI(["stop"], test.context)).toBe(0);
    expect(existsSync(join(config, "transaction"))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("reclaims a recovery claim whose process also died", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    const abandonedClaim = join(config, `.mutation.lock.recovering.${2_147_483_647}.${"d".repeat(16)}`);
    renameSync(join(config, ".mutation.lock"), abandonedClaim);

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    expect(existsSync(abandonedClaim)).toBe(false);
    expect(readdirSync(config).some((entry) => entry.startsWith(".mutation.lock.recovering."))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("reclaims a dead fresh owner left in the recovery-claim race", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    const abandonedClaim = join(config, `.mutation.lock.recovering.${2_147_483_647}.${"d".repeat(16)}`);
    renameSync(join(config, ".mutation.lock"), abandonedClaim);
    writeFileSync(
      join(config, ".mutation.lock"),
      `${JSON.stringify({
        schema: 1,
        id: "e".repeat(32),
        pid: 2_147_483_646,
        operation: "plugin-disable"
      })}\n`,
      { mode: 0o600 }
    );

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    expect(existsSync(abandonedClaim)).toBe(false);
    expect(existsSync(join(config, ".mutation.lock"))).toBe(false);
    expect(readdirSync(config).some((entry) => entry.startsWith(".mutation.lock.recovering."))).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("preserves the local recovery marker when Docker lock ownership cannot be proven", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    test.runner.networkLabels.set(MUTATION_LOCK_NETWORK, {
      "io.atlas.core.engine": "test-engine-id",
      "io.atlas.core.lock": "mutation",
      "io.atlas.core.project": "atlas_core_production",
      "io.atlas.core.lock-id": "f".repeat(32)
    });

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(1);

    expect(test.stderr.join("")).toContain("expected io.atlas.core.lock-id");
    expect(existsSync(join(config, ".mutation.lock"))).toBe(true);
    expect(readdirSync(config).some((entry) => entry.startsWith(".mutation.lock.recovering."))).toBe(false);
    expect(existsSync(join(config, "transaction"))).toBe(true);
  });

  it("recovers an interrupted disable after the CLI package version changes", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    setCoreVersion(test, NEXT_PACKAGE_VERSION);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    writeFileSync(
      join(test.context.packageRoot ?? "", "assets", "docker-compose.yml"),
      "services:\n  api:\n    image: changed-package\n"
    );
    test.runner.calls.length = 0;

    expect(await runCLI(["stop"], test.context)).toBe(0);

    const recoveryConfig = test.runner.calls.find((call) => composeCommand(call)[0] === "config");
    expect(composeFile(recoveryConfig ?? test.runner.calls[0]!)).toBe(
      join(test.home, ".atlas", "core", "transaction", "before", "base", "docker-compose.yml")
    );
    expect(recoveryConfig?.env.ATLAS_CORE_IMAGE).toBe(TEST_IMAGE);
    expect(test.stdout.join("")).toContain(`Interrupted disable for Plugin ${plugin.pluginId} rolled back.`);
    expect(test.stdout.join("")).toContain("Atlas Core stopped");
  });

  it("drops recovery eligibility before starting the requested mutation", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const lockPath = join(test.home, ".atlas", "core", ".mutation.lock");
    let ownerDuringStop: unknown;
    test.runner.onRun = (call) => {
      if (composeCommand(call)[0] === "down") {
        ownerDuringStop = JSON.parse(readFileSync(lockPath, "utf8"));
      }
    };

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(ownerDuringStop).toMatchObject({ schema: 1, pid: process.pid });
    expect(ownerDuringStop).not.toHaveProperty("operation");
  });

  it("rolls back and retries an interrupted disable without starting a stopped deployment", async () => {
    const test = runtime();
    markInitialized(test, false);
    const plugin = installTestPluginCatalog(test);
    test.runner.serviceStates = [];
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    expect(test.runner.calls.map(composeCommand)).not.toContainEqual(expect.arrayContaining(["up"]));
    expect(test.stdout.join("")).toContain("Atlas Core remains stopped");
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      enabledPlugins: []
    });
  });

  it("finishes a committed interrupted disable before reporting the Plugin disabled", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "committed");
    test.runner.calls.length = 0;

    expect(await runCLI(["plugins", "disable", plugin.pluginId], test.context)).toBe(0);

    const config = join(test.home, ".atlas", "core");
    expect(test.stdout.join("")).toContain(`Interrupted disable for Plugin ${plugin.pluginId} completed.`);
    expect(test.stdout.join("")).toContain(`${plugin.displayName} is already disabled`);
    expect(existsSync(join(config, "plugins", plugin.pluginId))).toBe(false);
    expect(existsSync(join(config, "transaction"))).toBe(false);
    expect(test.runner.calls.map(composeCommand)).toContainEqual(["config", "--quiet"]);
    expect(test.runner.calls.map(composeCommand)).toContainEqual([
      "up",
      "-d",
      "--pull",
      "never",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "120",
      "api",
      "source-gateway"
    ]);
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

  it("removes a transaction directory retired before an interrupted cleanup", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "committed");
    const config = join(test.home, ".atlas", "core");
    const retired = join(config, `.transaction.completed.${2_147_483_647}.${"d".repeat(16)}`);
    renameSync(join(config, "transaction"), retired);
    const lockPath = join(config, ".mutation.lock");
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, `${JSON.stringify({ ...owner, operation: "plugin-disable" })}\n`, { mode: 0o600 });

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(existsSync(retired)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(test.runner.existingNetworks.has(MUTATION_LOCK_NETWORK)).toBe(false);
  });

  it("creates a fresh lock with its recovery operation already durable", async () => {
    const test = runtime();
    markInitialized(test);
    const plugin = installTestPluginCatalog(test);
    expect(await runCLI(["plugins", "enable", plugin.pluginId], test.context)).toBe(0);
    simulateInterruptedPluginDisable(test, plugin, "prepared");
    const config = join(test.home, ".atlas", "core");
    rmSync(join(config, ".mutation.lock"));
    test.runner.existingNetworks.delete(MUTATION_LOCK_NETWORK);
    test.runner.networkLabels.delete(MUTATION_LOCK_NETWORK);
    let ownerDuringDockerAcquisition: unknown;
    test.runner.afterSuccessfulNetworkCreate = () => {
      ownerDuringDockerAcquisition = JSON.parse(readFileSync(join(config, ".mutation.lock"), "utf8"));
    };

    expect(await runCLI(["stop"], test.context)).toBe(0);

    expect(ownerDuringDockerAcquisition).toMatchObject({ operation: "plugin-disable" });
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
