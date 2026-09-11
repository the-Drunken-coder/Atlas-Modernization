import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { PairedBackupIdentity } from "./backup-receipt.js";
import {
  DeploymentTransactionStore,
  type TransactionJournal,
  TransactionRecoveryRequiredError
} from "./deployment-transaction.js";
import type { ImageReceipt } from "./image-receipts.js";
import { pluginServiceName } from "./independent-plugins.js";
import { type PluginContracts, type PluginInteraction } from "./plugin-distribution.js";
import {
  copyRetainedBundle,
  createRetainedBundleManifest,
  type RetainedBundleManifest,
  verifyRetainedBundle
} from "./retained-bundle.js";

const STATE_SCHEMA = 4 as const;
const LEGACY_STATE_SCHEMA = 3 as const;
const RESOURCE_LAYOUT = "engine-scoped-v1" as const;
const COMPOSE_WAIT_SECONDS = "120";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CORE_IMAGE_PLACEHOLDER = /^\$\{ATLAS_CORE_IMAGE(?::\?[^}]*)?\}$/u;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

export type BaseDeployment = {
  bundleSha256: `sha256:${string}`;
  coreImage: string;
  coreLocalImageId: `sha256:${string}`;
  images?: readonly ImageReceipt[];
};

/** The root deployment shape shared by the legacy bundled state and schema 4. */
export type ManagedCoreState = {
  schema: typeof LEGACY_STATE_SCHEMA | typeof STATE_SCHEMA;
  resourceLayout: typeof RESOURCE_LAYOUT;
  phase: "initializing" | "ready";
  initializedAt: string;
  packageVersion: string;
  dockerEngineId: string;
  enabledPlugins: string[];
  startAttemptedAt?: string;
  startedAt?: string;
  baseDeployment?: BaseDeployment;
  pluginContracts?: PluginContracts;
};

export type ManagedCorePackage = {
  packageRoot: string;
  packageVersion: string;
  packageImage: string;
  packageContracts: PluginContracts;
  /** Optional explicit list for package tests and future package layouts. */
  bundleFiles?: readonly string[];
  /** Base image receipts can be supplied by a release metadata generator. */
  images?: readonly ImageReceipt[];
};

export type ComposeResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type ComposeOptions = {
  baseDirectory: string;
  coreImage: string;
  cleanup?: boolean;
};

export type ManagedCoreStateReader = () => ManagedCoreState | undefined;
export type ManagedCoreStateWriter = (state: ManagedCoreState) => void | Promise<void>;
export type ComposeRunner = (
  args: readonly string[],
  pluginIds: readonly string[],
  options: ComposeOptions
) => Promise<ComposeResult>;

export type ManagedCoreImageVerifier = (receipt: ImageReceipt) => void | Promise<void>;
export type ManagedCoreContainerImageVerifier = (service: string, receipt: ImageReceipt) => void | Promise<void>;

/**
 * Inputs for reading a restored migration ledger. Recovery supplies the
 * prior state and a disposable copy of its retained bundle so the adapter
 * cannot accidentally inspect the still-live target composition.
 */
export type MigrationLedgerOptions = {
  state: ManagedCoreState;
  baseDirectory: string;
  postgresReceipt: ImageReceipt;
};

export type StorageSafetyResult = {
  createPostgresVolume?: boolean;
};

export type PluginVerificationOptions = {
  requireHealth: boolean;
};

export type ManagedCoreOptions = ManagedCorePackage & {
  configDir: string;
  dockerEngineId: string;
  architecture: NodeJS.Architecture | "amd64";
  readState: ManagedCoreStateReader;
  writeState: ManagedCoreStateWriter;
  runCompose: ComposeRunner;
  pullImage: (image: string) => Promise<ImageReceipt>;
  verifyLocalImage: ManagedCoreImageVerifier;
  verifyContainerImage: ManagedCoreContainerImageVerifier;
  assertStorageSafe: (state: ManagedCoreState | undefined) => Promise<StorageSafetyResult | void>;
  regeneratePlugins: (state: ManagedCoreState) => void | Promise<void>;
  verifyPlugins: (state: ManagedCoreState, options: PluginVerificationOptions) => void | Promise<void>;
  preflightPlugins: (contracts: PluginContracts) => void | Promise<void>;
  ensureCredential: (transaction: DeploymentTransactionStore) => void | Promise<void>;
  readMigrationLedger?: (options?: MigrationLedgerOptions) => Promise<string>;
  readBackupIdentity?: () => Promise<PairedBackupIdentity>;
  readRunIntent?: () => boolean | undefined;
  previousRunning?: boolean;
  desiredRunning?: boolean;
  previousCoreImage?: string;
  now?: () => Date;
};

export type CoreTarget = ManagedCorePackage & {
  previousRunning?: boolean;
  desiredRunning?: boolean;
};

export type RecoveryAction = "status" | "retry" | "forward" | "restored";

export type RecoveryStatus = {
  pending: boolean;
  journal?: TransactionJournal;
  action?: string;
};

export type RecoveryOptions = {
  target?: CoreTarget;
  confirmPairedRestore?: boolean;
};

type Candidate = {
  root: string;
  manifest: RetainedBundleManifest;
  files: readonly string[];
};

/**
 * Owns the parts of a Core mutation that must remain recoverable across a
 * process crash. Docker locks and run intent remain with the application
 * coordinator; this class only accepts their already-authorized adapters.
 */
export class ManagedCoreManager {
  readonly #options: ManagedCoreOptions;
  readonly #configDir: string;
  readonly #baseDir: string;
  readonly #statePath: string;
  readonly #envPath: string;

  constructor(options: ManagedCoreOptions) {
    this.#options = normalizeOptions(options);
    this.#configDir = normalizeAbsolute(options.configDir, "configuration directory");
    this.#baseDir = join(this.#configDir, "base");
    this.#statePath = join(this.#configDir, "state.json");
    this.#envPath = join(this.#configDir, ".env");
  }

  get baseDirectory(): string {
    return this.#baseDir;
  }

