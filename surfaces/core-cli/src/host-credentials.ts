import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeploymentTransactionStore,
  type TransactionOperation,
  type TransactionPhase
} from "./deployment-transaction.js";

const ENV_FILE = ".env";
const PLUGIN_API_KEY = "ATLAS_PLUGIN_API_KEY";
const CREDENTIAL_INTENT_FILE = "credential-intent.json";
const CREDENTIAL_INTENT_SCHEMA = 1 as const;
const KEY_ATTEMPT_PREFIX = "atlas-plugin-key";

export type ManagedKeyAction = "create" | "list" | "revoke";

/** Signals that Core definitively rejected the presented managed key. */
export class ManagedPluginKeyRejectedError extends Error {
  constructor() {
    super("The managed Plugin key was rejected by Core.");
    this.name = "ManagedPluginKeyRejectedError";
  }
}

/** The host authority used to operate the already-running Core container. */
export type ManagedPluginCredentialHost = {
  isRunning(): Promise<boolean>;
  /** Start base services, optionally including the active SDK Plugin fragments. */
  startBase(includePluginFragments?: boolean): Promise<void>;
  stopBase(): Promise<void>;
  runManagedKeys(action: ManagedKeyAction, value: string): Promise<unknown>;
  /** `apiKey` is the complete one-time `id.secret` value returned by create. */
  authenticateKey(apiKey: string): Promise<void>;
  /** Recreate enabled SDK Plugin services with an optional in-memory candidate key. */
  recreateSDKPlugins(apiKey?: string): Promise<void>;
  verifySDKPlugins(): Promise<void>;
  /** Restore enabled SDK Plugin services using the current (old) .env key. */
  restoreSDKPlugins(): Promise<void>;
  /** Run compensation in the host's cancellation-resistant command scope. */
  withRecovery<T>(operation: () => Promise<T>): Promise<T>;
};

export type ManagedPluginCredentialsOptions = {
  configDir: string;
  /** Existing transaction used by init/Core update. Standalone rotation opens its own. */
  transactions?: DeploymentTransactionStore;
  host: ManagedPluginCredentialHost;
  dockerEngineId: string;
  now?: () => Date;
};

type CredentialIntent = {
  schema: typeof CREDENTIAL_INTENT_SCHEMA;
  operation: TransactionOperation;
  transactionId: string;
  attempt: number;
  attemptName: string;
  previousKeyId?: string;
  candidateKeyId?: string;
  candidateAuthenticated: boolean;
  envApplied: boolean;
  pluginsRecreated: boolean;
  pluginsVerified: boolean;
  pluginsRestored: boolean;
  candidateRevoked: boolean;
  previousKeyRevoked: boolean;
};

type ParsedAPIKey = {
  id: string;
  apiKey: string;
};

type CreatedManagedKey = {
  id: string;
  apiKey: string;
};

type ManagedKeyMetadata = {
  id: string;
  name: string;
};

/**
 * Owns the Core machine credential lifecycle while keeping the secret out of
 * command arguments, transaction journals, and diagnostics.
 */
export class ManagedPluginCredentials {
  readonly #configDir: string;
  readonly #host: ManagedPluginCredentialHost;
  readonly #dockerEngineId: string;
  readonly #now: () => Date;
  #transactions: DeploymentTransactionStore | undefined;

  constructor(options: ManagedPluginCredentialsOptions) {
    this.#configDir = options.configDir;
    this.#host = options.host;
    this.#dockerEngineId = options.dockerEngineId;
    this.#now = options.now ?? (() => new Date());
    this.#transactions = options.transactions;
  }

  /**
   * Ensures the shared Plugin key inside a transaction already advanced to
   * Core-started. Init and Core update deliberately retain that phase because
   * their transaction has an irreversible Core image boundary of its own.
   */
  async ensureWithinTransaction(): Promise<void> {
    const transactions = this.#requireTransactions();
    const journal = transactions.read();
    if (journal.operation !== "init" && journal.operation !== "core-update") {
      throw new Error("Managed Plugin credentials require an init or Core update transaction.");
    }
    this.#assertCredentialPhase(journal.phase);
    await this.#ensure(transactions, false);
  }

