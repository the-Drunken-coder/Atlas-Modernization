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
import { PACKAGE_VERSION } from "../src/package-metadata.js";

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
  readonly mismatchedResources = new Set<string>();
  inspectionError: { kind: "container" | "volume"; name: string } | undefined;
  failComposeDown = false;
  failComposeUp = false;
  processStartedAt = "Fri Aug 28 18:00:00 2026";
  serviceStates = [
    { Service: "api", State: "running", Health: "healthy" },
    { Service: "minio", State: "running", Health: "healthy" },
    { Service: "postgres", State: "running", Health: "healthy" }
  ];

  async run(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {}
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    this.calls.push({
      command,
      args,
      cwd: options.cwd,
      env: { ...options.env },
      inherit: options.inherit ?? false
    });
    if (command === "ps") return result(0, `${this.processStartedAt}\n`);
    if (args[0] === "volume" && args[1] === "create") {
      const name = args.at(-1) ?? "";
      this.existingVolumes.add(name);
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
      if (!this.existingContainers.has(name)) return result(1, "", `Error: No such container: ${name}`);
      const service = name.endsWith("_api")
        ? "api"
        : name.endsWith("_postgres")
          ? "postgres"
          : name.endsWith("_minio_init")
            ? "minio-init"
            : "minio";
      return result(
        0,
        JSON.stringify({
          "com.docker.compose.project": this.mismatchedResources.has(name) ? "other" : "atlas_core_production",
          "com.docker.compose.service": service
        })
      );
    }
    if (args.includes("ps")) return result(0, this.serviceStates.map((service) => JSON.stringify(service)).join("\n"));
    if (args[0] === "--version") return result(0, "Docker version 29.4.0\n");
    if (args[0] === "compose" && args[1] === "version") return result(0, "Docker Compose version v5.1.2\n");
    if (args[0] === "info") return result(0, "test-engine-id\n");
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
      nodeVersion: "24.19.0",
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      createSecret: () => `secret-${++secret}-abcdefghijklmnopqrstuvwxyz`
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

function markInitialized(test: TestRuntime, started = true): void {
  const config = join(test.home, ".atlas", "core");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, ".env"), "MINIO_BUCKET=atlas-media\n", { mode: 0o600 });
  test.runner.existingVolumes.add("atlas_core_production_minio_data");
  if (started) test.runner.existingVolumes.add("atlas_core_production_postgres_data");
  writeFileSync(
    join(config, "state.json"),
    `${JSON.stringify({
      schema: 1,
      phase: "ready",
      initializedAt: "2026-08-28T12:00:00.000Z",
      packageVersion: "0.1.0",
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

describe("atlas-core CLI", () => {
  it("prints help for no command", async () => {
    const test = runtime();
    expect(await runCLI([], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("atlas-core init");
    expect(test.runner.calls).toHaveLength(0);
  });

  it("rejects unknown commands with usage", async () => {
    const test = runtime();
    expect(await runCLI(["launch"], test.context)).toBe(2);
    expect(test.stderr.join("")).toContain("Unknown command: launch");
    expect(test.stderr.join("")).toContain("atlas-core start");
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
      schema: 1,
      phase: "ready",
      initializedAt: "2026-08-28T12:00:00.000Z",
      packageVersion: "0.1.0",
      dockerEngineId: "test-engine-id"
    });
    expect(statSync(join(config, ".env")).mode & 0o077).toBe(0);
    expect(existsSync(join(config, ".init.lock"))).toBe(false);
    expect(test.runner.existingVolumes).toContain("atlas_core_production_minio_data");
    expect(test.runner.existingVolumes).not.toContain("atlas_core_production_postgres_data");
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["up", "-d", "--wait", "--wait-timeout", "120", "minio"],
      [
        "exec",
        "-T",
        "minio",
        "sh",
        "-c",
        'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'
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
    writeFileSync(
      join(config, ".init.lock"),
      `${JSON.stringify({ pid: process.pid, processStartedAt: test.runner.processStartedAt })}\n`,
      { mode: 0o600 }
    );

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("Another atlas-core init process");
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toHaveLength(0);
  });

  it("fails closed on a stale initialization lock", async () => {
    const test = runtime();
    const config = join(test.home, ".atlas", "core");
    const lock = join(config, ".init.lock");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(lock, `${JSON.stringify({ pid: 2_147_483_647, processStartedAt: "stale" })}\n`, { mode: 0o600 });

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("stale initialization lock");
    expect(existsSync(lock)).toBe(true);
  });

  it("rejects arbitrary credentials without matching initialization state", async () => {
    const test = runtime();
    const config = join(test.home, ".atlas", "core");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, ".env"), "POSTGRES_PASSWORD=unmatched\n", { mode: 0o600 });

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("without matching initialization state");
  });

  it("does not resume initialization while the recorded process is still running", async () => {
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
        packageVersion: "0.1.0",
        dockerEngineId: "test-engine-id",
        initializingPid: 1,
        initializingProcessStartedAt: test.runner.processStartedAt
      })}\n`,
      { mode: 0o600 }
    );

    expect(await runCLI(["init"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("Another atlas-core init process");
  });

  it("recovers when an interrupted initialization PID has been reused", async () => {
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
        packageVersion: "0.1.0",
        dockerEngineId: "test-engine-id",
        initializingPid: 1,
        initializingProcessStartedAt: "Fri Aug 28 17:00:00 2026"
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

  it("does not reprovision an initialized deployment", async () => {
    const test = runtime();
    markInitialized(test);
    expect(await runCLI(["init"], test.context)).toBe(0);
    expect(test.stdout.join("")).toContain("already initialized");
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "up")).toBe(false);
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
    expect(up?.env.ATLAS_CORE_IMAGE).toBe(`ghcr.io/the-drunken-coder/atlas-core:${PACKAGE_VERSION}`);
    expect(up && composeCommand(up)).toEqual(["up", "-d", "--pull", "missing", "--wait", "--wait-timeout", "120"]);
    expect(test.runner.existingVolumes).toContain("atlas_core_production_postgres_data");
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      startedAt: "2026-08-28T12:00:00.000Z"
    });
  });

  it("does not let caller environment variables override generated configuration", async () => {
    const test = runtime();
    markInitialized(test, false);
    test.context.env = {
      PATH: "/usr/bin:/bin",
      POSTGRES_PASSWORD: "caller-postgres",
      MINIO_ROOT_PASSWORD: "caller-minio"
    };

    expect(await runCLI(["start"], test.context)).toBe(0);
    const up = test.runner.calls.find((call) => composeCommand(call)[0] === "up");
    expect(up?.env.PATH).toBe("/usr/bin:/bin");
    expect(up?.env.POSTGRES_PASSWORD).toBeUndefined();
    expect(up?.env.MINIO_ROOT_PASSWORD).toBeUndefined();
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
    const statePath = join(test.home, ".atlas", "core", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, `${JSON.stringify({ ...state, packageVersion: "0.0.9" })}\n`);
    expect(await runCLI(["start"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("automatic upgrades are not supported yet");
    expect(test.runner.calls.some((call) => composeCommand(call)[0] === "up")).toBe(false);
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

  it("returns unhealthy status when a required service is missing", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.serviceStates = test.runner.serviceStates.filter((service) => service.Service !== "api");
    expect(await runCLI(["status"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("api is missing");
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