  /** Complete a fresh schema-4 initialization, leaving the requested run state. */
  async initialize(previousState = this.#options.readState()): Promise<ManagedCoreState> {
    if (previousState?.phase === "ready" && previousState.schema === STATE_SCHEMA && previousState.baseDeployment) {
      return previousState;
    }
    const target = this.#targetFromOptions();
    const transaction = DeploymentTransactionStore.begin(this.#configDir, {
      operation: "init",
      dockerEngineId: this.#options.dockerEngineId,
      previousRunning: this.#options.previousRunning ?? false,
      desiredRunning: this.#options.desiredRunning ?? false,
      now: this.#now()
    });
    transaction.advance("prepared", {
      targetPackageVersion: target.packageVersion,
      targetCoreImage: target.packageImage
    });
    try {
      return await this.#runTransaction(transaction, previousState, target, "init");
    } catch (error) {
      const journal = transaction.read();
      // A fresh initialization may have created PostgreSQL storage before Core
      // was invoked. Keep that provenance and the transaction candidate so a
      // later recovery retry can finish the exact operation safely.
      if (journal.phase === "prepared" || journal.phase === "runtime-changing") throw error;
      await this.#handleFailure(
        transaction,
        error,
        journal.phase === "core-started" || journal.phase === "credentials-durable"
      );
      throw error;
    }
  }

  /** Finish an interrupted schema-4 initialization using its retained candidate. */
  async finishInitialization(state = this.#options.readState()): Promise<ManagedCoreState> {
    if (!state || state.schema !== STATE_SCHEMA || state.phase !== "initializing") {
      throw new Error("Atlas Core has no schema-4 initialization to finish.");
    }
    if (DeploymentTransactionStore.exists(this.#configDir)) {
      const result = await this.recover("retry");
      if (!result || !("schema" in result)) throw new Error("Atlas Core initialization recovery did not commit state.");
      return result;
    }
    return await this.initialize(state);
  }

  /** Update Core and its retained base bundle as one storage-aware transaction. */
  async update(state = this.#options.readState(), target = this.#targetFromOptions()): Promise<ManagedCoreState> {
    if (!state) throw new Error("Atlas Core is not initialized.");
    if (state.phase !== "ready") throw new Error("Atlas Core is already in an unfinished initialization.");
    if (state.schema === LEGACY_STATE_SCHEMA && state.enabledPlugins.length > 0) {
      throw new Error(
        "The first independent-release Core update cannot migrate enabled bundled Plugins. Disable them with the matching v1 CLI first."
      );
    }
    const priorBackupIdentity = await this.#readBackupIdentity();
    await this.#options.preflightPlugins?.(target.packageContracts);
    if ((this.#options.previousRunning ?? true) && state.enabledPlugins.length > 0) {
      await this.#options.verifyPlugins?.(state, { requireHealth: true });
    }
    const transaction = DeploymentTransactionStore.begin(this.#configDir, {
      operation: "core-update",
      dockerEngineId: this.#options.dockerEngineId,
      previousRunning: this.#options.previousRunning ?? true,
      desiredRunning: this.#options.desiredRunning ?? true,
      now: this.#now()
    });
    try {
      transaction.advance("prepared", {
        fromPackageVersion: state.packageVersion,
        targetPackageVersion: target.packageVersion,
        targetCoreImage: target.packageImage,
        priorBackupIdentity
      });
      return await this.#runTransaction(transaction, state, target, "core-update");
    } catch (error) {
      const phase = transaction.read().phase;
      const targetStarted = phase === "core-started" || phase === "credentials-durable";
      await this.#handleFailure(transaction, error, targetStarted);
      throw error;
    }
  }

  /** Start an already committed deployment using its retained image and bundle. */
  async start(state = this.#options.readState()): Promise<void> {
    if (!state || state.schema !== STATE_SCHEMA || state.phase !== "ready" || !state.baseDeployment) {
      throw new Error("Atlas Core has no committed schema-4 deployment to start.");
    }
    const base = state.baseDeployment;
    this.#verifyBundleHash(base.bundleSha256);
    await this.#verifyLocalCoreImage(base);
    await this.#options.preflightPlugins?.(state.pluginContracts ?? this.#options.packageContracts);
    await this.#options.regeneratePlugins?.(state);
    // Plugin files must be materialized before the application-level storage
    // guard, because the guard may validate the active Compose topology.
    // Nothing has been started yet, so a rejected storage check remains safe.
    await this.#options.assertStorageSafe?.(state);
    try {
      const result = await this.#options.runCompose(
        [
          "up",
          "-d",
          "--pull",
          "never",
          "--remove-orphans",
          "--wait",
          "--wait-timeout",
          COMPOSE_WAIT_SECONDS,
          "api",
          "source-gateway",
          "postgres",
          "minio"
        ],
        state.enabledPlugins,
        { baseDirectory: this.#baseDir, coreImage: base.coreImage }
      );
      assertComposeSuccess("start Atlas Core", result);
      await this.#startPluginServices(state);
      await this.#verifyRunningCore(receiptFromBase(base), base.images);
      await this.#options.verifyPlugins?.(state, { requireHealth: false });
    } catch (error) {
      await this.#stopAfterFailure(state.enabledPlugins, base.coreImage);
      throw error;
    }
  }

  /** Repair the retained base from the exact package currently supplied by the caller. */
  async repairBundle(state = this.#options.readState(), target: CoreTarget = this.#targetFromOptions()): Promise<void> {
    if (!state || state.schema !== STATE_SCHEMA || !state.baseDeployment) {
      throw new Error("Atlas Core has no committed schema-4 bundle to repair.");
    }
    const transaction = DeploymentTransactionStore.begin(this.#configDir, {
      operation: "repair",
      dockerEngineId: this.#options.dockerEngineId,
      previousRunning: false,
      desiredRunning: false,
      now: this.#now()
    });
    try {
      const candidate = this.#createCandidate(target, transaction.id);
      try {
        if (candidate.manifest.bundleSha256 !== state.baseDeployment.bundleSha256) {
          throw new Error(
            `Atlas Core package ${target.packageVersion} does not contain the recorded bundle ${state.baseDeployment.bundleSha256}.`
          );
        }
        await this.#stageCandidate(transaction, candidate);
      } finally {
        if (existsSync(candidate.root)) rmSync(candidate.root, { recursive: true, force: true });
      }
      await this.#applyStagedCandidate(transaction);
      verifyRetainedBundle(this.#baseDir, candidate.manifest);
      assertComposeRestartPolicy(this.#baseDir);
      transaction.markCommitted();
      transaction.cleanup();
    } catch (error) {
      await this.#handleFailure(transaction, error, false);
      throw error;
    }
  }

  async recover(action: "status"): Promise<RecoveryStatus>;
  async recover(
    action: "retry" | "forward" | "restored",
    options?: RecoveryOptions
  ): Promise<ManagedCoreState | RecoveryStatus>;
  async recover(action: RecoveryAction, options: RecoveryOptions = {}): Promise<ManagedCoreState | RecoveryStatus> {
    if (!DeploymentTransactionStore.exists(this.#configDir)) {
      if (action === "status") return { pending: false };
      throw new Error("Atlas Core has no pending deployment transaction.");
    }
    const transaction = DeploymentTransactionStore.open(this.#configDir);
    const journal = transaction.read();
    if (action === "status") {
      return {
        pending: true,
        journal,
        action: recoveryActionForPhase(journal.phase)
      };
    }
    if (journal.phase === "committed") {
      transaction.cleanup();
      const state = this.#options.readState();
      if (!state) throw new Error("Committed Atlas Core recovery has no state.json.");
      return state;
    }
    if (journal.phase === "rollback-complete") {
      if (journal.operation === "core-update" || journal.operation === "init") {
        return await this.#finishRollback(transaction, true);
      }
      transaction.cleanup();
      const state = this.#options.readState();
      if (!state) throw new Error("Completed Core rollback has no state.json.");
      return state;
    }
    let targetStopped = false;
    if (action === "forward") {
      if (journal.phase !== "core-started" && journal.phase !== "credentials-durable") {
        throw new Error("Core forward recovery is available only after the target Core has started.");
      }
      const target = options.target ?? this.#targetFromOptions();
      const currentState = parseStateBuffer(transaction.readStaged("state.json"));
      await this.#stopAfterFailure(
        currentState?.enabledPlugins ?? [],
        journal.recovery?.targetCoreImage ?? currentState?.baseDeployment?.coreImage ?? this.#options.packageImage
      );
      targetStopped = true;
      await this.#replaceTransactionCandidate(transaction, target);
    }
    if (action === "restored") return await this.#recoverRestored(transaction, options);
    if (
      action === "retry" &&
      journal.operation === "init" &&
      (journal.phase === "prepared" || journal.phase === "runtime-changing")
    ) {
      assertInitRecoveryTarget(journal, this.#targetFromOptions());
      const priorState = this.#readBeforeState(transaction);
      const currentState = this.#options.readState();
      try {
        return await this.#runTransaction(transaction, priorState ?? currentState, this.#targetFromOptions(), "init");
      } catch (error) {
        const current = transaction.read();
        if (current.phase === "core-started" || current.phase === "credentials-durable") {
          await this.#handleFailure(transaction, error, true);
        }
        throw error;
      }
    }
    if (journal.phase === "prepared" || journal.phase === "runtime-changing") {
      await this.#recoverBeforeTargetStarted(transaction);
      const state = this.#options.readState();
      if (!state) throw new Error("Atlas Core recovery removed the deployment state unexpectedly.");
      return state;
    }
    return await this.#retryStartedTarget(transaction, targetStopped);
  }

  /**
   * Stop a target composition left running by a failed started-phase mutation.
   * This preserves the transaction for the operator's explicit recovery choice.
   */
  async stopPendingTarget(): Promise<void> {
    if (!DeploymentTransactionStore.exists(this.#configDir)) {
      throw new Error("Atlas Core has no pending deployment transaction.");
    }
    const transaction = DeploymentTransactionStore.open(this.#configDir);
    const journal = transaction.read();
    if (journal.owner.dockerEngineId !== this.#options.dockerEngineId) {
      throw new Error("Pending transaction belongs to another Docker engine.");
    }
    if (journal.operation !== "core-update" && journal.operation !== "init") {
      throw new Error("Pending transaction is not a Core mutation.");
    }
    if (journal.phase !== "core-started" && journal.phase !== "credentials-durable") {
      throw new Error("Pending Core target can only be stopped after the target Core has started.");
    }
    const stagedState = parseStateBuffer(transaction.readStaged("state.json"));
    if (!stagedState || stagedState.schema !== STATE_SCHEMA || !stagedState.baseDeployment) {
      throw new Error("Pending Core transaction has no valid staged target state.");
    }
    const stagedImage = stagedState.baseDeployment.coreImage;
    const recordedImage = journal.recovery?.targetCoreImage;
    if (recordedImage && recordedImage !== stagedImage) {
      throw new Error("Pending Core transaction target image does not match its staged state.");
    }
    await this.#stopAfterFailure(stagedState.enabledPlugins, recordedImage ?? stagedImage);
  }

  async #runTransaction(
    transaction: DeploymentTransactionStore,
    previousState: ManagedCoreState | undefined,
    target: CoreTarget,
    operation: "init" | "core-update"
  ): Promise<ManagedCoreState> {
    const previousRunning = transaction.journal.previousRunning;
    const desiredRunning = transaction.journal.desiredRunning;
    const candidate = this.#createCandidate(target, transaction.id);
    try {
      const targetImages = await this.#pullTargetImages(target, candidate);
      const targetImage = targetImages.find((receipt) => receipt.image_index === target.packageImage);
      if (!targetImage) throw new Error("Core image receipt was not returned for the target package image.");
      await this.#options.assertStorageSafe?.(previousState);
      await this.#options.preflightPlugins?.(target.packageContracts);
      await this.#snapshotMutationFiles(transaction, candidate);
      await this.#stageCandidate(transaction, candidate);
      const initialisingState = this.#createTargetState(
        previousState,
        target,
        candidate.manifest,
        targetImage,
        targetImages,
        "initializing"
      );
      transaction.stage("state.json", encodeState(initialisingState));
      transaction.applyStaged("state.json");
      transaction.advance("runtime-changing", {
        targetPackageVersion: target.packageVersion,
        targetCoreImage: target.packageImage
      });
      if (operation === "core-update" && transaction.read().recovery?.priorMigrationLedger === undefined) {
        const priorMigrationLedger = (await this.#priorLedger(true)).priorMigrationLedger;
        if (priorMigrationLedger) transaction.advance("runtime-changing", { priorMigrationLedger });
      }

      if (previousRunning) {
        const oldPluginIds = previousState?.enabledPlugins ?? [];
        const previousImage = previousState?.baseDeployment?.coreImage ?? this.#options.previousCoreImage;
        const result = await this.#options.runCompose(["down", "--remove-orphans"], oldPluginIds, {
          baseDirectory: this.#baseDir,
          coreImage: previousImage ?? target.packageImage
        });
        assertComposeSuccess("stop Atlas Core for update", result);
      }

      await this.#applyStagedCandidate(transaction);
      await this.#options.regeneratePlugins?.(initialisingState);
      await this.#verifyLocalReceipt(targetImage);
      transaction.advance("core-started");
      await this.#startComposition(
        initialisingState,
        target.packageImage,
        `start Atlas Core ${target.packageVersion}`,
        true
      );
      await this.#verifyRunningCore(targetImage, initialisingState.baseDeployment?.images);
      if (this.#options.ensureCredential) await this.#options.ensureCredential(transaction);
      transaction.advance("credentials-durable");
      await this.#options.verifyPlugins?.(initialisingState, { requireHealth: true });
      if (!desiredRunning) {
        const stop = await this.#options.runCompose(["down", "--remove-orphans"], initialisingState.enabledPlugins, {
          baseDirectory: this.#baseDir,
          coreImage: target.packageImage
        });
        assertComposeSuccess("stop temporary Atlas Core", stop);
      }
      const readyState = this.#createTargetState(
        previousState,
        target,
        candidate.manifest,
        targetImage,
        targetImages,
        "ready"
      );
      transaction.stage("state.json", encodeState(readyState));
      transaction.applyStaged("state.json");
      transaction.markCommitted();
      transaction.cleanup();
      return readyState;
    } finally {
      if (existsSync(candidate.root)) rmSync(candidate.root, { recursive: true, force: true });
    }
  }

  async #retryStartedTarget(transaction: DeploymentTransactionStore, targetStopped = false): Promise<ManagedCoreState> {
    const stagedState = parseStateBuffer(transaction.readStaged("state.json"));
    if (!stagedState || stagedState.schema !== STATE_SCHEMA || !stagedState.baseDeployment) {
      throw new Error("Pending Core transaction has no valid staged schema-4 state.");
    }
    const journal = transaction.read();
    const targetImage = receiptFromState(stagedState);
    if (!targetStopped) await this.#stopAfterFailure(stagedState.enabledPlugins, stagedState.baseDeployment.coreImage);
    await this.#applyStagedCandidate(transaction);
    verifyRetainedBundle(this.#baseDir, manifestFromTransaction(transaction));
    assertComposeRestartPolicy(this.#baseDir);
    await this.#options.regeneratePlugins?.(stagedState);
    await this.#verifyLocalReceipt(targetImage);
    try {
      await this.#startComposition(
        stagedState,
        stagedState.baseDeployment.coreImage,
        `retry Atlas Core ${stagedState.packageVersion}`,
        true
      );
      await this.#verifyRunningCore(targetImage, stagedState.baseDeployment.images);
      if (
        (journal.phase === "core-started" || journal.phase === "credentials-durable") &&
        this.#options.ensureCredential
      )
        await this.#options.ensureCredential(transaction);
      if (transaction.read().phase === "core-started") transaction.advance("credentials-durable");
      await this.#options.verifyPlugins?.(stagedState, { requireHealth: true });
      const desiredRunning = this.#desiredRunning(transaction.read());
      if (!desiredRunning) {
        const stop = await this.#options.runCompose(["down", "--remove-orphans"], stagedState.enabledPlugins, {
          baseDirectory: this.#baseDir,
          coreImage: stagedState.baseDeployment.coreImage
        });
        assertComposeSuccess("stop recovered Atlas Core", stop);
      }
      const ready = { ...stagedState, phase: "ready" as const };
      transaction.stage("state.json", encodeState(ready));
      transaction.applyStaged("state.json");
      transaction.markCommitted();
      transaction.cleanup();
      return ready;
    } catch (error) {
      await this.#stopAfterFailure(stagedState.enabledPlugins, stagedState.baseDeployment.coreImage);
      throw error;
    }
  }

  async #recoverBeforeTargetStarted(transaction: DeploymentTransactionStore): Promise<void> {
    const journal = transaction.read();
    if (journal.phase !== "prepared" && journal.phase !== "runtime-changing") return;
    const priorState = this.#readBeforeState(transaction);
    if (journal.phase === "runtime-changing") {
      let stagedState: ManagedCoreState | undefined;
      try {
        stagedState = parseStateBuffer(transaction.readStaged("state.json"));
      } catch {
        // The prior state and journal still provide enough information to stop the old composition.
      }
      await this.#stopAfterFailure(
        stagedState?.enabledPlugins ?? priorState?.enabledPlugins ?? [],
        journal.recovery?.targetCoreImage ??
          stagedState?.baseDeployment?.coreImage ??
          priorState?.baseDeployment?.coreImage ??
          this.#options.previousCoreImage
      );
    }
    transaction.rollback();
    await this.#finishRollback(transaction);
  }

  async #recoverRestored(transaction: DeploymentTransactionStore, options: RecoveryOptions): Promise<ManagedCoreState> {
    if (!options.confirmPairedRestore) {
      throw new Error("Paired PostgreSQL and MinIO restore must be explicitly confirmed before restoring Core.");
    }
    const journal = transaction.read();
    if (journal.phase !== "core-started" && journal.phase !== "credentials-durable") {
      throw new Error("Paired restore recovery is available only after the target Core has started.");
    }
    const stagedState = parseStateBuffer(transaction.readStaged("state.json"));
    await this.#stopAfterFailure(
      stagedState?.enabledPlugins ?? [],
      journal.recovery?.targetCoreImage ?? this.#options.packageImage
    );
    if (!journal.recovery?.priorMigrationLedger || !this.#options.readMigrationLedger) {
      throw new Error("Pending Core recovery has no prior migration ledger to compare with the paired restore.");
    }
    const recordedBackupIdentity = journal.recovery.priorBackupIdentity;
    if (!recordedBackupIdentity) {
      throw new Error("Pending Core recovery has no prior paired backup identity to compare with the restored backup.");
    }
    const restoredBackupIdentity = await this.#readBackupIdentity();
    if (restoredBackupIdentity !== recordedBackupIdentity) {
      throw new Error("The restored paired backup identity does not match the pre-update backup.");
    }
    const priorState = this.#readBeforeState(transaction);
    if (!priorState) throw new Error("Pending Core recovery has no prior state to restore.");
    const priorBaseDirectory = this.#materializePriorBase(transaction, priorState);
    try {
      const postgresImage = imageForService("postgres", priorBaseDirectory);
      const postgresReceipt = priorState.baseDeployment?.images?.find(
        (receipt) => receipt.image_index === postgresImage
      );
      if (!postgresImage || !postgresReceipt) {
        throw new Error("Pending Core recovery has no retained PostgreSQL image receipt.");
      }
      await this.#verifyLocalReceipt(postgresReceipt);
      const currentLedger = await this.#options.readMigrationLedger({
        state: priorState,
        baseDirectory: priorBaseDirectory,
        postgresReceipt
      });
      if (currentLedger !== journal.recovery.priorMigrationLedger) {
        throw new Error("The restored PostgreSQL migration ledger does not match the pre-update ledger.");
      }
      transaction.restoreAfterPairedBackup();
      return await this.#finishRollback(transaction);
    } finally {
      rmSync(priorBaseDirectory, { recursive: true, force: true });
    }
  }

  #materializePriorBase(transaction: DeploymentTransactionStore, priorState: ManagedCoreState): string {
    const priorBase = priorState.baseDeployment;
    if (!priorBase) throw new Error("Pending Core recovery has no retained prior Core bundle.");
    const source = join(this.#configDir, "transaction", "before", "base");
    if (!existsSync(source)) throw new Error("Pending Core recovery is missing its prior retained Core bundle.");
    const sourceManifest = createRetainedBundleManifest(source);
    if (sourceManifest.bundleSha256 !== priorBase.bundleSha256) {
      throw new Error("Pending Core prior retained bundle failed its state hash check.");
    }
    const target = join(this.#configDir, `.prior-base-${transaction.id}-${randomUUID()}`);
    try {
      const manifest = copyRetainedBundle({
        sourceRoot: source,
        targetRoot: target,
        files: sourceManifest.files.map((file) => file.path),
        requiredFiles: [
          "docker-compose.yml",
          "docker-compose.init.yml",
          "source_gateway.production.json",
          "plugin-templates/service.json",
          "plugin-templates/core-endpoint.json",
          "plugin-templates/source-connector.json"
        ],
        composeFiles: ["docker-compose.yml", "docker-compose.init.yml"]
      });
      if (manifest.bundleSha256 !== priorBase.bundleSha256) {
        throw new Error("Pending Core prior retained bundle failed its copy hash check.");
      }
      assertComposeRestartPolicy(target);
      return target;
    } catch (error) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Complete a file rollback only after the restored Core has passed its
   * runtime checks. Keeping the journal through those checks lets recovery
   * retry after a failed prior-Core startup instead of treating the file
   * rollback as the whole operation.
   */
  async #finishRollback(transaction: DeploymentTransactionStore, retrying = false): Promise<ManagedCoreState> {
    const priorState = this.#readBeforeState(transaction);
    if (!priorState) {
      transaction.cleanup();
      const state = this.#options.readState();
      if (!state) throw new Error("Completed Core rollback has no state.json.");
      return state;
    }
    const oldImage = priorState.baseDeployment?.coreImage ?? this.#options.previousCoreImage;
    if (!oldImage) throw new Error("Pending Core recovery has no retained prior Core image.");
    if (retrying) await this.#stopAfterFailure(priorState.enabledPlugins, oldImage);
    const priorBase = await this.#verifyCommittedState(priorState);
    if (this.#desiredRunning(transaction.read())) {
      await this.#startComposition(priorState, oldImage, "restore the prior Atlas Core", true);
      await this.#verifyRunningCore(receiptFromBase(priorBase), priorBase.images);
      await this.#options.verifyPlugins?.(priorState, { requireHealth: true });
    }
    transaction.cleanup();
    return priorState;
  }

  async #replaceTransactionCandidate(transaction: DeploymentTransactionStore, target: CoreTarget): Promise<void> {
    const candidate = this.#createCandidate(target, transaction.id);
    try {
      const targetImages = await this.#pullTargetImages(target, candidate);
      const receipt = targetImages.find((candidateReceipt) => candidateReceipt.image_index === target.packageImage);
      if (!receipt) throw new Error("Core image receipt was not returned for the target package image.");
      await this.#options.preflightPlugins?.(target.packageContracts);
      await this.#snapshotMutationFiles(transaction, candidate);
      await this.#stageCandidate(transaction, candidate, true);
      const priorState = this.#readBeforeState(transaction);
      const staged = this.#createTargetState(
        priorState,
        target,
        candidate.manifest,
        receipt,
        targetImages,
        "initializing"
      );
      transaction.stage("state.json", encodeState(staged));
      transaction.applyStaged("state.json");
      transaction.advance(transaction.read().phase, {
        targetPackageVersion: target.packageVersion,
        targetCoreImage: target.packageImage
      });
    } finally {
      if (existsSync(candidate.root)) rmSync(candidate.root, { recursive: true, force: true });
    }
  }

  async #snapshotMutationFiles(transaction: DeploymentTransactionStore, candidate: Candidate): Promise<void> {
    transaction.snapshot("state.json");
    transaction.snapshot(".env");
    transaction.snapshotTree("base");
    for (const path of candidate.files) transaction.snapshot(`base/${path}`);
  }

  async #stageCandidate(
    transaction: DeploymentTransactionStore,
    candidate: Candidate,
    replaceStagedSubtree = false
  ): Promise<void> {
    try {
      for (const path of candidate.files) {
        const absolute = join(candidate.root, path);
        const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stats = fstatSync(descriptor);
          if (!stats.isFile()) throw new Error(`Core bundle candidate ${path} must be a regular file.`);
          transaction.stage(`base/${path}`, readFileSync(descriptor), { mode: stats.mode & 0o777 });
        } finally {
          closeSync(descriptor);
        }
      }
      if (replaceStagedSubtree) {
        transaction.removeStagedSubtreeEntriesNotIn("base", candidate.files);
      }
    } finally {
      rmSync(candidate.root, { recursive: true, force: true });
    }
  }

  async #applyStagedCandidate(transaction: DeploymentTransactionStore): Promise<void> {
    const staged = transaction.read().staged;
    const candidatePaths = Object.keys(staged)
      .filter((path) => path.startsWith(`base${sep}`) || path.startsWith("base/"))
      .map((path) => path.slice("base/".length))
      .sort();
    if (candidatePaths.length === 0) throw new Error("Pending Core transaction has no staged retained bundle.");
    const currentPaths = existsSync(this.#baseDir) ? listRegularFiles(this.#baseDir) : [];
    for (const path of candidatePaths) transaction.applyStaged(`base/${path}`);
    for (const path of currentPaths) {
      if (!candidatePaths.includes(path)) transaction.remove(`base/${path}`);
    }
  }

  #createCandidate(target: CoreTarget, transactionId: string): Candidate {
    const sourceRoot = join(normalizeAbsolute(target.packageRoot, "Core package root"), "assets");
    const files = target.bundleFiles ? [...target.bundleFiles] : discoverBundleFiles(sourceRoot);
    const root = join(this.#configDir, `.base-candidate-${transactionId}-${randomUUID()}`);
    const manifest = copyRetainedBundle({
      sourceRoot,
      targetRoot: root,
      files,
      requiredFiles: [
        "docker-compose.yml",
        "docker-compose.init.yml",
        "source_gateway.production.json",
        "plugin-templates/service.json",
        "plugin-templates/core-endpoint.json",
        "plugin-templates/source-connector.json"
      ],
      composeFiles: ["docker-compose.yml", "docker-compose.init.yml"]
    });
    try {
      assertComposeRestartPolicy(root);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    return { root, manifest, files: manifest.files.map((file) => file.path) };
  }

  #createTargetState(
    previous: ManagedCoreState | undefined,
    target: CoreTarget,
    manifest: RetainedBundleManifest,
    receipt: ImageReceipt,
    images: readonly ImageReceipt[],
    phase: "initializing" | "ready"
  ): ManagedCoreState {
    return {
      schema: STATE_SCHEMA,
      resourceLayout: RESOURCE_LAYOUT,
      phase,
      initializedAt: previous?.initializedAt ?? this.#now().toISOString(),
      packageVersion: target.packageVersion,
      dockerEngineId: this.#options.dockerEngineId,
      enabledPlugins: [...(previous?.enabledPlugins ?? [])].sort(),
      ...(phase === "initializing"
        ? { startAttemptedAt: this.#now().toISOString() }
        : {
            startAttemptedAt: previous?.startAttemptedAt ?? this.#now().toISOString(),
            startedAt: this.#now().toISOString()
          }),
      baseDeployment: {
        bundleSha256: manifest.bundleSha256,
        coreImage: target.packageImage,
        coreLocalImageId: receipt.local_image_id as `sha256:${string}`,
        images
      },
      pluginContracts: target.packageContracts
    };
  }

  async #pullTargetImages(target: CoreTarget, candidate: Candidate): Promise<ImageReceipt[]> {
    const images = new Set<string>([
      target.packageImage,
      ...(target.images?.map((receipt) => receipt.image_index) ?? [])
    ]);
    for (const path of candidate.files) {
      if (!path.endsWith(".yml") && !path.endsWith(".yaml")) continue;
      const contents = readFileSync(join(candidate.root, path), "utf8");
      for (const line of contents.split(/\r?\n/u)) {
        const match = /^\s*image:\s*(.*?)\s*$/u.exec(line);
        if (!match) continue;
        const image = parseComposeImageScalar(match[1] ?? "");
        if (image) images.add(image);
      }
    }
    const receipts: ImageReceipt[] = [];
    for (const image of [...images].sort()) {
      const receipt = await this.#options.pullImage(image);
      if (receipt.image_index !== image) {
        throw new Error(`Docker returned a receipt for ${receipt.image_index}, not requested image ${image}.`);
      }
      await this.#verifyLocalReceipt(receipt);
      receipts.push(receipt);
    }
    return receipts;
  }

  async #verifyLocalCoreImage(base: BaseDeployment): Promise<void> {
    for (const receipt of base.images ?? [receiptFromBase(base)]) await this.#verifyLocalReceipt(receipt);
  }

  async #verifyLocalReceipt(receipt: ImageReceipt): Promise<void> {
    if (!this.#options.verifyLocalImage) return;
    await this.#options.verifyLocalImage(receipt);
  }

  async #verifyRunningCore(receipt: ImageReceipt, images?: readonly ImageReceipt[]): Promise<void> {
    if (!this.#options.verifyContainerImage) return;
    await this.#options.verifyContainerImage("api", receipt);
    await this.#options.verifyContainerImage("source-gateway", receipt);
    for (const candidate of images ?? []) {
      if (candidate.image_index === receipt.image_index) continue;
      const service = serviceForImage(candidate.image_index, this.#baseDir);
      if (service) await this.#options.verifyContainerImage(service, candidate);
    }
  }

  async #startComposition(
    state: ManagedCoreState,
    coreImage: string,
    operation: string,
    waitForPluginHealth = false
  ): Promise<void> {
    const base = await this.#options.runCompose(
      [
        "up",
        "-d",
        "--pull",
        "never",
        "--remove-orphans",
        "--wait",
        "--wait-timeout",
        COMPOSE_WAIT_SECONDS,
        "api",
        "source-gateway",
        "postgres",
        "minio"
      ],
      state.enabledPlugins,
      { baseDirectory: this.#baseDir, coreImage }
    );
    assertComposeSuccess(operation, base);
    await this.#startPluginServices(state, waitForPluginHealth);
  }

  async #startVerifiedComposition(state: ManagedCoreState, coreImage: string, operation: string): Promise<void> {
    const base = await this.#verifyCommittedState(state);
    await this.#startComposition(state, coreImage, operation, true);
    await this.#verifyRunningCore(receiptFromBase(base), base.images);
    await this.#options.verifyPlugins?.(state, { requireHealth: true });
  }

  async #verifyCommittedState(state: ManagedCoreState): Promise<BaseDeployment> {
    if (!state.baseDeployment) throw new Error("Core state has no retained base deployment.");
    this.#verifyBundleHash(state.baseDeployment.bundleSha256);
    await this.#verifyLocalCoreImage(state.baseDeployment);
    await this.#options.preflightPlugins?.(state.pluginContracts ?? this.#options.packageContracts);
    if (state.enabledPlugins.length > 0) await this.#options.regeneratePlugins?.(state);
    return state.baseDeployment;
  }

  async #startPluginServices(state: ManagedCoreState, waitForHealth = false): Promise<void> {
    if (state.enabledPlugins.length === 0) return;
    const args = ["up", "-d", "--pull", "never", "--no-deps"];
    if (waitForHealth) args.push("--wait", "--wait-timeout", COMPOSE_WAIT_SECONDS);
    args.push(...state.enabledPlugins.map(pluginServiceName));
    const plugins = await this.#options.runCompose(args, state.enabledPlugins, {
      baseDirectory: this.#baseDir,
      coreImage: state.baseDeployment?.coreImage ?? this.#options.packageImage
    });
    assertComposeSuccess("start enabled Atlas Plugins", plugins);
  }

  #verifyBundleHash(expected: string): void {
    if (!existsSync(this.#baseDir))
      throw new Error("Atlas Core retained base is missing. Run atlas-core start --repair-bundle.");
    try {
      verifyRetainedBundle(this.#baseDir, {
        schema: 1,
        files: createRetainedBundleManifest(this.#baseDir).files,
        bundleSha256: expected as `sha256:${string}`
      });
      assertComposeRestartPolicy(this.#baseDir);
    } catch (error) {
      throw new Error(
        `Retained Atlas Core bundle is invalid. Run atlas-core start --repair-bundle. ${errorMessage(error)}`
      );
    }
  }

  async #handleFailure(transaction: DeploymentTransactionStore, error: unknown, targetStarted: boolean): Promise<void> {
    try {
      if (targetStarted) {
        const journal = transaction.read();
        let pluginIds: readonly string[] = [];
        try {
          const stagedState = parseStateBuffer(transaction.readStaged("state.json"));
          pluginIds = stagedState?.enabledPlugins ?? [];
        } catch {
          // The journal still protects the transaction when the staged state is unavailable.
        }
        await this.#stopAfterFailure(pluginIds, journal.recovery?.targetCoreImage ?? this.#options.packageImage);
        return;
      }
      if (transaction.read().phase === "runtime-changing") {
        await this.#recoverBeforeTargetStarted(transaction);
        return;
      }
      transaction.rollback();
      transaction.cleanup();
    } catch (recoveryError) {
      if (recoveryError instanceof TransactionRecoveryRequiredError) return;
      throw new Error(`${errorMessage(error)} Recovery also failed: ${errorMessage(recoveryError)}`);
    }
  }

  async #stopAfterFailure(pluginIds: readonly string[], coreImage: string | undefined): Promise<void> {
    const result = await this.#options.runCompose(["down", "--remove-orphans"], pluginIds, {
      baseDirectory: this.#baseDir,
      coreImage: coreImage ?? this.#options.packageImage,
      cleanup: true
    });
    if (result.status !== 0)
      throw new Error(`Could not stop Atlas Core after a failed mutation: ${result.stderr.trim() || "unknown error"}`);
  }

  #desiredRunning(journal: TransactionJournal): boolean {
    return this.#options.readRunIntent?.() ?? journal.desiredRunning;
  }

  #readBeforeState(transaction: DeploymentTransactionStore): ManagedCoreState | undefined {
    const journal = transaction.read();
    const snapshot = journal.snapshots["state.json"];
    if (!snapshot || snapshot.state === "absent") return undefined;
    const path = join(this.#configDir, "transaction", "before", "state.json");
    if (!existsSync(path)) throw new Error("Pending Core transaction is missing its prior state snapshot.");
    const bytes = readFileSync(path);
    if (hashBytes(bytes) !== snapshot.sha256)
      throw new Error("Pending Core prior state snapshot failed its hash check.");
    return parseState(bytes.toString("utf8"));
  }

  async #priorLedger(required = false): Promise<{ priorMigrationLedger?: string }> {
    if (!this.#options.readMigrationLedger) {
      if (required) throw new Error("Core update requires a readable pre-update migration ledger.");
      return {};
    }
    const ledger = await this.#options.readMigrationLedger();
    if (required && ledger.length === 0)
      throw new Error("Core update requires a non-empty pre-update migration ledger.");
    return ledger.length > 0 ? { priorMigrationLedger: ledger } : {};
  }

  async #readBackupIdentity(): Promise<PairedBackupIdentity> {
    if (!this.#options.readBackupIdentity) {
      throw new Error(
        "Core update recovery requires a validated paired PostgreSQL and MinIO backup (set ATLAS_CORE_BACKUP_DIR)."
      );
    }
    const identity = await this.#options.readBackupIdentity();
    if (typeof identity !== "string" || !DIGEST_PATTERN.test(identity)) {
      throw new Error("The paired backup identity is missing or malformed.");
    }
    return identity;
  }

  #targetFromOptions(): CoreTarget {
    return {
      packageRoot: this.#options.packageRoot,
      packageVersion: this.#options.packageVersion,
      packageImage: this.#options.packageImage,
      packageContracts: this.#options.packageContracts,
      ...(this.#options.bundleFiles ? { bundleFiles: this.#options.bundleFiles } : {}),
      ...(this.#options.images ? { images: this.#options.images } : {}),
      ...(this.#options.previousRunning !== undefined ? { previousRunning: this.#options.previousRunning } : {}),
      ...(this.#options.desiredRunning !== undefined ? { desiredRunning: this.#options.desiredRunning } : {})
    };
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}

function normalizeOptions(options: ManagedCoreOptions): ManagedCoreOptions {
  if (!isAbsolute(options.configDir)) throw new Error("Managed Core requires an absolute configuration directory.");
  if (!isDigestPinnedImage(options.packageImage)) throw new Error("Managed Core requires a digest-pinned Core image.");
  if (!options.packageVersion.trim()) throw new Error("Managed Core requires a package version.");
  if (!options.dockerEngineId.trim()) throw new Error("Managed Core requires a Docker engine ID.");
  return options;
}

function isDigestPinnedImage(value: string): boolean {
  const marker = "@sha256:";
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex <= 0 || !DIGEST_PATTERN.test(value.slice(markerIndex + 1))) return false;
  const name = value.slice(0, markerIndex);
  const components = name.split("/");
  const last = components.pop();
  if (!last) return false;
  const tagIndex = last.lastIndexOf(":");
  const repository = tagIndex >= 0 ? last.slice(0, tagIndex) : last;
  const tag = tagIndex >= 0 ? last.slice(tagIndex + 1) : undefined;
  if (!repository || (tag !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(tag))) return false;
  components.push(repository);
  const [first, ...rest] = components;
  if (!first) return false;
  const hostParts = first.split(":");
  if (hostParts.length > 2) return false;
  const host = hostParts[0] ?? "";
  const port = hostParts.length === 2 ? hostParts[1] : undefined;
  const hasRegistryHost = host.includes(".") || host === "localhost" || port !== undefined;
  if (hasRegistryHost) {
    if (!host || !/^[a-z0-9][a-z0-9.-]*$/u.test(host) || (port !== undefined && !/^\d+$/u.test(port))) return false;
  } else if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(first)) {
    return false;
  }
  return rest.every((component) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(component));
}

function parseComposeImageScalar(raw: string): string | undefined {
  const withoutComment = raw.replace(/\s+#.*$/u, "").trim();
  const quoted =
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"));
  const image = quoted ? withoutComment.slice(1, -1) : withoutComment;
  if (CORE_IMAGE_PLACEHOLDER.test(image)) return undefined;
  if (!isDigestPinnedImage(image)) {
    throw new Error(
      `Retained Compose image ${image || "<empty>"} must use a lowercase repository and immutable digest.`
    );
  }
  return image;
}

/**
 * The retained production Compose file must never install an OS-level
 * restart policy. Core startup and recovery are journaled by the CLI, so an
 * automatic Docker restart could race recovery and resurrect a failed
 * candidate. Keep this structural check deliberately small instead of
 * introducing a second YAML parser for the bundle.
 */
function assertComposeRestartPolicy(baseDirectory: string): void {
  const composePath = join(baseDirectory, "docker-compose.yml");
  if (!existsSync(composePath)) throw new Error("Retained production Compose file is missing.");
  const services: Array<{ name: string; restart?: string }> = [];
  let inServices = false;
  let current: { name: string; restart?: string } | undefined;
  const finishService = (): void => {
    if (current) services.push(current);
    current = undefined;
  };

  for (const line of readFileSync(composePath, "utf8").split(/\r?\n/u)) {
    if (/^services:\s*(?:#.*)?$/u.test(line)) {
      finishService();
      inServices = true;
      continue;
    }
    if (inServices && /^\S/u.test(line)) {
      finishService();
      inServices = false;
      continue;
    }
    if (!inServices) continue;
    const serviceMatch = /^  ([a-z][a-z0-9-]*):\s*(?:#.*)?$/u.exec(line);
    if (serviceMatch?.[1]) {
      finishService();
      current = { name: serviceMatch[1] };
      continue;
    }
    const restartMatch = /^    restart:\s*(.*?)\s*$/u.exec(line);
    if (!current || !restartMatch) continue;
    if (current.restart !== undefined) {
      throw new Error(`Retained Compose service ${current.name} declares restart more than once.`);
    }
    current.restart = parseComposeScalar(restartMatch[1] ?? "");
  }
  finishService();
  if (services.length === 0) throw new Error("Retained production Compose file has no services.");
  for (const service of services) {
    if (service.restart !== "no") {
      throw new Error(`Retained Compose service ${service.name} must set restart: no.`);
    }
  }
}

function parseComposeScalar(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/u, "").trim();
  const quoted =
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"));
  return quoted ? withoutComment.slice(1, -1) : withoutComment;
}

function discoverBundleFiles(sourceRoot: string): string[] {
  const required = ["docker-compose.yml", "docker-compose.init.yml", "source_gateway.production.json"];
  const files = [...required];
  const templates = join(sourceRoot, "plugin-templates");
  if (existsSync(templates)) {
    for (const path of listRegularFiles(templates)) files.push(`plugin-templates/${path}`);
  }
  return [...new Set(files)].sort();
}

function listRegularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new Error(`Core bundle path ${root} must not be a symbolic link.`);
  const files: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}${sep}${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Core bundle path ${path} must not be a symbolic link.`);
      if (entry.isDirectory()) walk(absolute, path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Core bundle path ${path} must be a regular file.`);
    }
  };
  walk(root, "");
  return files.sort();
}