  /** Rotates the shared Plugin key in a transaction owned by this operation. */
  async rotate(): Promise<void> {
    if (this.#transactions) {
      throw new Error("Cannot start managed-key rotation while another deployment transaction is pending.");
    }

    const previousRunning = await this.#host.isRunning();
    const desiredRunning = readDesiredRunning(this.#configDir, previousRunning);
    const transactions = DeploymentTransactionStore.begin(this.#configDir, {
      operation: "plugin-key-rotation",
      dockerEngineId: this.#dockerEngineId,
      previousRunning,
      desiredRunning,
      now: this.#now()
    });
    this.#transactions = transactions;

    try {
      // Standalone key rotation does not replace the Core image or migrate
      // storage. Keep it rollback-capable until the candidate .env is durable.
      transactions.advance("runtime-changing");
      if (!previousRunning) {
        await this.#host.startBase(false);
      }
      await this.#ensure(transactions, true);
      if (!desiredRunning) await this.#host.stopBase();
      transactions.markCommitted();
      transactions.cleanup();
      this.#transactions = undefined;
    } catch (error) {
      const phase = transactions.read().phase;
      if (phase === "prepared" || phase === "runtime-changing") {
        try {
          await this.#withRecovery(() => this.#rollbackStandaloneRotation(transactions));
        } catch {
          // Keep the transaction for recover to finish the compensating work.
          this.#transactions = transactions;
        }
      } else {
        // A credentials-durable rotation must finish forward; no rollback can
        // bring back a revoked key or make the candidate secret available.
        this.#transactions = transactions;
      }
      throw safeCredentialError("Managed Plugin key rotation did not complete", error);
    }
  }

