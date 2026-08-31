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
import { afterEach, describe, expect, it } from "vitest";
import { type CLIContext, type CommandRunner, runCLI } from "../src/application.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-metadata.js";
import type { DeploymentDetails } from "../src/terminal-ui.js";

const TEST_IMAGE = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"a".repeat(64)}`;
const INIT_LOCK_NETWORK = "atlas_core_production_init_lock";

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
};

class FakeRunner implements CommandRunner {
  readonly calls: Call[] = [];
  readonly existingVolumes = new Set<string>();
  readonly existingContainers = new Set<string>();
  readonly existingNetworks = new Set<string>();
  readonly mismatchedResources = new Set<string>();
  readonly volumeUsers = new Map<string, Set<string>>();
  inspectionError: { kind: "container" | "volume"; name: string } | undefined;
  failComposeDown = false;
  failComposeUp = false;
  failStats = false;
  failInstalledCoreUpdate = false;
  composeVersion = "5.1.2";
  contextHost = "unix:///var/run/docker.sock";
  dockerArchitecture = "arm64";
  dockerOperatingSystem = "linux";
  globalRoot = "";
  latestVersion = PACKAGE_VERSION;
  latestImage = TEST_IMAGE;
  installedVersion = PACKAGE_VERSION;
  onRun: ((call: Call) => void) | undefined;
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
    options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {}
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    const call = {
      command,
      args,
      cwd: options.cwd,
      env: { ...options.env },
      inherit: options.inherit ?? false
    };
    this.calls.push(call);
    this.onRun?.(call);
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
      return result(0, `${name}\n`);
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const name = args.at(-1) ?? "";
      if (!this.existingNetworks.has(name)) return result(1, "", `Error: No such network: ${name}`);
      return result(
        0,
        JSON.stringify({
          "io.atlas.core.engine": "test-engine-id",
          "io.atlas.core.lock": "initialization",
          "io.atlas.core.project": "atlas_core_production"
        })
      );
    }
    if (args[0] === "network" && args[1] === "rm") {
      this.existingNetworks.delete(args.at(-1) ?? "");
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
    if (this.failComposeUp && composeCommand(this.calls.at(-1) ?? this.calls[0]!)[0] === "up") {
      return result(1, "", "injected compose up failure");
    }
    if (this.failComposeDown && composeCommand(this.calls.at(-1) ?? this.calls[0]!)[0] === "down") {
      return result(1, "", "injected compose down failure");
    }
    return result(0);
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
  const fileFlagIndex = call.args.indexOf("--file");
  if (fileFlagIndex === -1) return [];
  const commandIndex = fileFlagIndex + 2;
  return call.args.slice(commandIndex);
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
    expect(env).toContain("ATLAS_PLUGINS=[]");
    expect(env).toContain("ATLAS_SOURCE_GATEWAY_CONFIG_FILE=");
    expect(JSON.parse(readFileSync(join(config, "state.json"), "utf8"))).toEqual({
      schema: 1,
      phase: "ready",
      initializedAt: "2026-08-28T12:00:00.000Z",
      packageVersion: PACKAGE_VERSION,
      dockerEngineId: "test-engine-id"
    });
    expect(statSync(join(config, ".env")).mode & 0o077).toBe(0);
    expect(existsSync(join(config, ".init.lock"))).toBe(false);
    expect(test.runner.existingNetworks).not.toContain(INIT_LOCK_NETWORK);
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
    writeFileSync(join(config, ".init.lock"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("initialization is locked");
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toHaveLength(0);
  });

  it("fails closed on a stale initialization lock", async () => {
    const test = runtime();
    const config = join(test.home, ".atlas", "core");
    const lock = join(config, ".init.lock");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(lock, `${JSON.stringify({ pid: 2_147_483_647 })}\n`, { mode: 0o600 });

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("If no atlas-core init process is running, remove that file");
    expect(existsSync(lock)).toBe(true);
  });

  it("serializes initialization across configuration directories on one Docker engine", async () => {
    const test = runtime();
    test.runner.existingNetworks.add(INIT_LOCK_NETWORK);
    test.context.env = { ATLAS_CORE_HOME: join(test.home, "another-core-home") };

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("initialization is already locked on Docker engine");
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
    test.context.interactive = {
      configureAdmin: async (operator) => {
        await operator.configureAdminPassword("new-production-password");
      },
      runMenu: async () => undefined,
      runUpdate: async () => undefined
    };

    expect(await runCLI(["config"], test.context)).toBe(0);
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
    const configuredEnvironment = readFileSync(envPath, "utf8")
      .replace("ATLAS_PLUGINS=[]", 'ATLAS_PLUGINS=[{"id":"reference","base_url":"http://reference:8080"}]')
      .replace("ATLAS_SOURCE_GATEWAY_CONFIG_FILE=", "ATLAS_SOURCE_GATEWAY_CONFIG_FILE=/etc/atlas/gateway.json");
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
