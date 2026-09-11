import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { hostname, platform, uptime } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

const TRANSACTION_SCHEMA = 1 as const;
const TRANSACTION_DIRECTORY = "transaction";
const JOURNAL_FILE = "journal.json";
const BEFORE_DIRECTORY = "before";
const STAGED_DIRECTORY = "staged";
const EXCLUDED_PATHS = new Set(["catalog-state.json", "run-intent.json"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type TransactionPhase =
  | "prepared"
  | "runtime-changing"
  | "core-started"
  | "credentials-durable"
  | "committed"
  | "rollback-complete";

export type TransactionOperation =
  | "init"
  | "core-update"
  | "start"
  | "stop"
  | "restart"
  | "reset"
  | "config"
  | "repair"
  | "engine-recovery"
  | "plugin-install"
  | "plugin-enable"
  | "plugin-disable"
  | "plugin-update"
  | "plugin-rollback"
  | "plugin-uninstall"
  | "plugin-refresh"
  | "plugin-key-rotation"
  | "plugin-rotate-core-key";

export type TransactionOwnerIdentity = {
  pid: number;
  bootIdentity: string;
  processStartIdentity: string;
  dockerEngineId: string;
};

export type TransactionFileSnapshot = {
  state: "present" | "absent";
  sha256?: `sha256:${string}`;
  mode?: number;
  size?: number;
};

export type TransactionStagedFile = {
  sha256: `sha256:${string}`;
  mode: number;
  size: number;
};

export type TransactionRecoveryMetadata = {
  fromPackageVersion?: string;
  targetPackageVersion?: string;
  targetCoreImage?: string;
  priorMigrationLedger?: string;
  priorBackupIdentity?: `sha256:${string}`;
  targetStatePath?: string;
};

export type TransactionJournal = {
  schema: typeof TRANSACTION_SCHEMA;
  id: string;
  operation: TransactionOperation;
  owner: TransactionOwnerIdentity;
  previousRunning: boolean;
  desiredRunning: boolean;
  phase: TransactionPhase;
  createdAt: string;
  updatedAt: string;
  snapshots: Record<string, TransactionFileSnapshot>;
  staged: Record<string, TransactionStagedFile>;
  recovery?: TransactionRecoveryMetadata;
};

export type BeginTransactionOptions = {
  operation: TransactionOperation;
  dockerEngineId: string;
  previousRunning: boolean;
  desiredRunning: boolean;
  owner?: TransactionOwnerIdentity;
  id?: string;
  now?: Date;
  recovery?: TransactionRecoveryMetadata;
};

export type StageFileOptions = {
  mode?: number;
};

export type TransactionRollbackResult = {
  desiredRunning: boolean;
  previousRunning: boolean;
  restoredPaths: readonly string[];
};

export type OwnerLiveness = "alive" | "dead" | "ambiguous";

export class TransactionRecoveryRequiredError extends Error {
  readonly phase: TransactionPhase;

  constructor(phase: TransactionPhase) {
    super(
      `Atlas Core cannot automatically roll back a transaction after phase ${phase}. ` +
        "Inspect the retained candidate and finish the operation forward."
    );
    this.name = "TransactionRecoveryRequiredError";
    this.phase = phase;
  }
}

export class DeploymentTransactionStore {
  readonly #configDir: string;
  readonly #transactionDir: string;
  readonly #journalPath: string;
  readonly #beforeDir: string;
  readonly #stagedDir: string;
  #journal: TransactionJournal;

  private constructor(configDir: string, journal: TransactionJournal) {
    this.#configDir = configDir;
    this.#transactionDir = join(configDir, TRANSACTION_DIRECTORY);
    this.#journalPath = join(this.#transactionDir, JOURNAL_FILE);
    this.#beforeDir = join(this.#transactionDir, BEFORE_DIRECTORY);
    this.#stagedDir = join(this.#transactionDir, STAGED_DIRECTORY);
    this.#journal = journal;
  }

  static begin(configDir: string, options: BeginTransactionOptions): DeploymentTransactionStore {
    const root = normalizeConfigDirectory(configDir);
    if (options.dockerEngineId.length === 0) throw new Error("Deployment transaction requires a Docker engine ID.");
    mkdirPrivate(root);
    const transactionDir = join(root, TRANSACTION_DIRECTORY);
    if (pathExists(transactionDir)) {
      assertDirectory(transactionDir, "transaction directory");
      throw new Error(`Atlas Core already has a pending deployment transaction at ${transactionDir}.`);
    }
    removeAbandonedCandidates(root);

    const now = options.now ?? new Date();
    const owner = options.owner ?? createOwnerIdentity(options.dockerEngineId);
    if (owner.dockerEngineId !== options.dockerEngineId) {
      throw new Error("Deployment transaction owner Docker engine does not match the requested engine.");
    }
    const journal: TransactionJournal = {
      schema: TRANSACTION_SCHEMA,
      id: options.id ?? randomUUID(),
      operation: options.operation,
      owner,
      previousRunning: options.previousRunning,
      desiredRunning: options.desiredRunning,
      phase: "prepared",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      snapshots: {},
      staged: {},
      ...(options.recovery ? { recovery: options.recovery } : {})
    };
    const candidateDir = join(root, `.${TRANSACTION_DIRECTORY}.candidate-${journal.id}`);
    mkdirPrivate(candidateDir);
    mkdirPrivate(join(candidateDir, BEFORE_DIRECTORY));
    mkdirPrivate(join(candidateDir, STAGED_DIRECTORY));
    const store = new DeploymentTransactionStore(root, journal);
    writeJournal(join(candidateDir, JOURNAL_FILE), journal);
    syncDirectory(candidateDir);
    renameSync(candidateDir, transactionDir);
    syncDirectory(root);
    return store;
  }

  static open(configDir: string): DeploymentTransactionStore {
    const root = normalizeConfigDirectory(configDir);
    const transactionDir = join(root, TRANSACTION_DIRECTORY);
    assertDirectory(transactionDir, "transaction directory");
    const journalPath = join(transactionDir, JOURNAL_FILE);
    const journal = parseJournal(readFileSync(journalPath, "utf8"));
    assertDirectory(join(transactionDir, BEFORE_DIRECTORY), "transaction before directory");
    assertDirectory(join(transactionDir, STAGED_DIRECTORY), "transaction staged directory");
    const store = new DeploymentTransactionStore(root, journal);
    store.#assertJournalPaths();
    return store;
  }

  static exists(configDir: string): boolean {
    const root = normalizeConfigDirectory(configDir);
    const transactionDir = join(root, TRANSACTION_DIRECTORY);
    return pathExists(transactionDir);
  }

  get journal(): TransactionJournal {
    return cloneJournal(this.#journal);
  }

  get id(): string {
    return this.#journal.id;
  }

  read(): TransactionJournal {
    const current = parseJournal(readFileSync(this.#journalPath, "utf8"));
    if (current.id !== this.#journal.id) throw new Error("Deployment transaction journal changed ownership.");
    this.#journal = current;
    this.#assertJournalPaths();
    return cloneJournal(current);
  }

  snapshot(relativePath: string): TransactionFileSnapshot {
    const path = this.#validateRootRelativePath(relativePath);
    const existing = this.#journal.snapshots[path];
    if (existing) return { ...existing };
    const target = this.#rootPath(path);
    assertNoSymlinkAncestors(this.#configDir, path);
    const stats = existingRegularFileStats(target, `transaction snapshot ${path}`);
    const snapshot: TransactionFileSnapshot = stats
      ? {
          state: "present",
          sha256: hashFile(target),
          mode: stats.mode & 0o777,
          size: stats.size
        }
      : { state: "absent" };
    if (stats) {
      const beforePath = this.#internalPath(BEFORE_DIRECTORY, path);
      assertNoSymlinkAncestors(this.#transactionDir, join(BEFORE_DIRECTORY, path));
      mkdirPrivate(dirname(beforePath));
      copyFileDurably(target, beforePath, snapshot.mode ?? 0o600);
    }
    this.#journal = {
      ...this.#journal,
      snapshots: { ...this.#journal.snapshots, [path]: snapshot }
    };
    this.#persist();
    return { ...snapshot };
  }

  snapshotTree(relativeDirectory: string): readonly string[] {
    const rootPath = this.#validateRootRelativePath(relativeDirectory);
    const target = this.#rootPath(rootPath);
    if (!pathExists(target)) return [];
    assertNoSymlinkAncestors(this.#configDir, rootPath);
    if (!lstatSync(target).isDirectory()) throw new Error(`Transaction snapshot root ${rootPath} must be a directory.`);
    const paths: string[] = [];
    const visit = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(prefix, entry.name);
        const absolute = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Transaction snapshot contains a symbolic link: ${path}`);
        if (entry.isDirectory()) visit(absolute, path);
        else if (entry.isFile()) {
          this.snapshot(path);
          paths.push(path);
        } else throw new Error(`Transaction snapshot contains a non-regular entry: ${path}`);
      }
    };
    visit(target, rootPath);
    return paths.sort();
  }

  stage(relativePath: string, contents: Uint8Array | string, options: StageFileOptions = {}): TransactionStagedFile {
    const path = this.#validateRootRelativePath(relativePath);
    // Staging is the boundary before a caller can publish the candidate. Keep
    // an absent-before record even when callers do not separately snapshot it.
    this.snapshot(path);
    const mode = options.mode ?? 0o600;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error(`Invalid staged file mode for ${path}.`);
    const stagedPath = this.#internalPath(STAGED_DIRECTORY, path);
    assertNoSymlinkAncestors(this.#transactionDir, join(STAGED_DIRECTORY, path));
    mkdirPrivate(dirname(stagedPath));
    writeFileDurably(stagedPath, contents, mode);
    const bytes = readFileSync(stagedPath);
    const staged: TransactionStagedFile = {
      sha256: hashBytes(bytes),
      mode,
      size: bytes.byteLength
    };
    this.#journal = {
      ...this.#journal,
      staged: { ...this.#journal.staged, [path]: staged }
    };
    this.#persist();
    return { ...staged };
  }

  /** Remove stale staged entries after the replacement files have been staged. */
  removeStagedSubtreeEntriesNotIn(relativeDirectory: string, retainedPaths: readonly string[]): void {
    const rootPath = this.#validateRootRelativePath(relativeDirectory);
    const prefix = `${rootPath}${sep}`;
    const retained = new Set(retainedPaths.map((path) => this.#validateRootRelativePath(join(rootPath, path))));
    const stalePaths = Object.keys(this.#journal.staged).filter(
      (path) => path.startsWith(prefix) && !retained.has(path)
    );
    const nextStaged = Object.fromEntries(
      Object.entries(this.#journal.staged).filter(([path]) => !stalePaths.includes(path))
    );
    this.#journal = { ...this.#journal, staged: nextStaged };
    this.#persist();
  }

  stagedPath(relativePath: string): string {
    const path = this.#validateRootRelativePath(relativePath);
    const metadata = this.#journal.staged[path];
    if (!metadata) throw new Error(`Deployment transaction has no staged file ${path}.`);
    assertNoSymlinkAncestors(this.#transactionDir, join(STAGED_DIRECTORY, path));
    const target = this.#internalPath(STAGED_DIRECTORY, path);
    const stats = assertRegularFile(target, `staged file ${path}`);
    const bytes = readFileSync(target);
    if (hashBytes(bytes) !== metadata.sha256 || bytes.byteLength !== metadata.size) {
      throw new Error(`Staged file ${path} failed its transaction hash check.`);
    }
    if ((stats.mode & 0o777) !== metadata.mode) throw new Error(`Staged file ${path} has an unexpected mode.`);
    return target;
  }

  readStaged(relativePath: string): Buffer {
    return readFileSync(this.stagedPath(relativePath));
  }

  applyStaged(relativePath: string): void {
    const path = this.#validateRootRelativePath(relativePath);
    this.snapshot(path);
    const source = this.stagedPath(path);
    const target = this.#rootPath(path);
    mkdirPrivate(dirname(target));
    copyFileDurably(source, target, this.#journal.staged[path]?.mode ?? 0o600);
  }

  remove(relativePath: string): void {
    const path = this.#validateRootRelativePath(relativePath);
    this.snapshot(path);
    const target = this.#rootPath(path);
    if (!pathExists(target)) return;
    assertRegularFile(target, `transaction target ${path}`);
    unlinkSync(target);
    syncDirectory(dirname(target));
  }

  advance(phase: TransactionPhase, recovery?: TransactionRecoveryMetadata): TransactionJournal {
    assertPhaseTransition(this.#journal.phase, phase);
    this.#journal = {
      ...this.#journal,
      phase,
      updatedAt: new Date().toISOString(),
      ...(recovery ? { recovery: { ...this.#journal.recovery, ...recovery } } : {})
    };
    this.#persist();
    return cloneJournal(this.#journal);
  }

  markCommitted(): TransactionJournal {
    return this.advance("committed");
  }

  rollback(): TransactionRollbackResult {
    const current = this.read();
    if (current.phase === "core-started" || current.phase === "credentials-durable") {
      throw new TransactionRecoveryRequiredError(current.phase);
    }
    if (current.phase === "committed") {
      throw new TransactionRecoveryRequiredError(current.phase);
    }
    return this.#restoreSnapshots(current);
  }

  /**
   * Restore the pre-mutation files after an operator-confirmed paired backup
   * restore. This is deliberately separate from rollback because the Core may
   * already have started; callers must verify the paired database/object-store
   * restore and migration ledger before invoking it.
   */
  restoreAfterPairedBackup(): TransactionRollbackResult {
    const current = this.read();
    if (current.phase !== "core-started" && current.phase !== "credentials-durable") {
      throw new Error(`Paired backup restoration requires a started Core transaction, found phase ${current.phase}.`);
    }
    return this.#restoreSnapshots(current);
  }

  #restoreSnapshots(current: TransactionJournal): TransactionRollbackResult {
    const paths = Object.keys(current.snapshots).sort();
    for (const path of paths) {
      const snapshot = current.snapshots[path];
      if (!snapshot) continue;
      const target = this.#rootPath(path);
      assertNoSymlinkAncestors(this.#configDir, path);
      if (snapshot.state === "absent") {
        if (pathExists(target)) {
          assertRegularFile(target, `transaction rollback target ${path}`);
          unlinkSync(target);
          syncDirectory(dirname(target));
        }
        continue;
      }
      const beforePath = this.#internalPath(BEFORE_DIRECTORY, path);
      assertNoSymlinkAncestors(this.#transactionDir, join(BEFORE_DIRECTORY, path));
      assertRegularFile(beforePath, `transaction before file ${path}`);
      if (hashFile(beforePath) !== snapshot.sha256)
        throw new Error(`Transaction before file ${path} failed its hash check.`);
      mkdirPrivate(dirname(target));
      copyFileDurably(beforePath, target, snapshot.mode ?? 0o600);
    }
    this.#journal = { ...this.#journal, phase: "rollback-complete", updatedAt: new Date().toISOString() };
    this.#persist();
    return {
      desiredRunning: current.desiredRunning,
      previousRunning: current.previousRunning,
      restoredPaths: paths
    };
  }

  cleanup(): void {
    const current = this.read();
    if (current.phase !== "committed" && current.phase !== "rollback-complete") {
      throw new Error(`Cannot clean up deployment transaction in phase ${current.phase}.`);
    }
    assertDirectory(this.#transactionDir, "transaction directory");
    rmSync(this.#transactionDir, { recursive: true, force: false });
    syncDirectory(this.#configDir);
  }

  #validateRootRelativePath(relativePath: string): string {
    const path = validateRelativePath(relativePath);
    if (EXCLUDED_PATHS.has(path)) {
      throw new Error(`${path} is durable monotonic state and cannot be part of a transaction rollback.`);
    }
    if (path === TRANSACTION_DIRECTORY || path.startsWith(`${TRANSACTION_DIRECTORY}${sep}`)) {
      throw new Error("The deployment transaction directory cannot be mutated through its own journal.");
    }
    return path;
  }

  #rootPath(path: string): string {
    return containedPath(this.#configDir, path);
  }

  #internalPath(directory: string, path: string): string {
    return containedPath(this.#transactionDir, join(directory, path));
  }

  #persist(): void {
    writeFileDurably(this.#journalPath, `${JSON.stringify(this.#journal, null, 2)}\n`, 0o600);
    syncDirectory(this.#transactionDir);
  }

  #assertJournalPaths(): void {
    for (const path of [...Object.keys(this.#journal.snapshots), ...Object.keys(this.#journal.staged)]) {
      this.#validateRootRelativePath(path);
    }
  }
}

export function createOwnerIdentity(dockerEngineId: string): TransactionOwnerIdentity {
  if (dockerEngineId.length === 0) throw new Error("Deployment transaction owner requires a Docker engine ID.");
  return {
    pid: process.pid,
    bootIdentity: readBootIdentity(),
    processStartIdentity:
      readProcessStartIdentity(process.pid) ?? `${Date.now()}-${process.hrtime.bigint().toString()}`,
    dockerEngineId
  };
}

export function ownerLiveness(owner: TransactionOwnerIdentity): OwnerLiveness {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return "ambiguous";
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return "dead";
    return "ambiguous";
  }
  const currentBootIdentity = readBootIdentity();
  if (currentBootIdentity !== owner.bootIdentity) return "dead";
  const currentProcessStartIdentity = readProcessStartIdentity(owner.pid);
  if (!currentProcessStartIdentity) return "ambiguous";
  return currentProcessStartIdentity === owner.processStartIdentity ? "alive" : "dead";
}

export function isOwnerDead(owner: TransactionOwnerIdentity): boolean {
  return ownerLiveness(owner) === "dead";
}

function normalizeConfigDirectory(configDir: string): string {
  if (typeof configDir !== "string" || configDir.length === 0 || !isAbsolute(configDir)) {
    throw new Error("Atlas Core transaction storage requires an absolute configuration directory.");
  }
  return normalize(configDir);
}

function validateRelativePath(path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || isAbsolute(path)) {
    throw new Error(`Invalid transaction path ${JSON.stringify(path)}.`);
  }
  const normalized = normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}${sep}`) ||
    normalized.split(sep).some((part) => part === "")
  ) {
    throw new Error(`Transaction path escapes the configuration directory: ${path}`);
  }
  return normalized;
}

function containedPath(root: string, path: string): string {
  const target = join(root, path);
  const escape = relative(root, target);
  if (escape === ".." || escape.startsWith(`..${sep}`) || isAbsolute(escape)) {
    throw new Error(`Transaction path escapes the configuration directory: ${path}`);
  }
  return target;
}

function assertNoSymlinkAncestors(root: string, path: string): void {
  let current = root;
  for (const part of path.split(sep)) {
    current = join(current, part);
    if (!pathExists(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Transaction path contains a symbolic link: ${path}`);
  }
}

function existingRegularFileStats(path: string, description: string): Stats | undefined {
  if (!pathExists(path)) return undefined;
  assertRegularFile(path, description);
  return statSync(path);
}

function assertRegularFile(path: string, description: string): Stats {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${description} must not be a symbolic link.`);
  if (!stats.isFile()) throw new Error(`${description} must be a regular file.`);
  return stats;
}

function assertDirectory(path: string, description: string): void {
  if (!pathExists(path)) throw new Error(`Missing ${description} at ${path}.`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${description} must be a real directory.`);
}

function mkdirPrivate(path: string): void {
  if (pathExists(path)) {
    assertDirectory(path, "transaction path");
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    // mkdir's mode is affected by umask. Tighten existing parents when they are
    // already part of our private transaction tree.
    const stats = lstatSync(path);
    if (!stats.isSymbolicLink()) {
      // chmod is intentionally avoided here; callers preserve existing modes.
    }
  } catch {
    // The following operation will report the concrete filesystem failure.
  }
}

function writeFileDurably(path: string, contents: Uint8Array | string, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    chmodSync(temporary, mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (pathExists(temporary)) unlinkSync(temporary);
  }
}

function writeJournal(path: string, journal: TransactionJournal): void {
  writeFileDurably(path, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

function removeAbandonedCandidates(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(`.${TRANSACTION_DIRECTORY}.candidate-`)) continue;
    const candidate = join(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(`Invalid abandoned transaction candidate ${candidate}.`);
    rmSync(candidate, { recursive: true, force: false });
  }
  syncDirectory(root);
}

function copyFileDurably(source: string, destination: string, mode: number): void {
  const bytes = readFileSync(source);
  writeFileDurably(destination, bytes, mode);
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Windows and some virtual filesystems do not permit directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashFile(path: string): `sha256:${string}` {
  return hashBytes(readFileSync(path));
}

function cloneJournal(journal: TransactionJournal): TransactionJournal {
  return JSON.parse(JSON.stringify(journal)) as TransactionJournal;
}

function parseJournal(encoded: string): TransactionJournal {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("Atlas Core deployment transaction journal is not valid JSON.");
  }
  if (!isRecord(value)) throw new Error("Atlas Core deployment transaction journal is invalid.");
  if (value.schema !== TRANSACTION_SCHEMA)
    throw new Error("Atlas Core deployment transaction journal has an unsupported schema.");
  if (typeof value.id !== "string" || value.id.length === 0)
    throw new Error("Deployment transaction journal has no ID.");
  if (!isTransactionOperation(value.operation)) throw new Error("Deployment transaction journal has no operation.");
  if (!isOwnerIdentity(value.owner)) throw new Error("Deployment transaction journal has an invalid owner.");
  if (typeof value.previousRunning !== "boolean" || typeof value.desiredRunning !== "boolean") {
    throw new Error("Deployment transaction journal has invalid run intent.");
  }
  if (!isPhase(value.phase) || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("Deployment transaction journal has invalid phase metadata.");
  }
  if (!isSnapshotMap(value.snapshots) || !isStagedMap(value.staged)) {
    throw new Error("Deployment transaction journal has invalid file metadata.");
  }
  const recovery = value.recovery;
  if (recovery !== undefined && !isRecoveryMetadata(recovery)) {
    throw new Error("Deployment transaction journal has invalid recovery metadata.");
  }
  return {
    schema: TRANSACTION_SCHEMA,
    id: value.id,
    operation: value.operation,
    owner: value.owner,
    previousRunning: value.previousRunning,
    desiredRunning: value.desiredRunning,
    phase: value.phase,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    snapshots: value.snapshots,
    staged: value.staged,
    ...(recovery ? { recovery } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnerIdentity(value: unknown): value is TransactionOwnerIdentity {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    typeof value.bootIdentity === "string" &&
    value.bootIdentity.length > 0 &&
    typeof value.processStartIdentity === "string" &&
    value.processStartIdentity.length > 0 &&
    typeof value.dockerEngineId === "string" &&
    value.dockerEngineId.length > 0
  );
}

function isPhase(value: unknown): value is TransactionPhase {
  return (
    value === "prepared" ||
    value === "runtime-changing" ||
    value === "core-started" ||
    value === "credentials-durable" ||
    value === "committed" ||
    value === "rollback-complete"
  );
}

function isTransactionOperation(value: unknown): value is TransactionOperation {
  return (
    value === "init" ||
    value === "core-update" ||
    value === "start" ||
    value === "stop" ||
    value === "restart" ||
    value === "reset" ||
    value === "config" ||
    value === "repair" ||
    value === "engine-recovery" ||
    value === "plugin-install" ||
    value === "plugin-enable" ||
    value === "plugin-disable" ||
    value === "plugin-update" ||
    value === "plugin-rollback" ||
    value === "plugin-uninstall" ||
    value === "plugin-refresh" ||
    value === "plugin-key-rotation" ||
    value === "plugin-rotate-core-key"
  );
}

function isSnapshotMap(value: unknown): value is Record<string, TransactionFileSnapshot> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((candidate) => {
    if (!isRecord(candidate) || (candidate.state !== "present" && candidate.state !== "absent")) return false;
    if (candidate.state === "absent")
      return candidate.sha256 === undefined && candidate.mode === undefined && candidate.size === undefined;
    return (
      typeof candidate.sha256 === "string" &&
      SHA256_PATTERN.test(candidate.sha256) &&
      typeof candidate.mode === "number" &&
      Number.isInteger(candidate.mode) &&
      typeof candidate.size === "number" &&
      Number.isInteger(candidate.size) &&
      candidate.size >= 0
    );
  });
}

function isStagedMap(value: unknown): value is Record<string, TransactionStagedFile> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (candidate) =>
      isRecord(candidate) &&
      typeof candidate.sha256 === "string" &&
      SHA256_PATTERN.test(candidate.sha256) &&
      typeof candidate.mode === "number" &&
      Number.isInteger(candidate.mode) &&
      typeof candidate.size === "number" &&
      Number.isInteger(candidate.size) &&
      candidate.size >= 0
  );
}

function isRecoveryMetadata(value: unknown): value is TransactionRecoveryMetadata {
  if (!isRecord(value)) return false;
  if (
    ![
      "fromPackageVersion",
      "targetPackageVersion",
      "targetCoreImage",
      "priorMigrationLedger",
      "priorBackupIdentity",
      "targetStatePath"
    ].every((key) => value[key] === undefined || typeof value[key] === "string")
  ) {
    return false;
  }
  const priorBackupIdentity = value.priorBackupIdentity;
  return (
    priorBackupIdentity === undefined ||
    (typeof priorBackupIdentity === "string" && SHA256_PATTERN.test(priorBackupIdentity))
  );
}

function assertPhaseTransition(from: TransactionPhase, to: TransactionPhase): void {
  if (from === "rollback-complete" || from === "committed") {
    throw new Error(`Cannot advance a completed deployment transaction from phase ${from}.`);
  }
  const order: readonly TransactionPhase[] = [
    "prepared",
    "runtime-changing",
    "core-started",
    "credentials-durable",
    "committed"
  ];
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (to === "rollback-complete" || toIndex >= fromIndex) return;
  throw new Error(`Deployment transaction phase cannot move backward from ${from} to ${to}.`);
}

function readBootIdentity(): string {
  try {
    const encoded = readFileSync("/proc/stat", "utf8");
    const match = encoded.match(/^btime\s+(\d+)$/m);
    if (match?.[1]) return `linux:${match[1]}`;
  } catch {
    // macOS and non-proc systems use the system fallback below.
  }
  if (platform() === "darwin") {
    try {
      const encoded = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
      if (encoded) return `darwin:${encoded}`;
    } catch {
      // The fallback remains process-local and causes ambiguous recovery when it differs.
    }
  }
  return `host:${hostname()}:${Math.floor(Date.now() / 1000 - uptime())}`;
}

function readProcessStartIdentity(pid: number): string | undefined {
  try {
    const encoded = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = encoded.lastIndexOf(")");
    if (closeParen >= 0) {
      const fields = encoded
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      if (startTime) return `linux:${startTime}`;
    }
  } catch {
    // A non-Linux platform may not expose process start identity.
  }
  if (platform() === "darwin") {
    try {
      const encoded = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
      if (encoded) return `darwin:${encoded}`;
    } catch {
      // Unavailable process identity must remain ambiguous.
    }
  }
  return undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