  /** Resumes the pending credential operation according to its durable phase. */
  async recover(): Promise<void> {
    const transactions = this.#transactions ?? DeploymentTransactionStore.open(this.#configDir);
    this.#transactions = transactions;
    const journal = transactions.read();

    if (
      journal.operation !== "plugin-key-rotation" &&
      journal.operation !== "init" &&
      journal.operation !== "core-update"
    ) {
      throw new Error("Pending transaction does not own managed Plugin credentials.");
    }
    if (journal.phase === "committed") {
      transactions.cleanup();
      this.#transactions = undefined;
      return;
    }

    if (
      journal.operation === "plugin-key-rotation" &&
      (journal.phase === "prepared" || journal.phase === "runtime-changing" || journal.phase === "rollback-complete")
    ) {
      await this.#withRecovery(() => this.#rollbackStandaloneRotation(transactions));
      return;
    }
    if (journal.phase === "rollback-complete") {
      transactions.cleanup();
      this.#transactions = undefined;
      return;
    }

    this.#assertCredentialPhase(journal.phase);
    let desiredRunning = journal.desiredRunning;
    if (journal.operation === "plugin-key-rotation") {
      const running = await this.#host.isRunning();
      desiredRunning = readDesiredRunning(this.#configDir, journal.desiredRunning);
      if (!running) {
        const phase = transactions.read().phase;
        if (phase === "prepared" || phase === "runtime-changing") transactions.advance("core-started");
        await this.#host.startBase(journal.previousRunning);
      }
    }

    await this.#ensure(transactions, journal.operation === "plugin-key-rotation");
    const updated = transactions.read();
    if (updated.operation === "plugin-key-rotation" && !desiredRunning) {
      await this.#host.stopBase();
    }
    if (updated.operation === "plugin-key-rotation") {
      transactions.markCommitted();
      transactions.cleanup();
      this.#transactions = undefined;
    }
  }

  async #ensure(transactions: DeploymentTransactionStore, forceRotation: boolean): Promise<void> {
    const transaction = transactions.read();
    const standaloneRotation = transaction.operation === "plugin-key-rotation";
    const recreateSDKPlugins = !standaloneRotation || transaction.previousRunning;
    let intent = this.#readIntent(transactions);
    if (!intent) {
      let previous: ParsedAPIKey | undefined;
      try {
        previous = readCurrentAPIKey(this.#configDir);
      } catch (error) {
        if (!(error instanceof InvalidManagedPluginKeyError)) throw error;
      }
      if (previous && !forceRotation) {
        try {
          await this.#authenticate(previous.apiKey);
          return;
        } catch (error) {
          if (!(error instanceof ManagedPluginKeyRejectedError)) throw error;
        }
      }
      intent = this.#newIntent(transactions, previous?.id);
      this.#persistIntent(transactions, intent);
    }

    const candidate = await this.#resumeOrCreateCandidate(transactions, intent);
    intent = candidate.intent;

    if (!intent.candidateAuthenticated) {
      await this.#authenticate(candidate.apiKey);
      intent = { ...intent, candidateAuthenticated: true };
      this.#persistIntent(transactions, intent);
    }

    if (!intent.envApplied) {
      const current = readEnvFile(this.#configDir);
      const next = replacePluginKey(current, candidate.apiKey);
      transactions.stage(ENV_FILE, next, { mode: 0o600 });
      if (!standaloneRotation) {
        transactions.applyStaged(ENV_FILE);
        intent = { ...intent, envApplied: true };
        this.#persistIntent(transactions, intent);
      }
    }

    if (recreateSDKPlugins && !intent.pluginsVerified) {
      if (standaloneRotation && !intent.pluginsRecreated) {
        intent = { ...intent, pluginsRecreated: true, pluginsRestored: false };
        this.#persistIntent(transactions, intent);
      }
      await this.#host.recreateSDKPlugins(standaloneRotation ? candidate.apiKey : undefined);
      await this.#host.verifySDKPlugins();
      intent = { ...intent, pluginsVerified: true };
      this.#persistIntent(transactions, intent);
    }

    if (standaloneRotation) {
      if (!intent.envApplied) {
        transactions.applyStaged(ENV_FILE);
        intent = { ...intent, envApplied: true };
        this.#persistIntent(transactions, intent);
      }
      const phase = transactions.read().phase;
      if (phase === "runtime-changing" || phase === "core-started") {
        transactions.advance("credentials-durable");
      }
    }

    if (!intent.previousKeyRevoked && intent.previousKeyId && intent.previousKeyId !== candidate.id) {
      await this.#revoke(intent.previousKeyId);
      intent = { ...intent, previousKeyRevoked: true };
      this.#persistIntent(transactions, intent);
    } else if (!intent.previousKeyRevoked) {
      intent = { ...intent, previousKeyRevoked: true };
      this.#persistIntent(transactions, intent);
    }
  }

  async #resumeOrCreateCandidate(
    transactions: DeploymentTransactionStore,
    intent: CredentialIntent
  ): Promise<{ intent: CredentialIntent; apiKey: string; id: string }> {
    if (intent.candidateKeyId) {
      let current: ParsedAPIKey | undefined;
      try {
        current = readCurrentAPIKey(this.#configDir);
      } catch (error) {
        if (!(error instanceof InvalidManagedPluginKeyError)) throw error;
      }
      if (current?.id === intent.candidateKeyId && intent.candidateAuthenticated) {
        try {
          await this.#authenticate(current.apiKey);
          return { intent, apiKey: current.apiKey, id: current.id };
        } catch (error) {
          if (!(error instanceof ManagedPluginKeyRejectedError)) throw error;
        }
      }
      if (current?.id === intent.candidateKeyId && !intent.candidateAuthenticated) {
        return { intent, apiKey: current.apiKey, id: current.id };
      }
    }

    await this.#revokeAttemptMatches(intent.attemptName);
    const nextAttempt = intent.attempt + 1;
    const { candidateKeyId: _candidateKeyID, ...intentWithoutCandidate } = intent;
    const nextIntent: CredentialIntent = {
      ...intentWithoutCandidate,
      attempt: nextAttempt,
      attemptName: attemptName(transactions.id, nextAttempt),
      candidateAuthenticated: false,
      envApplied: false,
      pluginsRecreated: false,
      pluginsVerified: false,
      pluginsRestored: false,
      candidateRevoked: false
    };
    this.#persistIntent(transactions, nextIntent);

    const created = await this.#create(nextIntent.attemptName);
    const persistedCandidate: CredentialIntent = {
      ...nextIntent,
      candidateKeyId: created.id
    };
    this.#persistIntent(transactions, persistedCandidate);
    return { intent: persistedCandidate, apiKey: created.apiKey, id: created.id };
  }

  async #revokeAttemptMatches(name: string): Promise<void> {
    const response = parseManagedKeyList(await this.#runManagedKeys("list", name));
    for (const key of response) {
      if (key.name === name) await this.#revoke(key.id);
    }
  }

  async #create(name: string): Promise<CreatedManagedKey> {
    const response = parseManagedKeyObject(await this.#runManagedKeys("create", name));
    const apiKey = readString(response, "api_key");
    const parsed = parseAPIKey(apiKey);
    const responseID = readString(response, "id");
    if (responseID !== parsed.id || readString(response, "name") !== name) {
      throw new Error("Core returned an invalid managed-key identity.");
    }
    return { id: parsed.id, apiKey: parsed.apiKey };
  }

  async #revoke(keyID: string): Promise<void> {
    try {
      await this.#runManagedKeys("revoke", keyID);
    } catch (error) {
      throw safeCredentialError("Core could not revoke the previous managed Plugin key", error);
    }
  }

  async #authenticate(apiKey: string): Promise<void> {
    try {
      await this.#host.authenticateKey(apiKey);
    } catch (error) {
      if (error instanceof ManagedPluginKeyRejectedError) throw error;
      throw safeCredentialError("The managed Plugin key was rejected by Core", error);
    }
  }

