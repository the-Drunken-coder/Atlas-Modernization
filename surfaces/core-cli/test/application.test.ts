import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CLIContext, type CommandRunner, runCLI } from "../src/application.js";

type Call = {
  command: string;
  args: string[];
  inherit: boolean;
  image: string | undefined;
};

class FakeRunner implements CommandRunner {
  readonly calls: Call[] = [];
  readonly existingVolumes = new Set<string>();
  readonly existingContainers = new Set<string>();
  runningServices = "api\nminio\npostgres\n";

  async run(
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; inherit?: boolean } = {}
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    this.calls.push({
      command,
      args,
      inherit: options.inherit ?? false,
      image: options.env?.ATLAS_CORE_IMAGE
    });
    if (args[0] === "volume" && args[1] === "inspect") {
      return result(this.existingVolumes.has(args[2] ?? "") ? 0 : 1);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return result(this.existingContainers.has(args[2] ?? "") ? 0 : 1);
    }
    if (args.includes("ps")) return result(0, this.runningServices);
    if (args[0] === "--version") return result(0, "Docker version 29.4.0\n");
    if (args[0] === "compose" && args[1] === "version") return result(0, "Docker Compose version v5.1.2\n");
    if (args[0] === "info") return result(0, "Server Version: 29.4.0\n");
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
      initializedAt: "2026-08-28T12:00:00.000Z",
      packageVersion: "0.1.0",
      ...(started ? { startedAt: "2026-08-28T12:05:00.000Z" } : {})
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
      initializedAt: "2026-08-28T12:00:00.000Z",
      packageVersion: "0.1.0"
    });
    expect(statSync(join(config, ".env")).mode & 0o077).toBe(0);
    expect(test.runner.calls.map(composeCommand).filter((args) => args.length > 0)).toEqual([
      ["up", "-d", "--wait", "minio"],
      ["exec", "-T", "minio", "mc", "mb", "--ignore-existing", "local/atlas-media"],
      ["exec", "-T", "minio", "mc", "anonymous", "set", "none", "local/atlas-media"],
      ["down", "--remove-orphans"]
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
    expect(up?.image).toBe("ghcr.io/the-drunken-coder/atlas-core:0.1.0");
    expect(up && composeCommand(up)).toEqual(["up", "-d", "--pull", "missing", "--wait"]);
    expect(JSON.parse(readFileSync(join(test.home, ".atlas", "core", "state.json"), "utf8"))).toMatchObject({
      startedAt: "2026-08-28T12:00:00.000Z"
    });
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

  it("returns unhealthy status when a required service is missing", async () => {
    const test = runtime();
    markInitialized(test);
    test.runner.runningServices = "minio\npostgres\n";
    expect(await runCLI(["status"], test.context)).toBe(1);
    expect(test.stderr.join("")).toContain("Missing running services: api");
  });
});