function parseState(encoded: string): ManagedCoreState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("Atlas Core state is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Atlas Core state is invalid.");
  const record = value as Record<string, unknown>;
  if (record.schema !== LEGACY_STATE_SCHEMA && record.schema !== STATE_SCHEMA)
    throw new Error("Atlas Core state schema is unsupported.");
  if (record.schema === STATE_SCHEMA) return parseManagedCoreState(value);
  if (record.resourceLayout !== RESOURCE_LAYOUT || (record.phase !== "initializing" && record.phase !== "ready")) {
    throw new Error("Atlas Core state has invalid deployment metadata.");
  }
  if (
    typeof record.initializedAt !== "string" ||
    typeof record.packageVersion !== "string" ||
    typeof record.dockerEngineId !== "string" ||
    !Array.isArray(record.enabledPlugins) ||
    record.enabledPlugins.some((plugin) => typeof plugin !== "string" || !PLUGIN_ID_PATTERN.test(plugin))
  ) {
    throw new Error("Atlas Core state has invalid fields.");
  }
  const baseDeployment = record.baseDeployment === undefined ? undefined : parseBaseDeployment(record.baseDeployment);
  return {
    schema: record.schema,
    resourceLayout: RESOURCE_LAYOUT,
    phase: record.phase,
    initializedAt: record.initializedAt,
    packageVersion: record.packageVersion,
    dockerEngineId: record.dockerEngineId,
    enabledPlugins: [...new Set(record.enabledPlugins)].sort(),
    ...(typeof record.startAttemptedAt === "string" ? { startAttemptedAt: record.startAttemptedAt } : {}),
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    ...(baseDeployment ? { baseDeployment } : {})
  };
}