  async #runManagedKeys(action: ManagedKeyAction, value: string): Promise<unknown> {
    try {
      return await this.#host.runManagedKeys(action, value);
    } catch (error) {
      throw safeCredentialError(`Core managed-key ${action} failed`, error);
    }
  }

  #newIntent(transactions: DeploymentTransactionStore, previousKeyId: string | undefined): CredentialIntent {
    return {
      schema: CREDENTIAL_INTENT_SCHEMA,
      operation: transactions.journal.operation,
      transactionId: transactions.id,
      attempt: 0,
      attemptName: attemptName(transactions.id, 0),
      ...(previousKeyId ? { previousKeyId } : {}),
      candidateAuthenticated: false,
      envApplied: false,
      pluginsRecreated: false,
      pluginsVerified: false,
      pluginsRestored: false,
      candidateRevoked: false,
      previousKeyRevoked: false
    };
  }

  /**
   * Restores pre-rotation files and the old SDK runtime while the transaction
   * remains pending. Cleanup is deliberately last so a failed compensation
   * leaves enough intent to retry the missing work.
   */
  async #rollbackStandaloneRotation(transactions: DeploymentTransactionStore): Promise<void> {
    const initial = transactions.read();
    if (initial.phase !== "rollback-complete") transactions.rollback();

    const journal = transactions.read();
    let intent = this.#readIntent(transactions);
    const desiredRunning = readDesiredRunning(this.#configDir, journal.desiredRunning);
    const shouldRun = journal.previousRunning && desiredRunning;
    let compensationError: unknown;

    try {
      let running = await this.#host.isRunning();
      if (intent && !intent.candidateRevoked) {
        // Core must be running for managed-key revoke. A stopped deployment
        // may therefore need a temporary base start before its final stop.
        if (!running) {
          await this.#host.startBase(journal.previousRunning);
          running = true;
        }
        if (intent.candidateKeyId) await this.#revoke(intent.candidateKeyId);
        else await this.#revokeAttemptMatches(intent.attemptName);
        intent = { ...intent, candidateRevoked: true };
        this.#persistIntent(transactions, intent);
      }

      if (shouldRun && intent?.pluginsRecreated && !intent.pluginsRestored) {
        if (!running) await this.#host.startBase(journal.previousRunning);
        await this.#host.restoreSDKPlugins();
        intent = { ...intent, pluginsRestored: true };
        this.#persistIntent(transactions, intent);
      }
    } catch (error) {
      compensationError = error;
    } finally {
      if (!shouldRun) {
        // This removes partially-created candidate services and preserves an
        // explicit stop intent even when revoke or restoration failed.
        try {
          await this.#host.stopBase();
        } catch (error) {
          compensationError ??= error;
        }
      }
    }

    if (compensationError) throw compensationError;

    transactions.cleanup();
    this.#transactions = undefined;
  }

  async #withRecovery<T>(operation: () => Promise<T>): Promise<T> {
    return this.#host.withRecovery(operation);
  }

  #readIntent(transactions: DeploymentTransactionStore): CredentialIntent | undefined {
    const journal = transactions.read();
    if (!journal.staged[CREDENTIAL_INTENT_FILE]) return undefined;
    return parseCredentialIntent(transactions.readStaged(CREDENTIAL_INTENT_FILE), transactions);
  }

  #persistIntent(transactions: DeploymentTransactionStore, intent: CredentialIntent): void {
    // Keep this object secret-free. Transaction stage fsyncs the bytes and its containing directory.
    transactions.stage(CREDENTIAL_INTENT_FILE, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
  }

  #requireTransactions(): DeploymentTransactionStore {
    if (!this.#transactions) throw new Error("Managed Plugin credentials require an active transaction.");
    return this.#transactions;
  }

  #assertCredentialPhase(phase: TransactionPhase): void {
    if (
      phase !== "prepared" &&
      phase !== "runtime-changing" &&
      phase !== "core-started" &&
      phase !== "credentials-durable"
    ) {
      throw new Error(`Managed Plugin credentials cannot resume from transaction phase ${phase}.`);
    }
  }
}

