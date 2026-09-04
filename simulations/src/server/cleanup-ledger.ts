import type { Stats } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { isCreatedResource } from "../shared/types.js";
import { isDeployedAtlasUrl } from "./config.js";
import { MAX_CREATED_RESOURCES_PER_RUN } from "./run-store-limits.js";
import type { CleanupResource } from "./run-store-types.js";

const LEDGER_VERSION = 2;
const MAX_LEDGER_BYTES = 16_000_000;

export type CleanupLedgerTarget = {
  id: string;
  label: string;
  baseUrl: string;
};

export type CleanupLedgerRecord = {
  runId: string;
  scenarioId: string;
  scenarioName: string;
  startedAt: string;
  target: CleanupLedgerTarget;
  resources: CleanupResource[];
};

type CleanupLedgerFile = {
  version: typeof LEDGER_VERSION;
  run: CleanupLedgerRecord;
};

export interface CleanupLedgerStore {
  load(): CleanupLedgerRecord[];
  save(record: CleanupLedgerRecord): void;
  remove(runId: string): void;
}

export class CleanupLedger implements CleanupLedgerStore {
  constructor(private readonly directory: string) {}

  load(): CleanupLedgerRecord[] {
    const directory = secureLedgerDirectory(this.directory, false);
    if (!directory) return [];
    return ledgerFiles(directory).map(({ filePath, runId }) => readRecord(filePath, runId));
  }