/** Parse and validate a schema-4 root state read from disk or a transaction. */
export function parseManagedCoreState(value: unknown): ManagedCoreState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Atlas Core state is invalid.");
  const record = value as Record<string, unknown>;
  if (record.schema !== STATE_SCHEMA) throw new Error("Atlas Core state is not schema 4.");
  if (record.resourceLayout !== RESOURCE_LAYOUT || (record.phase !== "initializing" && record.phase !== "ready")) {
    throw new Error("Atlas Core schema-4 state has invalid deployment metadata.");
  }
  if (
    typeof record.initializedAt !== "string" ||
    typeof record.packageVersion !== "string" ||
    typeof record.dockerEngineId !== "string" ||
    !Array.isArray(record.enabledPlugins)
  ) {
    throw new Error("Atlas Core schema-4 state has invalid fields.");
  }
  const enabledPlugins = record.enabledPlugins.map((plugin) => {
    if (typeof plugin !== "string" || !PLUGIN_ID_PATTERN.test(plugin)) {
      throw new Error("Atlas Core schema-4 state has an invalid enabled Plugin ID.");
    }
    return plugin;
  });
  if (new Set(enabledPlugins).size !== enabledPlugins.length) {
    throw new Error("Atlas Core schema-4 state contains duplicate enabled Plugin IDs.");
  }
  if (typeof record.startAttemptedAt !== "undefined" && typeof record.startAttemptedAt !== "string") {
    throw new Error("Atlas Core schema-4 state has an invalid start attempt timestamp.");
  }
  if (typeof record.startedAt !== "undefined" && typeof record.startedAt !== "string") {
    throw new Error("Atlas Core schema-4 state has an invalid started timestamp.");
  }
  const baseDeployment = record.baseDeployment === undefined ? undefined : parseBaseDeployment(record.baseDeployment);
  const pluginContracts =
    record.pluginContracts === undefined ? undefined : parsePluginContracts(record.pluginContracts);
  if (record.phase === "ready" && (!baseDeployment || !baseDeployment.images || !pluginContracts)) {
    throw new Error("Atlas Core ready schema-4 state requires base deployment image receipts and Plugin contracts.");
  }
  return {
    schema: STATE_SCHEMA,
    resourceLayout: RESOURCE_LAYOUT,
    phase: record.phase,
    initializedAt: record.initializedAt,
    packageVersion: record.packageVersion,
    dockerEngineId: record.dockerEngineId,
    enabledPlugins: [...enabledPlugins].sort(),
    ...(typeof record.startAttemptedAt === "string" ? { startAttemptedAt: record.startAttemptedAt } : {}),
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    ...(baseDeployment ? { baseDeployment } : {}),
    ...(pluginContracts ? { pluginContracts } : {})
  };
}