function attemptName(transactionID: string, attempt: number): string {
  return `${KEY_ATTEMPT_PREFIX}-${transactionID}-${attempt}`;
}

function readEnvFile(configDir: string): string {
  const path = join(configDir, ENV_FILE);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("Atlas Core configuration is missing .env.");
    if (code === "ELOOP") throw new Error("Atlas Core .env must be a regular file.");
    throw error;
  }
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Atlas Core .env must be a regular file.");
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function readCurrentAPIKey(configDir: string): ParsedAPIKey | undefined {
  const contents = readEnvFile(configDir);
  const line = contents.split(/\r?\n/u).find((candidate) => candidate.startsWith(`${PLUGIN_API_KEY}=`));
  if (!line) return undefined;
  const raw = line.slice(PLUGIN_API_KEY.length + 1).trim();
  if (!raw) return undefined;
  return parseAPIKey(unquoteEnvValue(raw));
}

function replacePluginKey(contents: string, apiKey: string): string {
  const lines = contents.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.startsWith(`${PLUGIN_API_KEY}=`));
  if (index >= 0) {
    lines[index] = `${PLUGIN_API_KEY}=${apiKey}`;
    return lines.join("\n");
  }
  return `${contents}${contents.endsWith("\n") ? "" : "\n"}${PLUGIN_API_KEY}=${apiKey}\n`;
}

function unquoteEnvValue(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseAPIKey(value: string): ParsedAPIKey {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(".", separator + 1) >= 0) {
    throw new InvalidManagedPluginKeyError();
  }
  const id = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!isManagedKeyID(id) || /[\s\0]/u.test(secret)) throw new InvalidManagedPluginKeyError();
  return { id, apiKey: `${id}.${secret}` };
}

class InvalidManagedPluginKeyError extends Error {
  constructor() {
    super("Core returned an invalid managed-key value.");
    this.name = "InvalidManagedPluginKeyError";
  }
}

function parseManagedKeyObject(value: unknown): Record<string, unknown> {
  const parsed = parseManagedKeyOutput(value);
  if (!isRecord(parsed)) throw new Error("Core returned invalid managed-key JSON.");
  return parsed;
}

