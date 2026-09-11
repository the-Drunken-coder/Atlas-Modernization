import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeploymentTransactionStore } from "../src/deployment-transaction.js";
import type { ImageReceipt } from "../src/image-receipts.js";
import {
  ManagedCoreManager,
  type ManagedCoreOptions,
  type ManagedCoreState,
  parseManagedCoreState
} from "../src/managed-core.js";

const ENGINE = "managed-core-test-engine";
const IMAGE = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"a".repeat(64)}`;
const NEXT_IMAGE = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"b".repeat(64)}`;
const POSTGRES_IMAGE = `postgres:15@sha256:${"1".repeat(64)}`;
const MINIO_IMAGE = `minio/minio:RELEASE.2024-01-31T20-20-33Z@sha256:${"2".repeat(64)}`;
const MC_IMAGE = `minio/mc:RELEASE.2024-01-31T08-59-40Z@sha256:${"3".repeat(64)}`;
const RECEIPT: ImageReceipt = {
  image_index: IMAGE,
  platform_manifest_sha256: `sha256:${"c".repeat(64)}`,
  local_image_id: `sha256:${"d".repeat(64)}`
};
const NEXT_RECEIPT: ImageReceipt = {
  image_index: NEXT_IMAGE,
  platform_manifest_sha256: `sha256:${"e".repeat(64)}`,
  local_image_id: `sha256:${"f".repeat(64)}`
};
const CONTRACTS = {
  coreToPluginProtocolMajors: [1],
  pluginToSourceGatewayProtocolMajors: [1],
  atlasProtocolRevision: `sha256:${"1".repeat(64)}`,
  supportedPackageSchemaMajors: [1],
  supportedInteractions: ["map_area"]
} as const;
const BACKUP_IDENTITY = `sha256:${"9".repeat(64)}` as const;
const BUNDLE_FILES_WITH_OBSOLETE = [
  "docker-compose.yml",
  "docker-compose.init.yml",
  "source_gateway.production.json",
  "plugin-templates/service.json",
  "plugin-templates/core-endpoint.json",
  "plugin-templates/source-connector.json",
  "obsolete.txt"
] as const;

type Call = { args: readonly string[]; pluginIds: readonly string[]; coreImage: string; cleanup?: boolean };

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "atlas-managed-core-test-"));
}

