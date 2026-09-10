import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DeploymentTransaction,
  IndependentPluginManager,
  type IndependentPluginRelease,
  type PluginImageReceipt,
  type PluginLifecycleHost,
  type TransactionPhase
} from "../src/independent-plugins.js";

const image = "ghcr.io/the-drunken-coder/atlas-building-scan@sha256:" + "a".repeat(64);
const manifest = "sha256:" + "b".repeat(64);
const localImage = "sha256:" + "c".repeat(64);
const revision = "sha256:" + "d".repeat(64);
const dockerComposeAvailable = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

class FakeTransaction {
  readonly snapshots = new Map<string, Uint8Array | undefined>();
  readonly staged: string[] = [];
  readonly phases: TransactionPhase[] = [];
  committed = false;
  cleaned = false;
  constructor(readonly configDir: string) {}

  snapshot(path: string): void {
    if (this.snapshots.has(path)) return;
    const absolute = join(this.configDir, path);
    this.snapshots.set(path, existsSync(absolute) ? new Uint8Array(readFileSync(absolute)) : undefined);
  }

  stage(path: string): void {
    this.staged.push(path);
  }

  advance(phase: TransactionPhase): void {
    this.phases.push(phase);
  }

  markCommitted(): void {
    this.committed = true;
  }

  rollback(): void {
    for (const [path, bytes] of this.snapshots) {
      const absolute = join(this.configDir, path);
      if (bytes) writeFileSync(absolute, bytes, { mode: 0o600 });
      else if (existsSync(absolute)) rmSync(absolute, { force: true });
    }
    this.phases.push("rollback-complete");
  }

  cleanup(): void {
    this.cleaned = true;
  }
}

class FakeHost {
  readonly enabled = new Set<string>();
  readonly compose: string[][] = [];
  readonly removed: string[] = [];
  readonly removalSnapshots: { pluginId: string; activeExists: boolean }[] = [];
  running = false;
  failRuntime = false;
  catalogIsFresh = true;
  readonly imageReceipt: PluginImageReceipt = {
    image_index: image,
    platform_manifest_sha256: manifest,
    local_image_id: localImage
  };

  readonly host: PluginLifecycleHost;

  constructor(readonly configDir: string) {
    this.host = {
      configDir,
      dockerEngineId: "test-engine",
      contracts: {
        coreToPluginProtocolMajors: [1],
        pluginToSourceGatewayProtocolMajors: [1],
        atlasProtocolRevision: revision
      },
      readEnabled: () => [...this.enabled],
      writeEnabled: (pluginIds) => {
        this.enabled.clear();
        for (const pluginId of pluginIds) this.enabled.add(pluginId);
      },
      isRunning: () => this.running,
      pullAndInspectImage: async (imageIndex) => ({ ...this.imageReceipt, image_index: imageIndex }),
      verifyRetainedBundle: () => undefined,
      runCompose: async (args) => {
        this.compose.push([...args]);
      },
      verifyRuntime: () => {
        if (this.failRuntime) throw new Error("plugin health failed");
      },
      assertReleaseTrusted: () => undefined,
      removePlugin: (pluginId) => {
        this.removed.push(pluginId);
        this.removalSnapshots.push({
          pluginId,
          activeExists: existsSync(join(this.configDir, "plugins", pluginId, "active"))
        });
      },
      catalogFresh: () => this.catalogIsFresh
    };
  }
}