function parseManagedKeyList(value: unknown): ManagedKeyMetadata[] {
  const parsed = parseManagedKeyOutput(value);
  if (!Array.isArray(parsed)) throw new Error("Core returned invalid managed-key list JSON.");
  const result: ManagedKeyMetadata[] = [];
  for (const value of parsed) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
      throw new Error("Core returned invalid managed-key list JSON.");
    }
    if (!isManagedKeyID(value.id)) throw new Error("Core returned invalid managed-key list JSON.");
    result.push({ id: value.id, name: value.name });
  }
  return result;
}

function parseManagedKeyOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Core returned invalid managed-key JSON.");
  }
}

function parseCredentialIntent(contents: Buffer, transactions: DeploymentTransactionStore): CredentialIntent {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new Error("Managed Plugin credential intent is invalid.");
  }
  if (!isRecord(value)) throw new Error("Managed Plugin credential intent is invalid.");
  if (
    value.schema !== CREDENTIAL_INTENT_SCHEMA ||
    value.transactionId !== transactions.id ||
    typeof value.operation !== "string" ||
    typeof value.attemptName !== "string" ||
    typeof value.attempt !== "number" ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 0 ||
    typeof value.candidateAuthenticated !== "boolean" ||
    typeof value.envApplied !== "boolean" ||
    typeof value.pluginsRecreated !== "boolean" ||
    typeof value.pluginsVerified !== "boolean" ||
    typeof value.pluginsRestored !== "boolean" ||
    typeof value.candidateRevoked !== "boolean" ||
    typeof value.previousKeyRevoked !== "boolean"
  ) {
    throw new Error("Managed Plugin credential intent is invalid.");
  }
  if (
    value.operation !== transactions.journal.operation ||
    value.attemptName !== attemptName(transactions.id, value.attempt)
  ) {
    throw new Error("Managed Plugin credential intent is invalid.");
  }
  if (value.previousKeyId !== undefined && typeof value.previousKeyId !== "string") {
    throw new Error("Managed Plugin credential intent is invalid.");
  }
  if (value.candidateKeyId !== undefined && typeof value.candidateKeyId !== "string") {
    throw new Error("Managed Plugin credential intent is invalid.");
  }
  if (
    (value.previousKeyId !== undefined && !isManagedKeyID(value.previousKeyId)) ||
    (value.candidateKeyId !== undefined && !isManagedKeyID(value.candidateKeyId))
  ) {
    throw new Error("Managed Plugin credential intent is invalid.");
  }
  return {
    schema: value.schema,
    operation: transactions.journal.operation,
    transactionId: transactions.id,
    attempt: value.attempt,
    attemptName: value.attemptName,
    ...(value.previousKeyId === undefined ? {} : { previousKeyId: value.previousKeyId }),
    ...(value.candidateKeyId === undefined ? {} : { candidateKeyId: value.candidateKeyId }),
    candidateAuthenticated: value.candidateAuthenticated,
    envApplied: value.envApplied,
    pluginsRecreated: value.pluginsRecreated,
    pluginsVerified: value.pluginsVerified,
    pluginsRestored: value.pluginsRestored,
    candidateRevoked: value.candidateRevoked,
    previousKeyRevoked: value.previousKeyRevoked
  };
}

function readString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) throw new Error("Core returned invalid managed-key JSON.");
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManagedKeyID(value: string): boolean {
  return /^atlas_ak_[A-Za-z0-9_-]{16}$/u.test(value);
}

function readDesiredRunning(configDir: string, fallback: boolean): boolean {
  const path = join(configDir, "run-intent.json");
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    if (code === "ELOOP") throw new Error("Atlas Core run intent must be a regular file.");
    throw error;
  }
  let value: unknown;
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Atlas Core run intent must be a regular file.");
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  try {
    value = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
  } catch {
    throw new Error("Atlas Core run intent is invalid.");
  } finally {
    closeSync(descriptor);
  }
  if (!isRecord(value) || typeof value.desiredRunning !== "boolean")
    throw new Error("Atlas Core run intent is invalid.");
  return value.desiredRunning;
}

function safeCredentialError(message: string, _cause: unknown): Error {
  // Never include command output or host errors: either may contain the one-time secret.
  return new Error(message);
}