function parseStateBuffer(bytes: Uint8Array): ManagedCoreState | undefined {
  return parseState(Buffer.from(bytes).toString("utf8"));
}

export function parseBaseDeployment(value: unknown): BaseDeployment {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Core state has invalid base deployment.");
  const record = value as Record<string, unknown>;
  if (
    typeof record.bundleSha256 !== "string" ||
    !DIGEST_PATTERN.test(record.bundleSha256) ||
    typeof record.coreImage !== "string" ||
    !isDigestPinnedImage(record.coreImage) ||
    typeof record.coreLocalImageId !== "string" ||
    !DIGEST_PATTERN.test(record.coreLocalImageId)
  ) {
    throw new Error("Core state has invalid base image or bundle receipt.");
  }
  const images = record.images === undefined ? undefined : parseImages(record.images);
  if (images && !images.some((image) => image.image_index === record.coreImage)) {
    throw new Error("Core state image receipts do not include the committed Core image.");
  }
  return {
    bundleSha256: record.bundleSha256 as `sha256:${string}`,
    coreImage: record.coreImage,
    coreLocalImageId: record.coreLocalImageId as `sha256:${string}`,
    ...(images ? { images } : {})
  };
}

function parsePluginContracts(value: unknown): PluginContracts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Atlas Core schema-4 state has no Plugin contracts.");
  }
  const record = value as Record<string, unknown>;
  const coreToPluginProtocolMajors = parseProtocolMajors(record.coreToPluginProtocolMajors, "Core-to-Plugin");
  const pluginToSourceGatewayProtocolMajors = parseProtocolMajors(
    record.pluginToSourceGatewayProtocolMajors,
    "Plugin-to-Source-Gateway"
  );
  if (
    (typeof record.atlasProtocolRevision !== "string" && record.atlasProtocolRevision !== null) ||
    (typeof record.atlasProtocolRevision === "string" && !DIGEST_PATTERN.test(record.atlasProtocolRevision))
  ) {
    throw new Error("Atlas Core schema-4 state has an invalid Atlas Protocol revision.");
  }
  const supportedPackageSchemaMajors = parseProtocolMajors(
    record.supportedPackageSchemaMajors,
    "supported package schema"
  );
  const supportedInteractions = parseSupportedInteractions(record.supportedInteractions);
  return {
    coreToPluginProtocolMajors,
    pluginToSourceGatewayProtocolMajors,
    atlasProtocolRevision: record.atlasProtocolRevision,
    supportedPackageSchemaMajors,
    supportedInteractions
  };
}