function release(
  version: string,
  sourceConnector: IndependentPluginRelease["sourceConnector"] = null
): IndependentPluginRelease {
  const document = {
    schema: 1,
    plugin_id: "building_scan",
    version,
    display_name: "Building Scan",
    lifecycle: "query_only",
    image,
    core_to_plugin_protocol_major: 1,
    plugin_to_source_gateway_protocol_major: 1,
    atlas_protocol_revision: null,
    interactions: ["map_area"],
    source_connector: sourceConnector
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
  return {
    schema: 1,
    pluginId: "building_scan",
    version,
    displayName: "Building Scan",
    lifecycle: "query_only",
    image,
    coreToPluginProtocolMajor: 1,
    pluginToSourceGatewayProtocolMajor: 1,
    atlasProtocolRevision: null,
    interactions: ["map_area"],
    sourceConnector,
    bytes
  };
}

function setup(): { host: FakeHost; manager: IndependentPluginManager; transaction: FakeTransaction } {
  const configDir = mkdtempSync(join(tmpdir(), "atlas-independent-plugin-"));
  chmodSync(configDir, 0o700);
  const templateDir = join(configDir, "base", "plugin-templates");
  mkdirSync(templateDir, { recursive: true, mode: 0o700 });
  const templates = new Map([
    ["service.json", { services: { "@atlas/plugin-service@": { image: "@atlas/plugin-image@" } } }],
    ["core-endpoint.json", { id: "@atlas/plugin-id@", base_url: "http://@atlas/plugin-service@:8080" }]
  ]);
  for (const [name, template] of templates) {
    const path = join(templateDir, name);
    writeFileSync(path, `${JSON.stringify(template)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const host = new FakeHost(configDir);
  const transaction = new FakeTransaction(configDir);
  return {
    host,
    manager: new IndependentPluginManager(host.host, () => {
      transaction.snapshots.clear();
      transaction.staged.length = 0;
      transaction.phases.length = 0;
      transaction.committed = false;
      transaction.cleaned = false;
      return transaction as unknown as DeploymentTransaction;
    }),
    transaction
  };
}

function installFullServiceTemplate(configDir: string): void {
  writeFileSync(
    join(configDir, "base/plugin-templates/service.json"),
    `${JSON.stringify({
      services: {
        api: { volumes: ["@atlas/core-endpoint-mount@"] },
        "source-gateway": {
          environment: { ATLAS_SOURCE_CONNECTOR_CONFIG_DIR: "@atlas/source-connector-config-dir@" },
          volumes: ["@atlas/source-connector-mount@"]
        },
        "@atlas/plugin-service@": { image: "@atlas/plugin-image@" }
      }
    })}\n`,
    { mode: 0o600 }
  );
}

describe("IndependentPluginManager", () => {
  it("installs an exact release and enables it without starting a stopped deployment", async () => {
    const { host, manager, transaction } = setup();
    const installed = await manager.install(release("0.1.0"));
    expect(installed.version).toBe("0.1.0");

    const enabled = await manager.enable("building_scan");
    expect(enabled.changed).toBe(true);
    expect([...host.enabled]).toEqual(["building_scan"]);
    expect(host.compose).toContainEqual(["config", "--quiet"]);
    expect(host.compose).not.toContainEqual(["up", "-d", "--no-build", "--pull", "never"]);
    expect(transaction.cleaned).toBe(true);
    expect(existsSync(join(host.configDir, "plugins/building_scan/active/deployment.json"))).toBe(true);
    expect(readFileSync(join(host.configDir, "plugins/building_scan/active/compose.yml"), "utf8")).not.toContain(
      "source-connector.json"
    );
  });

  it("omits Source Gateway connector configuration when the release has no connector", async () => {
    const { host, manager } = setup();
    installFullServiceTemplate(host.configDir);
    await manager.install(release("0.1.0"));
    await manager.enable("building_scan");

    const compose = JSON.parse(
      readFileSync(join(host.configDir, "plugins/building_scan/active/compose.yml"), "utf8")
    ) as {
      services: { "source-gateway": { environment?: Record<string, unknown>; volumes?: unknown[] } };
    };
    expect(compose.services["source-gateway"].environment).not.toHaveProperty("ATLAS_SOURCE_CONNECTOR_CONFIG_DIR");
    expect(compose.services["source-gateway"].volumes).toBeUndefined();
  });

  it("enables a Plugin in a running deployment with scoped readiness", async () => {
    const { host, manager } = setup();
    await manager.install(release("0.1.0"));
    host.running = true;

    await manager.enable("building_scan");

    expect(host.compose).toEqual([
      ["config", "--quiet"],
      [
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "120",
        "api",
        "source-gateway",
        "atlas-plugin-building-scan"
      ]
    ]);
    expect(host.compose.some(([command]) => command === "down")).toBe(false);
  });

  it("removes a disabled running Plugin before deleting active files and preserves base storage", async () => {
    const { host, manager } = setup();
    await manager.install(release("0.1.0"));
    await manager.enable("building_scan");
    host.running = true;
    host.compose.length = 0;
    host.removed.length = 0;
    host.removalSnapshots.length = 0;

    await manager.disable("building_scan");

    expect(host.removed).toEqual(["building_scan"]);
    expect(host.removalSnapshots).toEqual([{ pluginId: "building_scan", activeExists: true }]);
    expect(host.compose).toEqual([
      ["config", "--quiet"],
      [
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "120",
        "api",
        "source-gateway"
      ]
    ]);
    expect(host.compose.some(([command]) => command === "down")).toBe(false);
  });

  it("updates only the affected running Plugin services and waits for readiness", async () => {
    const { host, manager } = setup();
    await manager.install(release("0.1.0"));
    await manager.enable("building_scan");
    host.running = true;
    host.compose.length = 0;
    host.removed.length = 0;

    await manager.update("building_scan", release("0.2.0"));

    expect(host.removed).toEqual(["building_scan"]);
    expect(host.compose).toEqual([
      ["config", "--quiet"],
      [
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "120",
        "api",
        "source-gateway",
        "atlas-plugin-building-scan"
      ]
    ]);
    expect(host.compose.some(([command]) => command === "down")).toBe(false);
  });

  it("restores selected release and enabled state when runtime verification fails", async () => {
    const { host, manager, transaction } = setup();
    await manager.install(release("0.1.0"));
    await manager.enable("building_scan");
    host.running = true;
    host.failRuntime = true;

    await expect(manager.update("building_scan", release("0.2.0"))).rejects.toThrow("plugin health failed");
    expect(manager.readInstalled("building_scan").selected.version).toBe("0.1.0");
    expect(manager.readInstalled("building_scan").previous).toBeNull();
    expect([...host.enabled]).toEqual(["building_scan"]);
    expect(transaction.cleaned).toBe(true);
    expect(transaction.phases).toContain("runtime-changing");
    expect(transaction.phases).toContain("rollback-complete");
    expect(host.compose.some(([command]) => command === "down")).toBe(false);
    expect(host.compose.filter(([command]) => command === "up")).toEqual([
      [
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "120",
        "api",
        "source-gateway",
        "atlas-plugin-building-scan"
      ],
      [
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--no-deps",
        "--remove-orphans",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "120",
        "api",
        "source-gateway",
        "atlas-plugin-building-scan"
      ]
    ]);
  });

  it("rejects expired catalog mutations before downloading a release", async () => {
    const { host, manager } = setup();
    host.catalogIsFresh = false;
    await expect(manager.install(release("0.1.0"))).rejects.toThrow("catalog is expired");
  });

  it("regenerates enabled local state when the catalog has expired", async () => {
    const { host, manager } = setup();
    await manager.install(release("0.1.0"));
    await manager.enable("building_scan");
    host.catalogIsFresh = false;
    await expect(manager.regenerateActiveFiles()).resolves.toBeUndefined();
    await expect(manager.preflightEnabled()).resolves.toBeUndefined();
  });

  it("allows retrying an install after an orphaned plugin directory remains", async () => {
    const { host, manager } = setup();
    mkdirSync(join(host.configDir, "plugins/building_scan"), { recursive: true, mode: 0o700 });
    await expect(manager.install(release("0.1.0"))).resolves.toMatchObject({ changed: true, version: "0.1.0" });
  });

  it("selects the greatest compatible replacement when the selected release is revoked", async () => {
    const { manager } = setup();
    await manager.install(release("0.2.0"));
    const revoked = release("0.2.0");
    const replacement = release("0.1.0");
    const catalog = (candidate: IndependentPluginRelease, isRevoked: boolean) => ({
      pluginId: candidate.pluginId,
      version: candidate.version,
      displayName: candidate.displayName,
      documentUrl: `https://example.test/${candidate.version}.atlas-plugin`,
      documentSha256: `sha256:${createHash("sha256").update(candidate.bytes).digest("hex")}`,
      revoked: isRevoked,
      revocationReason: isRevoked ? "security issue" : null
    });

    await expect(
      manager.update("building_scan", [
        { release: revoked, catalog: catalog(revoked, true) },
        { release: replacement, catalog: catalog(replacement, false) }
      ])
    ).resolves.toMatchObject({ changed: true, version: "0.1.0", previousVersion: "0.2.0" });
    expect(manager.readInstalled("building_scan").selected.version).toBe("0.1.0");
  });

  it.skipIf(!dockerComposeAvailable)(
    "validates generated overlays with Docker Compose without starting services",
    async () => {
      const { host, manager } = setup();
      const packageTemplates = join(process.cwd(), "assets/plugin-templates");
      for (const name of ["service.json", "core-endpoint.json", "source-connector.json"]) {
        writeFileSync(join(host.configDir, "base/plugin-templates", name), readFileSync(join(packageTemplates, name)), {
          mode: 0o600
        });
      }
      writeFileSync(
        join(host.configDir, "base/docker-compose.yml"),
        [
          "services:",
          "  api:",
          "    image: busybox:latest",
          "  source-gateway:",
          "    image: busybox:latest",
          "networks:",
          "  atlas_core_network:",
          "    name: atlas_plugin_test_network"
        ].join("\n") + "\n",
        { mode: 0o600 }
      );

      const connector: NonNullable<IndependentPluginRelease["sourceConnector"]> = {
        id: "building_scan",
        origin: "https://example.test",
        routes: [
          {
            method: "GET",
            path_prefix: "/features",
            allowed_query_names: [],
            allowed_request_headers: [],
            allowed_response_headers: [],
            read_only: true,
            cache: { ttl_ms: 1000 },
            retry: {
              max_retries: 1,
              statuses: [503],
              failures: ["upstream_timeout"],
              idempotency_header: "x-atlas-operation-id"
            }
          }
        ],
        secret_headers: {},
        egress: { allow_private: false, allow_loopback: false, allow_link_local: false },
        limits: {
          timeout_ms: 1000,
          max_request_bytes: 1024,
          max_response_bytes: 4096,
          max_concurrency: 1,
          max_header_count: 8,
          max_header_bytes: 4096
        },
        rate: { requests_per_second: 1 },
        circuit_breaker: { failures: 3, open_ms: 1000 }
      };

      await manager.install(release("0.1.0"));
      await manager.enable("building_scan");
      const composeConfig = (quiet: boolean) =>
        execFileSync(
          "docker",
          [
            "compose",
            "--project-name",
            "atlas_plugin_test",
            "--file",
            join(host.configDir, "base/docker-compose.yml"),
            "--file",
            join(host.configDir, "plugins/building_scan/active/compose.yml"),
            "config",
            ...(quiet ? ["--quiet"] : [])
          ],
          {
            cwd: host.configDir,
            encoding: "utf8",
            env: {
              ...process.env,
              ATLAS_CORE_PROJECT: "atlas_plugin_test",
              ATLAS_CORE_ENGINE_ID: "test-engine",
              ATLAS_PLUGIN_CONFIG_ROOT: join(host.configDir, "plugins")
            }
          }
        );

      composeConfig(true);
      const noConnector = JSON.parse(
        readFileSync(join(host.configDir, "plugins/building_scan/active/compose.yml"), "utf8")
      );
      expect(noConnector.services["source-gateway"]).not.toHaveProperty("volumes");
      expect(readFileSync(join(host.configDir, "plugins/building_scan/active/compose.yml"), "utf8")).not.toContain(
        "source-connector.json"
      );

      await manager.disable("building_scan");
      await manager.update("building_scan", release("0.2.0", connector));
      await manager.enable("building_scan");
      const rendered = composeConfig(false);
      expect(rendered).toContain("atlas_plugin_test_atlas-plugin-building-scan");
      expect(rendered).toContain("source-connector.json");
      expect(existsSync(join(host.configDir, "plugins/building_scan/active/source-connector.json"))).toBe(true);
    }
  );

  it("rejects symlinks in private installed state before generating active files", async () => {
    const { host, manager } = setup();
    await manager.install(release("0.1.0"));
    const releaseDir = join(host.configDir, "plugins/building_scan/releases");
    symlinkSync("/tmp", join(releaseDir, "escape"));
    await expect(manager.enable("building_scan")).rejects.toThrow("symlink");
  });
});