  save(record: CleanupLedgerRecord): void {
    const validated = validateRecord(record);
    const directory = secureLedgerDirectory(this.directory, true)!;
    const filePath = recordPath(directory, validated.runId);
    const existing = entryStat(filePath);
    if (existing) assertRegularFile(filePath, existing);
    const data = `${JSON.stringify({ version: LEDGER_VERSION, run: validated } satisfies CleanupLedgerFile)}\n`;
    if (Buffer.byteLength(data, "utf8") > MAX_LEDGER_BYTES) throw new Error("Cleanup ledger record is too large");
    const temporaryPath = path.join(
      directory,
      `.${validated.runId}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, data, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, filePath);
      syncDirectory(directory);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  remove(runId: string): void {
    if (!validRunId(runId)) throw new Error("Cleanup ledger run ID is invalid");
    const directory = secureLedgerDirectory(this.directory, false);
    if (!directory) return;
    const filePath = recordPath(directory, runId);
    const existing = entryStat(filePath);
    if (!existing) return;
    assertRegularFile(filePath, existing);
    unlinkSync(filePath);
    syncDirectory(directory);
  }
}

function readRecord(filePath: string, expectedRunId: string): CleanupLedgerRecord {
  assertRegularFile(filePath);
  let descriptor: number | undefined;
  let raw = "";
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Cleanup ledger record must be a regular file");
    if (stat.size > MAX_LEDGER_BYTES) throw new Error("Cleanup ledger record is too large");
    fchmodSync(descriptor, 0o600);
    raw = readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Cleanup ledger record must contain valid JSON");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["version", "run"]) || parsed.version !== LEDGER_VERSION) {
    throw new Error("Cleanup ledger record has an unsupported schema");
  }
  const record = validateRecord(parsed.run);
  if (record.runId !== expectedRunId) throw new Error(`Cleanup ledger filename does not match run ${record.runId}`);
  return record;
}

function ledgerFiles(directory: string): Array<{ filePath: string; runId: string }> {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => {
      const match = /^(sim-[a-z0-9]+-[a-z0-9]+)\.json$/.exec(entry.name);
      if (!match) throw new Error(`Cleanup ledger contains unsupported filename ${entry.name}`);
      const filePath = path.join(directory, entry.name);
      if (!entry.isFile()) throw new Error("Cleanup ledger record must be a regular file");
      assertRegularFile(filePath);
      return { filePath, runId: match[1] };
    })
    .sort((left, right) => left.runId.localeCompare(right.runId));
  return files;
}

function recordPath(directory: string, runId: string): string {
  return path.join(directory, `${runId}.json`);
}

function validateRecord(value: unknown): CleanupLedgerRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["runId", "scenarioId", "scenarioName", "startedAt", "target", "resources"]) ||
    !validRunId(value.runId) ||
    !nonEmptyString(value.scenarioId) ||
    !nonEmptyString(value.scenarioName) ||
    !validTimestamp(value.startedAt) ||
    !validTarget(value.target) ||
    !Array.isArray(value.resources)
  ) {
    throw new Error("Cleanup ledger contains an invalid run record");
  }
  if (value.resources.length > MAX_CREATED_RESOURCES_PER_RUN + 1) {
    throw new Error(`Cleanup ledger run ${value.runId} contains too many resources`);
  }
  const resources: CleanupResource[] = [];
  const seen = new Set<string>();
  const seenTokens = new Set<string>();
  for (const resource of value.resources) {
    if (
      !isCleanupResource(resource) ||
      !validInstanceToken(resource.instanceToken) ||
      !resource.id.startsWith(`${value.runId}-`)
    ) {
      throw new Error(`Cleanup ledger run ${value.runId} contains a resource outside its run ID prefix`);
    }
    const key = `${resource.type}\0${resource.id}`;
    if (seen.has(key)) throw new Error(`Cleanup ledger run ${value.runId} contains duplicate resources`);
    if (seenTokens.has(resource.instanceToken)) {
      throw new Error(`Cleanup ledger run ${value.runId} contains duplicate instance tokens`);
    }
    seen.add(key);
    seenTokens.add(resource.instanceToken);
    resources.push({ type: resource.type, id: resource.id, instanceToken: resource.instanceToken });
  }
  return {
    runId: value.runId,
    scenarioId: value.scenarioId,
    scenarioName: value.scenarioName,
    startedAt: value.startedAt,
    target: {
      id: value.target.id,
      label: value.target.label,
      baseUrl: value.target.baseUrl
    },
    resources
  };
}

function isCleanupResource(value: unknown): value is CleanupResource {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "id", "instanceToken"]) &&
    isCreatedResource(value) &&
    typeof (value as { instanceToken?: unknown }).instanceToken === "string"
  );
}

function validInstanceToken(value: string): boolean {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 256 || value.trim() !== value) return false;
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint >= 0x20 && codePoint !== 0x7f;
  });
}

function validTarget(value: unknown): value is CleanupLedgerTarget {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "label", "baseUrl"])) return false;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.label) || !nonEmptyString(value.baseUrl)) return false;
  try {
    const parsed = new URL(value.baseUrl);
    return (
      parsed.protocol === "https:" &&
      isDeployedAtlasUrl(value.baseUrl) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function secureLedgerDirectory(directory: string, create: boolean): string | undefined {
  const resolved = path.resolve(directory);
  const stat = entryStat(resolved);
  let firstCreated: string | undefined;
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Cleanup ledger directory must be a real directory");
  } else if (create) {
    firstCreated = mkdirSync(resolved, { recursive: true, mode: 0o700 });
  } else {
    return undefined;
  }
  const secured = entryStat(resolved);
  if (!secured || secured.isSymbolicLink() || !secured.isDirectory()) {
    throw new Error("Cleanup ledger directory must be a real directory");
  }
  chmodSync(resolved, 0o700);
  if (firstCreated) syncCreatedDirectoryEntries(resolved, path.dirname(firstCreated));
  return resolved;
}

function assertRegularFile(filePath: string, stat = lstatSync(filePath)): Stats {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Cleanup ledger record must be a regular file");
  return stat;
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncCreatedDirectoryEntries(directory: string, existingParent: string): void {
  let current = directory;
  while (current !== existingParent) {
    current = path.dirname(current);
    syncDirectory(current);
  }
}

function entryStat(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    expected
      .slice()
      .sort()
      .every((key, index) => keys[index] === key)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validRunId(value: unknown): value is string {
  return typeof value === "string" && /^sim-[a-z0-9]+-[a-z0-9]+$/.test(value);
}