function parseSupportedInteractions(value: unknown): PluginInteraction[] {
  if (
    !Array.isArray(value) ||
    value.some((interaction) => interaction !== "map_area") ||
    new Set(value).size !== value.length ||
    value.some((interaction, index) => index > 0 && interaction < value[index - 1]!)
  ) {
    throw new Error("Atlas Core schema-4 state has invalid supported Plugin interactions.");
  }
  return [...value] as PluginInteraction[];
}

function parseProtocolMajors(value: unknown, name: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((major) => typeof major !== "number" || !Number.isSafeInteger(major) || major < 1) ||
    new Set(value).size !== value.length ||
    value.some((major, index) => index > 0 && major < value[index - 1]!)
  ) {
    throw new Error(`Atlas Core schema-4 state has invalid ${name} protocol majors.`);
  }
  return [...value];
}

function parseImages(value: unknown): ImageReceipt[] {
  if (!Array.isArray(value)) throw new Error("Core state has invalid image receipts.");
  const images = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("Core state has invalid image receipt.");
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.image_index !== "string" ||
      !isDigestPinnedImage(record.image_index) ||
      typeof record.platform_manifest_sha256 !== "string" ||
      !DIGEST_PATTERN.test(record.platform_manifest_sha256) ||
      typeof record.local_image_id !== "string" ||
      !DIGEST_PATTERN.test(record.local_image_id)
    ) {
      throw new Error("Core state has invalid image receipt.");
    }
    return {
      image_index: record.image_index,
      platform_manifest_sha256: record.platform_manifest_sha256,
      local_image_id: record.local_image_id
    };
  });
  if (new Set(images.map((image) => image.image_index)).size !== images.length) {
    throw new Error("Core state contains duplicate image receipts.");
  }
  return images.sort((left, right) => left.image_index.localeCompare(right.image_index));
}

