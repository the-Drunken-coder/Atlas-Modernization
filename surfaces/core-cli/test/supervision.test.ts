import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateSupervisorDefinition,
  getSupervisorStatus,
  installSupervisor,
  runSupervisor,
  type SupervisorCommandResult,
  type SupervisorFileSystem,
  type SupervisorInstallOptions,
  uninstallSupervisor
} from "../src/supervision.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runSupervisor", () => {
  it("runs ticks sequentially and backs off after failures", async () => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    const starts: number[] = [];
    let active = 0;
    let maximumActive = 0;

    await runSupervisor({
      intervalMs: 10,
      signal: controller.signal,
      onError: (error) => {
        errors.push(error);
      },
      tick: async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        starts.push(Date.now());
        await Promise.resolve();
        active--;
        if (starts.length === 1) throw new Error("first tick failed");
        if (starts.length === 3) controller.abort();
      }
    });

    expect(starts).toHaveLength(3);
    expect(maximumActive).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(15);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(8);
  });

  it("stops while waiting and remains quiet when the error observer fails", async () => {
    const controller = new AbortController();
    let ticks = 0;
    let errors = 0;
    const running = runSupervisor({
      intervalMs: 50,
      signal: controller.signal,
      onError: () => {
        errors++;
        throw new Error("observer failed");
      },
      tick: () => {
        ticks++;
        throw new Error("tick failed");
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    controller.abort();
    await running;

    expect(ticks).toBe(1);
    expect(errors).toBe(1);
  });

  it("rejects a negative interval instead of allowing a hot loop", async () => {
    await expect(runSupervisor({ intervalMs: -1, tick: () => undefined })).rejects.toThrow(/finite non-negative/);
  });
});

describe("supervisor service definitions", () => {
  const paths = {
    homeDirectory: "/Users/lane/Atlas User",
    coreHome: "/Users/lane/Atlas User/.atlas-core",
    nodeExecutable: "/opt/node/bin/node",
    cliScript: "/opt/atlas-core/node_modules/atlas-core/dist/cli.js"
  };

  it("generates a shell-free macOS LaunchAgent with deterministic executable paths", () => {
    const definition = generateSupervisorDefinition({ ...paths, platform: "darwin", userId: "501" });

    expect(definition.serviceName).toBe("com.the-drunken-coder.atlas-core.supervisor");
    expect(definition.servicePath).toBe(
      "/Users/lane/Atlas User/Library/LaunchAgents/com.the-drunken-coder.atlas-core.supervisor.plist"
    );
    expect(definition.command).toEqual([paths.nodeExecutable, paths.cliScript, "supervise"]);
    expect(definition.content).toContain("<key>ATLAS_CORE_HOME</key>");
    expect(definition.content).toContain("<string>/Users/lane/Atlas User/.atlas-core</string>");
    expect(definition.content).toContain("<string>/opt/node/bin/node</string>");
    expect(definition.content).toContain("<string>/opt/atlas-core/node_modules/atlas-core/dist/cli.js</string>");
    expect(definition.environment.PATH).toBe(
      "/opt/node/bin:/Users/lane/Atlas User/.docker/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
    expect(definition.content).toContain("<key>PATH</key>");
    expect(definition.content).toContain(
      "<string>/opt/node/bin:/Users/lane/Atlas User/.docker/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
    );
    expect(definition.startsWithoutLogin).toBe(false);
  });

  it("generates a systemd user unit with exact executable arguments and login limitation", () => {
    const definition = generateSupervisorDefinition({ ...paths, platform: "linux" });

    expect(definition.serviceName).toBe("atlas-core-supervisor.service");
    expect(definition.servicePath).toBe("/Users/lane/Atlas User/.config/systemd/user/atlas-core-supervisor.service");
    expect(definition.content).toContain(
      'ExecStart="/opt/node/bin/node" "/opt/atlas-core/node_modules/atlas-core/dist/cli.js" "supervise"'
    );
    expect(definition.content).toContain('Environment="ATLAS_CORE_HOME=/Users/lane/Atlas User/.atlas-core"');
    expect(definition.environment.PATH).toBe(
      "/opt/node/bin:/Users/lane/Atlas User/.docker/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
    expect(definition.content).toContain(
      'Environment="PATH=/opt/node/bin:/Users/lane/Atlas User/.docker/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"'
    );
    expect(definition.content).toContain("WantedBy=default.target");
    expect(definition.limitations.join(" ")).toMatch(/lingering/);
  });

  it("rejects non-absolute service inputs and missing macOS user IDs", () => {
    expect(() => generateSupervisorDefinition({ ...paths, platform: "linux", cliScript: "dist/cli.js" })).toThrow(
      /cliScript must be an absolute path/
    );
    expect(() => generateSupervisorDefinition({ ...paths, platform: "darwin" })).toThrow(/userId is required/);
  });
});

describe("supervisor installation adapters", () => {
  it("installs and uninstalls a LaunchAgent through the current user's domain", async () => {
    const root = await makeTempDirectory();
    const runner = fakeRunner({
      launchctl: (args) => (args[0] === "bootout" ? result(3) : result(0))
    });
    const options = installationOptions(root, "darwin", runner);

    const installed = await installSupervisor(options);
    expect(await readFile(installed.definition.servicePath, "utf8")).toBe(installed.definition.content);
    expect(runner.calls).toEqual([
      ["launchctl", ["bootout", "gui/501", installed.definition.servicePath]],
      ["launchctl", ["bootstrap", "gui/501", installed.definition.servicePath]],
      ["launchctl", ["enable", "gui/501/com.the-drunken-coder.atlas-core.supervisor"]]
    ]);

    await uninstallSupervisor(options);
    expect(runner.calls.at(-1)).toEqual(["launchctl", ["bootout", "gui/501", installed.definition.servicePath]]);
    expect(await options.filesystem.exists(installed.definition.servicePath)).toBe(false);
  });

  it("installs a systemd user unit without enabling lingering", async () => {
    const root = await makeTempDirectory();
    const runner = fakeRunner();
    const options = installationOptions(root, "linux", runner);

    const installed = await installSupervisor(options);
    expect(await readFile(installed.definition.servicePath, "utf8")).toContain("Restart=always");
    expect(runner.calls).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "atlas-core-supervisor.service"]],
      ["systemctl", ["--user", "restart", "atlas-core-supervisor.service"]]
    ]);
    expect(runner.calls.flat().join(" ")).not.toContain("enable-linger");
  });

  it("reports service and user-session state without mutating it", async () => {
    const root = await makeTempDirectory();
    const runner = fakeRunner({
      systemctl: (args) => {
        if (args[1] === "is-active") return result(0);
        return result(0);
      }
    });
    const options = installationOptions(root, "linux", runner);
    await installSupervisor(options);

    const status = await getSupervisorStatus(options);
    expect(status).toMatchObject({
      installed: true,
      loaded: true,
      running: true,
      enabled: true,
      userManagerAvailable: true,
      sessionRequired: true,
      startsWithoutLogin: false
    });
    expect(runner.calls.at(-2)).toEqual(["systemctl", ["--user", "is-active", "atlas-core-supervisor.service"]]);
    expect(runner.calls.at(-1)).toEqual(["systemctl", ["--user", "is-enabled", "atlas-core-supervisor.service"]]);
  });
});

