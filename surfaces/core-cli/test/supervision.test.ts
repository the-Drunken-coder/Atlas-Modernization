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
  type SupervisorServiceDefinition,
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
    cliScript: "/opt/atlas-core/node_modules/atlas-core/dist/cli.js",
    dockerHost: "unix:///var/run/docker.sock",
    cliVersion: "0.1.8"
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
    expect(definition.environment.DOCKER_CONTEXT).toBe("");
    expect(definition.environment.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(definition.environment.ATLAS_CORE_CLI_VERSION).toBe("0.1.8");
    expect(definition.content).toContain("<key>DOCKER_CONTEXT</key>");
    expect(definition.content).toContain("<key>DOCKER_HOST</key>");
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
    expect(definition.content).toContain('Environment="ATLAS_CORE_CLI_VERSION=0.1.8"');
    expect(definition.content).toContain('Environment="DOCKER_CONTEXT="');
    expect(definition.content).toContain('Environment="DOCKER_HOST=unix:///var/run/docker.sock"');
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
    expect(() =>
      generateSupervisorDefinition({ ...paths, platform: "linux", dockerHost: "tcp://127.0.0.1:2375" })
    ).toThrow(/local Unix socket endpoint/);
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

  it("matches the current user's loaded LaunchAgent target", async () => {
    const root = await makeTempDirectory();
    let definition: SupervisorServiceDefinition | undefined;
    const runner = fakeRunner({
      launchctl: (args) =>
        args[0] === "print" && definition ? result(0, launchdLiveConfiguration(definition)) : result(0)
    });
    const options = installationOptions(root, "darwin", runner);
    definition = generateSupervisorDefinition(options);

    await installSupervisor(options);

    await expect(getSupervisorStatus(options)).resolves.toMatchObject({
      installed: true,
      loaded: true,
      running: true,
      userManagerAvailable: true
    });
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
        if (args[1] === "show") return result(0, systemdLiveConfiguration(root));
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
    expect(runner.calls.at(-3)).toEqual(["systemctl", ["--user", "is-active", "atlas-core-supervisor.service"]]);
    expect(runner.calls.at(-2)).toEqual(["systemctl", ["--user", "is-enabled", "atlas-core-supervisor.service"]]);
    expect(runner.calls.at(-1)).toEqual([
      "systemctl",
      ["--user", "show", "atlas-core-supervisor.service", "--property", "ExecStart", "--property", "Environment"]
    ]);
  });

  it("rejects a loaded systemd service targeting another CLI installation", async () => {
    const root = await makeTempDirectory();
    const runner = fakeRunner({
      systemctl: (args) => {
        if (args[1] === "show") return result(0, systemdLiveConfiguration(root, "/opt/other-atlas-core/dist/cli.js"));
        return result(0);
      }
    });
    const options = installationOptions(root, "linux", runner);
    await installSupervisor(options);

    const status = await getSupervisorStatus(options);
    expect(status).toMatchObject({
      loaded: false,
      serviceRunning: true,
      running: false,
      enabled: true,
      userManagerAvailable: true
    });
    expect(status.message).toMatch(/does not target this CLI installation/i);
  });

  it("rejects a running Linux supervisor from an older CLI version", async () => {
    const root = await makeTempDirectory();
    const options = installationOptions(root, "linux", fakeRunner());
    const runner = fakeRunner({
      systemctl: (args) =>
        args[1] === "show" ? result(0, systemdLiveConfiguration(root, undefined, undefined, "0.1.7")) : result(0)
    });
    const current = { ...options, runner };
    await installSupervisor(current);

    const status = await getSupervisorStatus(current);
    expect(status).toMatchObject({
      loaded: false,
      serviceRunning: true,
      running: false,
      enabled: true,
      userManagerAvailable: true
    });
    expect(status.message).toMatch(/does not target this CLI installation/i);
  });

  it("matches systemd live properties with escaped spaces in paths", async () => {
    const root = await makeTempDirectory();
    const runner = fakeRunner({
      systemctl: (args) => {
        if (args[1] === "show")
          return result(
            0,
            systemdLiveConfiguration(root, "/opt/Atlas User/dist/cli.js", join(root, "Atlas User", ".atlas-core"))
          );
        return result(0);
      }
    });
    const options = {
      ...installationOptions(root, "linux", runner),
      coreHome: join(root, "Atlas User", ".atlas-core"),
      cliScript: "/opt/Atlas User/dist/cli.js"
    };
    await installSupervisor(options);

    await expect(getSupervisorStatus(options)).resolves.toMatchObject({ loaded: true, running: true });
  });

  it("rejects a stale on-disk supervisor definition", async () => {
    const root = await makeTempDirectory();
    const runner = fakeRunner({
      systemctl: (args) => {
        if (args[1] === "show") return result(0, systemdLiveConfiguration(root));
        return result(0);
      }
    });
    const options = installationOptions(root, "linux", runner);
    const installed = await installSupervisor(options);
    await options.filesystem.writeFile(installed.definition.servicePath, "stale definition\n");

    const status = await getSupervisorStatus(options);
    expect(status).toMatchObject({ loaded: false, running: false, enabled: true });
    expect(status.message).toMatch(/does not target this CLI installation/i);
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
    dockerHost: "unix:///var/run/docker.sock",
    cliVersion: "0.1.8",
    ...(platform === "darwin" ? { userId: "501" } : {}),
    filesystem: filesystem,
    runner
  };
}

function systemdLiveConfiguration(
  root: string,
  cliScript = "/opt/atlas-core/dist/cli.js",
  coreHome = join(root, ".atlas-core"),
  cliVersion = "0.1.8",
  dockerHost = "unix:///var/run/docker.sock"
): string {
  const path = [
    "/opt/node/bin",
    join(root, ".docker", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].join(":");
  const escape = (value: string): string => value.replaceAll(" ", "\\x20");
  return `ExecStart={ path=${escape("/opt/node/bin/node")} ; argv[]=${escape("/opt/node/bin/node")} ${escape(cliScript)} supervise ; ignore_errors=no ; }\nEnvironment=ATLAS_CORE_HOME=${escape(coreHome)} ATLAS_CORE_CLI_VERSION=${escape(cliVersion)} DOCKER_CONTEXT= DOCKER_HOST=${escape(dockerHost)} PATH=${escape(path)}\n`;
}

function launchdLiveConfiguration(definition: SupervisorServiceDefinition): string {
  return `gui/501/${definition.serviceName} = {
\tpath = ${definition.servicePath}
\tstate = running
\tprogram = ${definition.command[0]}
\targuments = {
\t\t${definition.command[0]}
\t\t${definition.command[1]}
\t\tsupervise
\t}
\tenvironment = {
\t\tATLAS_CORE_HOME => ${definition.environment.ATLAS_CORE_HOME}
\t\tATLAS_CORE_CLI_VERSION => ${definition.environment.ATLAS_CORE_CLI_VERSION}
\t\tDOCKER_CONTEXT => ${definition.environment.DOCKER_CONTEXT}
\t\tDOCKER_HOST => ${definition.environment.DOCKER_HOST}
\t\tPATH => ${definition.environment.PATH}
\t}
}
`;
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
  async read(path) {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path, "utf8");
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