function encodeState(state: ManagedCoreState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function receiptFromState(state: ManagedCoreState): ImageReceipt {
  if (!state.baseDeployment) throw new Error("Schema-4 Core state has no base image receipt.");
  return receiptFromBase(state.baseDeployment);
}

function receiptFromBase(base: BaseDeployment): ImageReceipt {
  const stored = base.images?.find((receipt) => receipt.image_index === base.coreImage);
  if (stored) return stored;
  return {
    image_index: base.coreImage,
    platform_manifest_sha256: base.coreImage.slice(base.coreImage.lastIndexOf("@") + 1),
    local_image_id: base.coreLocalImageId
  };
}

function serviceForImage(image: string, baseDirectory: string): string | undefined {
  for (const composeName of ["docker-compose.yml", "docker-compose.init.yml"]) {
    const path = join(baseDirectory, composeName);
    if (!existsSync(path)) continue;
    let service: string | undefined;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
      const serviceMatch = /^  ([a-z][a-z0-9-]*):\s*$/u.exec(line);
      if (serviceMatch?.[1]) {
        service = serviceMatch[1];
        continue;
      }
      const imageMatch = /^    image:\s*(.*?)\s*$/u.exec(line);
      if (service && imageMatch && parseComposeImageScalar(imageMatch[1] ?? "") === image) return service;
    }
  }
  return undefined;
}