function result(status: number, stdout = "", stderr = ""): SupervisorCommandResult {
  return { status, stdout, stderr };
}

type RunnerCall = [command: string, args: readonly string[]];

function fakeRunner(overrides: Partial<Record<string, (args: readonly string[]) => SupervisorCommandResult>> = {}) {
  const calls: RunnerCall[] = [];
  const runner = async (command: string, args: readonly string[]): Promise<SupervisorCommandResult> => {
    calls.push([command, args]);
    return overrides[command]?.(args) ?? result(0);
  };
  return Object.assign(runner, { calls });
}

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-supervision-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function installationOptions(
  root: string,
  platform: "darwin" | "linux",
  runner: ReturnType<typeof fakeRunner>
): SupervisorInstallOptions {
  return {
    platform,
    homeDirectory: root,
    coreHome: join(root, ".atlas-core"),
    nodeExecutable: "/opt/node/bin/node",
    cliScript: "/opt/atlas-core/dist/cli.js",
    ...(platform === "darwin" ? { userId: "501" } : {}),
    filesystem: filesystem,
    runner
  };
}

const filesystem: SupervisorFileSystem = {
  async mkdir(path, options) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: options?.recursive ?? false, mode: options?.mode });
  },
  async writeFile(path, contents, options) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, contents, { mode: options?.mode });
  },
  async rm(path, options) {
    const { rm } = await import("node:fs/promises");
    await rm(path, { force: options?.force ?? false });
  },
  async exists(path) {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }
};