function packageDirectory(image: string, suffix = "package"): string {
  const root = join(temporaryDirectory(), suffix);
  const assets = join(root, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(
    join(assets, "docker-compose.yml"),
    `services:\n  api:\n    image: \${ATLAS_CORE_IMAGE}\n    restart: "no"\n    volumes: ["./source_gateway.production.json:/app/source.json:ro"]\n  postgres:\n    image: ${POSTGRES_IMAGE}\n    restart: "no"\n  minio:\n    image: ${MINIO_IMAGE}\n    restart: "no"\n  minio-init:\n    image: ${MC_IMAGE}\n    restart: "no"\n`
  );
  writeFileSync(
    join(assets, "docker-compose.init.yml"),
    "services:\n  minio:\n    extends: { file: docker-compose.yml, service: api }\n"
  );
  writeFileSync(join(assets, "source_gateway.production.json"), '{"listen_address":":8080"}\n');
  const templates = join(assets, "plugin-templates");
  mkdirSync(templates, { recursive: true });
  writeFileSync(join(templates, "service.json"), "{}\n");
  writeFileSync(join(templates, "core-endpoint.json"), "{}\n");
  writeFileSync(join(templates, "source-connector.json"), "{}\n");
  if (image === NEXT_IMAGE)
    writeFileSync(
      join(assets, "docker-compose.yml"),
      readFileSync(join(assets, "docker-compose.yml"), "utf8") + "# next\n"
    );
  return root;
}

function makeOptions(
  configDir: string,
  packageRoot: string,
  packageImage: string,
  stateRef: { current: ManagedCoreState | undefined },
  calls: Call[],
  receipt: ImageReceipt,
  overrides: Partial<ManagedCoreOptions> = {}
): ManagedCoreOptions {
  return {
    configDir,
    packageRoot,
    packageVersion: packageImage === IMAGE ? "0.1.8" : "0.1.9",
    packageImage,
    packageContracts: CONTRACTS,
    dockerEngineId: ENGINE,
    architecture: "arm64",
    readState: () => stateRef.current,
    writeState: (state) => {
      stateRef.current = state;
    },
    runCompose: async (args, pluginIds, options) => {
      calls.push({ args, pluginIds, coreImage: options.coreImage, ...(options.cleanup ? { cleanup: true } : {}) });
      return { status: 0, stdout: "", stderr: "" };
    },
    pullImage: async (image) =>
      image === receipt.image_index
        ? receipt
        : {
            image_index: image,
            platform_manifest_sha256: `sha256:${"1".repeat(64)}`,
            local_image_id: `sha256:${"2".repeat(64)}`
          },
    verifyLocalImage: async () => undefined,
    verifyContainerImage: async () => undefined,
    assertStorageSafe: async () => undefined,
    regeneratePlugins: async () => undefined,
    verifyPlugins: async () => undefined,
    preflightPlugins: async () => undefined,
    ensureCredential: async () => undefined,
    readMigrationLedger: async () => "migration-ledger-v1",
    readBackupIdentity: async () => BACKUP_IDENTITY,
    ...overrides
  };
}

function readyState(image = IMAGE, receipt = RECEIPT): ManagedCoreState {
  return {
    schema: 4,
    resourceLayout: "engine-scoped-v1",
    phase: "ready",
    initializedAt: "2026-09-09T12:00:00.000Z",
    packageVersion: image === IMAGE ? "0.1.8" : "0.1.9",
    dockerEngineId: ENGINE,
    enabledPlugins: [],
    baseDeployment: {
      bundleSha256: `sha256:${"0".repeat(64)}`,
      coreImage: image,
      coreLocalImageId: receipt.local_image_id as `sha256:${string}`,
      images: [receipt]
    },
    pluginContracts: CONTRACTS
  };
}

describe("ManagedCoreManager", () => {
  it("initializes a schema-4 state through a stopped temporary Core", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );

    const state = await manager.initialize();

    expect(state.schema).toBe(4);
    expect(state.phase).toBe("ready");
    expect(state.startAttemptedAt).toBeTruthy();
    expect(state.startedAt).toBeTruthy();
    expect(state.baseDeployment?.coreImage).toBe(IMAGE);
    expect(state.baseDeployment?.images?.map((image) => image.image_index)).toEqual([
      IMAGE,
      MC_IMAGE,
      MINIO_IMAGE,
      POSTGRES_IMAGE
    ]);
    expect(calls.map((call) => call.args[0])).toEqual(["up", "down"]);
    expect(calls[0]?.args).toContain("api");
    expect(calls[0]?.args).toContain("postgres");
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
    expect(readFileSync(join(configDir, "state.json"), "utf8")).toContain('"schema": 4');
  });

  it("keeps a pending transaction stopped when target startup fails and retries the exact candidate", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const oldPackage = packageDirectory(IMAGE, "old");
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, oldPackage, IMAGE, stateRef, calls, RECEIPT, { desiredRunning: false })
    );
    stateRef.current = await initial.initialize();
    calls.length = 0;

    let failTarget = true;
    const next = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(NEXT_IMAGE, "next"), NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT, {
        previousRunning: true,
        desiredRunning: true,
        runCompose: async (args, pluginIds, options) => {
          calls.push({ args, pluginIds, coreImage: options.coreImage, ...(options.cleanup ? { cleanup: true } : {}) });
          if (failTarget && args.includes("api") && options.coreImage === NEXT_IMAGE) {
            failTarget = false;
            return { status: 1, stdout: "", stderr: "target failed" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
      })
    );

    await expect(next.update(stateRef.current)).rejects.toThrow(/target failed/);
    expect(existsSync(join(configDir, "transaction", "journal.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(configDir, "state.json"), "utf8"))).toMatchObject({ phase: "initializing" });
    expect(await next.recover("status")).toMatchObject({ pending: true, journal: { phase: "core-started" } });

    const recovered = await next.recover("retry");
    expect((recovered as ManagedCoreState).phase).toBe("ready");
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
    expect(calls.some((call) => call.coreImage === NEXT_IMAGE && call.args[0] === "up")).toBe(true);
  });

  it("keeps a stopped update recoverable when migration-ledger setup starts storage", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "ledger-old"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    calls.length = 0;

    let postgresRunning = false;
    let stopFails = true;
    const next = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(NEXT_IMAGE, "ledger-next"), NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT, {
        previousRunning: false,
        desiredRunning: false,
        readMigrationLedger: async () => {
          postgresRunning = true;
          throw new Error("migration ledger read interrupted");
        },
        runCompose: async (args, pluginIds, options) => {
          calls.push({ args, pluginIds, coreImage: options.coreImage, ...(options.cleanup ? { cleanup: true } : {}) });
          if (options.cleanup && args[0] === "down" && stopFails) {
            return { status: 1, stdout: "", stderr: "storage stop interrupted" };
          }
          if (options.cleanup && args[0] === "down") postgresRunning = false;
          return { status: 0, stdout: "", stderr: "" };
        }
      })
    );

    await expect(next.update(stateRef.current)).rejects.toThrow(/Recovery also failed/);
    expect(postgresRunning).toBe(true);
    expect(DeploymentTransactionStore.open(configDir).journal.phase).toBe("runtime-changing");

    stopFails = false;
    const recovered = await next.recover("retry");
    expect((recovered as ManagedCoreState).packageVersion).toBe("0.1.8");
    expect(postgresRunning).toBe(false);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("replaces the staged bundle when forward recovery removes a file", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "forward-old"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    calls.length = 0;

    const failedPackage = packageDirectory(NEXT_IMAGE, "forward-failed");
    writeFileSync(join(failedPackage, "assets", "obsolete.txt"), "obsolete\n");
    const failed = new ManagedCoreManager(
      makeOptions(configDir, failedPackage, NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT, {
        previousRunning: false,
        desiredRunning: true,
        bundleFiles: BUNDLE_FILES_WITH_OBSOLETE,
        verifyPlugins: async (_state, options) => {
          if (options.requireHealth) throw new Error("failed target Plugin health check");
        }
      })
    );

    await expect(failed.update(stateRef.current)).rejects.toThrow("failed target Plugin health check");
    expect(existsSync(join(configDir, "base", "obsolete.txt"))).toBe(true);

    const forwardPackage = packageDirectory(NEXT_IMAGE, "forward-final");
    const finalManager = new ManagedCoreManager(
      makeOptions(configDir, forwardPackage, NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT)
    );
    const recovered = await finalManager.recover("forward", {
      target: {
        packageRoot: forwardPackage,
        packageVersion: "0.1.9",
        packageImage: NEXT_IMAGE,
        packageContracts: CONTRACTS
      }
    });

    expect((recovered as ManagedCoreState).phase).toBe("ready");
    expect(existsSync(join(configDir, "base", "obsolete.txt"))).toBe(false);
    await finalManager.start(recovered as ManagedCoreState);
  });

  it("requires the restored paired backup identity before accepting a rollback", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "restore-old"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    calls.length = 0;

    const failed = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(NEXT_IMAGE, "restore-next"), NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT, {
        previousRunning: false,
        desiredRunning: true,
        runCompose: async (args, pluginIds, options) => {
          calls.push({ args, pluginIds, coreImage: options.coreImage, ...(options.cleanup ? { cleanup: true } : {}) });
          if (args[0] === "up" && args.includes("api") && options.coreImage === NEXT_IMAGE) {
            return { status: 1, stdout: "", stderr: "target failed" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
      })
    );
    await expect(failed.update(stateRef.current)).rejects.toThrow("target failed");

    const mismatched = new ManagedCoreManager(
      makeOptions(
        configDir,
        packageDirectory(NEXT_IMAGE, "restore-mismatch"),
        NEXT_IMAGE,
        stateRef,
        calls,
        NEXT_RECEIPT,
        {
          readBackupIdentity: async () => `sha256:${"8".repeat(64)}`
        }
      )
    );
    await expect(mismatched.recover("restored", { confirmPairedRestore: true })).rejects.toThrow(
      /backup identity does not match/
    );
    expect(existsSync(join(configDir, "transaction", "journal.json"))).toBe(true);

    const restored = await failed.recover("restored", { confirmPairedRestore: true });
    expect((restored as ManagedCoreState).packageVersion).toBe("0.1.8");
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("retains a paired rollback journal until the prior Core is healthy", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const oldPackage = packageDirectory(IMAGE, "paired-retry-old");
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, oldPackage, IMAGE, stateRef, calls, RECEIPT, { desiredRunning: false })
    );
    stateRef.current = await initial.initialize();
    calls.length = 0;

    let failTarget = true;
    let failPrior = true;
    const failed = new ManagedCoreManager(
      makeOptions(
        configDir,
        packageDirectory(NEXT_IMAGE, "paired-retry-next"),
        NEXT_IMAGE,
        stateRef,
        calls,
        NEXT_RECEIPT,
        {
          previousRunning: false,
          desiredRunning: true,
          runCompose: async (args, pluginIds, options) => {
            calls.push({
              args,
              pluginIds,
              coreImage: options.coreImage,
              ...(options.cleanup ? { cleanup: true } : {})
            });
            if (failTarget && args[0] === "up" && options.coreImage === NEXT_IMAGE) {
              failTarget = false;
              return { status: 1, stdout: "", stderr: "target failed" };
            }
            if (failPrior && args[0] === "up" && options.coreImage === IMAGE) {
              failPrior = false;
              return { status: 1, stdout: "", stderr: "prior failed" };
            }
            return { status: 0, stdout: "", stderr: "" };
          }
        }
      )
    );

    await expect(failed.update(stateRef.current)).rejects.toThrow("target failed");
    await expect(failed.recover("restored", { confirmPairedRestore: true })).rejects.toThrow("prior failed");
    expect(DeploymentTransactionStore.open(configDir).journal.phase).toBe("rollback-complete");

    const recovered = await failed.recover("retry");
    expect((recovered as ManagedCoreState).packageVersion).toBe("0.1.8");
    expect(calls.filter((call) => call.args[0] === "up" && call.coreImage === IMAGE)).toHaveLength(2);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("stops a partially restored prior Core when run intent changes to stopped", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "paired-stopped-old"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    calls.length = 0;

    let failTarget = true;
    let failPrior = true;
    let runIntent = true;
    const failed = new ManagedCoreManager(
      makeOptions(
        configDir,
        packageDirectory(NEXT_IMAGE, "paired-stopped-next"),
        NEXT_IMAGE,
        stateRef,
        calls,
        NEXT_RECEIPT,
        {
          previousRunning: false,
          desiredRunning: true,
          readRunIntent: () => runIntent,
          runCompose: async (args, pluginIds, options) => {
            calls.push({
              args,
              pluginIds,
              coreImage: options.coreImage,
              ...(options.cleanup ? { cleanup: true } : {})
            });
            if (failTarget && args[0] === "up" && options.coreImage === NEXT_IMAGE) {
              failTarget = false;
              return { status: 1, stdout: "", stderr: "target failed" };
            }
            if (failPrior && args[0] === "up" && options.coreImage === IMAGE) {
              failPrior = false;
              return { status: 1, stdout: "", stderr: "prior failed" };
            }
            return { status: 0, stdout: "", stderr: "" };
          }
        }
      )
    );

    await expect(failed.update(stateRef.current)).rejects.toThrow("target failed");
    await expect(failed.recover("restored", { confirmPairedRestore: true })).rejects.toThrow("prior failed");
    expect(DeploymentTransactionStore.open(configDir).journal.phase).toBe("rollback-complete");
    runIntent = false;

    const restored = await failed.recover("retry");
    expect((restored as ManagedCoreState).packageVersion).toBe("0.1.8");
    expect(calls.filter((call) => call.args[0] === "up" && call.coreImage === IMAGE)).toHaveLength(1);
    expect(calls.some((call) => call.args[0] === "down" && call.coreImage === IMAGE)).toBe(true);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("restores the prior composition when an update fails after stopping it", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "old"), IMAGE, stateRef, calls, RECEIPT, { desiredRunning: false })
    );
    stateRef.current = await initial.initialize();
    calls.length = 0;

    let failGeneration = true;
    const next = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(NEXT_IMAGE, "next"), NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT, {
        previousRunning: true,
        desiredRunning: true,
        regeneratePlugins: async () => {
          if (failGeneration) {
            failGeneration = false;
            throw new Error("candidate generation failed");
          }
        }
      })
    );

    await expect(next.update(stateRef.current)).rejects.toThrow("candidate generation failed");
    expect(stateRef.current?.packageVersion).toBe("0.1.8");
    expect(calls.map((call) => [call.args[0], call.coreImage])).toEqual([
      ["down", IMAGE],
      ["down", NEXT_IMAGE],
      ["up", IMAGE]
    ]);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("keeps a fresh init transaction when storage setup fails before Core starts", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    let storageAllocated = false;
    let failStorageSetup = true;
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE), IMAGE, stateRef, calls, RECEIPT, {
        assertStorageSafe: async () => {
          storageAllocated = true;
          if (failStorageSetup) {
            failStorageSetup = false;
            throw new Error("storage setup interrupted");
          }
        }
      })
    );

    await expect(manager.initialize()).rejects.toThrow("storage setup interrupted");
    expect(storageAllocated).toBe(true);
    expect(existsSync(join(configDir, "transaction", "journal.json"))).toBe(true);

    const recovered = await manager.recover("retry");
    expect((recovered as ManagedCoreState).phase).toBe("ready");
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("does not retarget an interrupted init from a newer CLI package", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const original = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "original-init"), IMAGE, stateRef, calls, RECEIPT, {
        regeneratePlugins: async () => {
          throw new Error("init interrupted");
        }
      })
    );

    await expect(original.initialize()).rejects.toThrow("init interrupted");
    expect(await original.recover("status")).toMatchObject({ pending: true, journal: { phase: "runtime-changing" } });
    const callsBeforeRetry = calls.length;
    const newer = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(NEXT_IMAGE, "newer-init"), NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT)
    );

    await expect(newer.recover("retry")).rejects.toThrow(/exact CLI package/);
    expect(calls).toHaveLength(callsBeforeRetry);
    expect(existsSync(join(configDir, "transaction", "journal.json"))).toBe(true);
  });

  it("passes plugin service names only to the separate plugin startup", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE), IMAGE, stateRef, calls, RECEIPT, { desiredRunning: false })
    );
    const initializing: ManagedCoreState = {
      schema: 4,
      resourceLayout: "engine-scoped-v1",
      phase: "initializing",
      initializedAt: "2026-09-09T12:00:00.000Z",
      packageVersion: "0.1.8",
      dockerEngineId: ENGINE,
      enabledPlugins: ["building_scan"]
    };

    await manager.initialize(initializing);
    const pluginStart = calls.find((call) => call.args[0] === "up" && call.args.includes("--no-deps"));
    expect(pluginStart?.pluginIds).toEqual(["building_scan"]);
    expect(pluginStart?.args).toContain("atlas-plugin-building-scan");
    expect(pluginStart?.args).not.toContain("api");
  });

  it("does not gate normal Core start on Plugin health", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "normal-start"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    const state = { ...stateRef.current, enabledPlugins: ["building_scan"] };
    let requireHealth: boolean | undefined;
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "normal-start-run"), IMAGE, stateRef, calls, RECEIPT, {
        verifyPlugins: async (_state, options) => {
          requireHealth = options.requireHealth;
          if (options.requireHealth) throw new Error("Plugin health should not gate normal start");
        }
      })
    );

    await manager.start(state);
    expect(requireHealth).toBe(false);
    const pluginStart = calls.find((call) => call.args.includes("--no-deps"));
    expect(pluginStart?.args).not.toContain("--wait");
  });

  it("gates a Core update on enabled Plugin health before commit", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "health-old"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    const state = { ...stateRef.current, enabledPlugins: ["building_scan"] };
    let requireHealth: boolean | undefined;
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(NEXT_IMAGE, "health-next"), NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT, {
        previousRunning: false,
        desiredRunning: false,
        verifyPlugins: async (_state, options) => {
          requireHealth = options.requireHealth;
          if (options.requireHealth) throw new Error("Plugin is unhealthy");
        }
      })
    );

    await expect(manager.update(state)).rejects.toThrow("Plugin is unhealthy");
    expect(requireHealth).toBe(true);
    const pluginStart = calls.find((call) => call.args.includes("--no-deps"));
    expect(pluginStart?.args).toContain("--wait");
    expect(await manager.recover("status")).toMatchObject({
      pending: true,
      journal: { phase: "credentials-durable" }
    });
  });

  it("stops a started target while retaining the journal when cleanup fails", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "stop-target-old"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    const priorState = { ...stateRef.current, enabledPlugins: ["building_scan"] };
    calls.length = 0;

    let stopFails = true;
    const failed = new ManagedCoreManager(
      makeOptions(
        configDir,
        packageDirectory(NEXT_IMAGE, "stop-target-next"),
        NEXT_IMAGE,
        stateRef,
        calls,
        NEXT_RECEIPT,
        {
          previousRunning: false,
          desiredRunning: true,
          ensureCredential: async () => {
            throw new Error("credential setup failed");
          },
          runCompose: async (args, pluginIds, options) => {
            calls.push({
              args,
              pluginIds,
              coreImage: options.coreImage,
              ...(options.cleanup ? { cleanup: true } : {})
            });
            if (stopFails && args[0] === "down") return { status: 1, stdout: "", stderr: "stop failed" };
            return { status: 0, stdout: "", stderr: "" };
          }
        }
      )
    );

    await expect(failed.update(priorState)).rejects.toThrow(/Recovery also failed/);
    expect(DeploymentTransactionStore.open(configDir).journal.phase).toBe("core-started");
    expect(calls.at(-1)).toMatchObject({
      args: ["down", "--remove-orphans"],
      pluginIds: ["building_scan"],
      coreImage: NEXT_IMAGE,
      cleanup: true
    });

    await expect(failed.stopPendingTarget()).rejects.toThrow("Could not stop Atlas Core");
    expect(DeploymentTransactionStore.open(configDir).journal.phase).toBe("core-started");

    stopFails = false;
    await expect(failed.stopPendingTarget()).resolves.toBeUndefined();
    expect(DeploymentTransactionStore.open(configDir).journal.phase).toBe("core-started");
    expect(calls.at(-1)).toMatchObject({
      args: ["down", "--remove-orphans"],
      pluginIds: ["building_scan"],
      coreImage: NEXT_IMAGE,
      cleanup: true
    });
    expect(existsSync(join(configDir, "transaction"))).toBe(true);
  });

  it("rejects a running Core update before mutation when an enabled Plugin is unhealthy", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "preflight-health-old"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    const state = { ...stateRef.current, enabledPlugins: ["building_scan"] };
    calls.length = 0;

    const next = new ManagedCoreManager(
      makeOptions(
        configDir,
        packageDirectory(NEXT_IMAGE, "preflight-health-next"),
        NEXT_IMAGE,
        stateRef,
        calls,
        NEXT_RECEIPT,
        {
          previousRunning: true,
          desiredRunning: true,
          verifyPlugins: async (_state, options) => {
            if (options.requireHealth) throw new Error("enabled Plugin is unavailable");
          }
        }
      )
    );

    await expect(next.update(state)).rejects.toThrow("enabled Plugin is unavailable");
    expect(calls).toEqual([]);
    expect(DeploymentTransactionStore.exists(configDir)).toBe(false);
    expect(stateRef.current?.packageVersion).toBe("0.1.8");
  });

  it("repairs only when the current package reproduces the recorded bundle hash", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE), IMAGE, stateRef, calls, RECEIPT, { desiredRunning: false })
    );
    stateRef.current = await manager.initialize();
    const repaired = await manager.repairBundle(stateRef.current);
    expect(repaired).toBeUndefined();
  });

  it("leaves the committed bundle intact when bundle repair has the wrong package", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "old"), IMAGE, stateRef, calls, RECEIPT, { desiredRunning: false })
    );
    stateRef.current = await initial.initialize();
    const before = readFileSync(join(configDir, "base", "docker-compose.yml"));

    const wrongPackage = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(NEXT_IMAGE, "wrong"), NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT)
    );
    await expect(wrongPackage.repairBundle(stateRef.current)).rejects.toThrow(/recorded bundle/);
    expect(readFileSync(join(configDir, "base", "docker-compose.yml"))).toEqual(before);
    expect(existsSync(join(configDir, "transaction"))).toBe(false);
  });

  it("repairs a damaged bundle from the recorded package when the CLI package changed", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const recordedPackage = packageDirectory(IMAGE, "recorded-repair");
    const initial = new ManagedCoreManager(
      makeOptions(configDir, recordedPackage, IMAGE, stateRef, calls, RECEIPT, { desiredRunning: false })
    );
    stateRef.current = await initial.initialize();
    const expectedCompose = readFileSync(join(configDir, "base", "docker-compose.yml"));
    writeFileSync(join(configDir, "base", "docker-compose.yml"), "damaged\n");

    const newerPackage = packageDirectory(NEXT_IMAGE, "newer-repair");
    const newer = new ManagedCoreManager(
      makeOptions(configDir, newerPackage, NEXT_IMAGE, stateRef, calls, NEXT_RECEIPT)
    );
    await newer.repairBundle(stateRef.current, {
      packageRoot: recordedPackage,
      packageVersion: "0.1.8",
      packageImage: IMAGE,
      packageContracts: CONTRACTS
    });

    expect(readFileSync(join(configDir, "base", "docker-compose.yml"))).toEqual(expectedCompose);
  });

  it("does not invoke Compose when start storage safety rejects the deployment", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const calls: Call[] = [];
    const initial = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE, "storage-safe"), IMAGE, stateRef, calls, RECEIPT, {
        desiredRunning: false
      })
    );
    stateRef.current = await initial.initialize();
    calls.length = 0;
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageDirectory(IMAGE), IMAGE, stateRef, calls, RECEIPT, {
        assertStorageSafe: async () => {
          throw new Error("durable storage is missing");
        }
      })
    );

    await expect(manager.start(stateRef.current)).rejects.toThrow("durable storage is missing");
    expect(calls).toHaveLength(0);
  });

  it("rejects a quoted mutable image even when its line has a YAML comment", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const packageRoot = packageDirectory(IMAGE, "mutable-image");
    const composePath = join(packageRoot, "assets", "docker-compose.yml");
    writeFileSync(
      composePath,
      readFileSync(composePath, "utf8").replace(`image: ${POSTGRES_IMAGE}`, 'image: "postgres:latest" # mutable')
    );
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageRoot, IMAGE, stateRef, [], RECEIPT, { desiredRunning: false })
    );

    await expect(manager.initialize()).rejects.toThrow(/immutable digest/);
  });

  it("rejects an unapproved Compose image variable", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const packageRoot = packageDirectory(IMAGE, "unapproved-variable");
    const composePath = join(packageRoot, "assets", "docker-compose.yml");
    writeFileSync(
      composePath,
      readFileSync(composePath, "utf8").replace(`image: ${POSTGRES_IMAGE}`, "image: ${ATLAS_CORE_IMAGE_OTHER}")
    );
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageRoot, IMAGE, stateRef, [], RECEIPT, { desiredRunning: false })
    );

    await expect(manager.initialize()).rejects.toThrow(/immutable digest/);
  });

  it("rejects a retained Compose service without restart: no", async () => {
    const configDir = temporaryDirectory();
    writeFileSync(join(configDir, ".env"), "POSTGRES_PASSWORD=secret\n", { mode: 0o600 });
    const packageRoot = packageDirectory(IMAGE, "restart-policy");
    const composePath = join(packageRoot, "assets", "docker-compose.yml");
    writeFileSync(composePath, readFileSync(composePath, "utf8").replace('restart: "no"', "restart: always"));
    const stateRef = { current: undefined as ManagedCoreState | undefined };
    const manager = new ManagedCoreManager(
      makeOptions(configDir, packageRoot, IMAGE, stateRef, [], RECEIPT, { desiredRunning: false })
    );

    await expect(manager.initialize()).rejects.toThrow(/must set restart: no/);
  });
});