function imageForService(serviceName: string, baseDirectory: string): string | undefined {
  for (const composeName of ["docker-compose.yml", "docker-compose.init.yml"]) {
    const path = join(baseDirectory, composeName);
    if (!existsSync(path)) continue;
    let service: string | undefined;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
      const serviceMatch = /^  ([a-z][a-z0-9-]*):\s*$/u.exec(line);
      if (serviceMatch?.[1]) {
        service = serviceMatch[1];
        continue;
      }
      const imageMatch = /^    image:\s*(.*?)\s*$/u.exec(line);
      if (service === serviceName && imageMatch) return parseComposeImageScalar(imageMatch[1] ?? "");
    }
  }
  return undefined;
}

function manifestFromTransaction(transaction: DeploymentTransactionStore): RetainedBundleManifest {
  const journal = transaction.read();
  const files = Object.entries(journal.staged)
    .filter(([path]) => path.startsWith("base/"))
    .map(([path, metadata]) => ({
      path: path.slice("base/".length),
      sha256: metadata.sha256,
      size: metadata.size,
      mode: metadata.mode
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) throw new Error("Pending Core transaction has no retained bundle metadata.");
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = transaction.readStaged(`base/${file.path}`);
    hash.update(Buffer.from(file.path, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(bytes.byteLength), "ascii"));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([10]));
  }
  return {
    schema: 1,
    files,
    bundleSha256: `sha256:${hash.digest("hex")}`
  };
}

function recoveryActionForPhase(phase: TransactionJournal["phase"]): string {
  if (phase === "prepared" || phase === "runtime-changing") return "rollback and restore the prior composition";
  if (phase === "core-started" || phase === "credentials-durable") return "retry, forward, or confirm paired restore";
  if (phase === "committed") return "finish transaction cleanup";
  if (phase === "rollback-complete") return "finish rollback cleanup";
  return "none";
}

function assertInitRecoveryTarget(journal: TransactionJournal, target: CoreTarget): void {
  const recordedVersion = journal.recovery?.targetPackageVersion;
  const recordedImage = journal.recovery?.targetCoreImage;
  if (recordedVersion === target.packageVersion && recordedImage === target.packageImage) return;
  if (!recordedVersion || !recordedImage) {
    throw new Error(
      "Interrupted Atlas Core initialization has no recorded target. Install the exact CLI package that started it before retrying."
    );
  }
  throw new Error(
    `Interrupted Atlas Core initialization targets ${recordedVersion} (${recordedImage}). ` +
      "Install that exact CLI package before retrying, or use an explicit forward recovery."
  );
}

function assertComposeSuccess(operation: string, result: ComposeResult): void {
  if (result.status !== 0)
    throw new Error(`${operation} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
}

function normalizeAbsolute(path: string, description: string): string {
  if (!isAbsolute(path)) throw new Error(`${description} must be absolute.`);
  return normalize(path);
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