describe("parseManagedCoreState", () => {
  it("rejects missing compatibility and image receipts", () => {
    const state = readyState();
    expect(() =>
      parseManagedCoreState({
        ...state,
        pluginContracts: undefined
      })
    ).toThrow(/Plugin contracts/);
    expect(() =>
      parseManagedCoreState({
        ...state,
        baseDeployment: { ...state.baseDeployment!, images: undefined }
      })
    ).toThrow(/image receipts/);
    expect(() =>
      parseManagedCoreState({
        ...state,
        baseDeployment: { ...state.baseDeployment!, coreLocalImageId: "not-a-digest" }
      })
    ).toThrow(/image or bundle receipt/);
  });

  it("sorts enabled Plugin IDs while preserving the state contract", () => {
    const value = parseManagedCoreState({ ...readyState(), enabledPlugins: ["z_plugin", "a_plugin"] });
    expect(value.enabledPlugins).toEqual(["a_plugin", "z_plugin"]);
  });

  it("preserves stored Plugin capability declarations and canonicalizes their arrays", () => {
    const value = parseManagedCoreState({
      ...readyState(),
      pluginContracts: {
        ...CONTRACTS,
        supportedPackageSchemaMajors: [1, 2]
      }
    });
    expect(value.pluginContracts?.supportedPackageSchemaMajors).toEqual([1, 2]);
    expect(value.pluginContracts?.supportedInteractions).toEqual(["map_area"]);
  });

  it("rejects duplicate stored capability declarations", () => {
    expect(() =>
      parseManagedCoreState({
        ...readyState(),
        pluginContracts: {
          ...CONTRACTS,
          supportedPackageSchemaMajors: [1, 1]
        }
      })
    ).toThrow(/supported package schema/);
    expect(() =>
      parseManagedCoreState({
        ...readyState(),
        pluginContracts: {
          ...CONTRACTS,
          supportedPackageSchemaMajors: [2, 1]
        }
      })
    ).toThrow(/supported package schema/);
    expect(() =>
      parseManagedCoreState({
        ...readyState(),
        pluginContracts: {
          coreToPluginProtocolMajors: CONTRACTS.coreToPluginProtocolMajors,
          pluginToSourceGatewayProtocolMajors: CONTRACTS.pluginToSourceGatewayProtocolMajors,
          atlasProtocolRevision: CONTRACTS.atlasProtocolRevision,
          supportedPackageSchemaMajors: [1]
        }
      })
    ).toThrow(/supported Plugin interactions/);
  });

  it("accepts the intentionally incomplete initializing state", () => {
    const state = parseManagedCoreState({
      schema: 4,
      resourceLayout: "engine-scoped-v1",
      phase: "initializing",
      initializedAt: "2026-09-09T12:00:00.000Z",
      packageVersion: "0.1.8",
      dockerEngineId: ENGINE,
      enabledPlugins: []
    });
    expect(state.baseDeployment).toBeUndefined();
    expect(state.pluginContracts).toBeUndefined();
  });
});
