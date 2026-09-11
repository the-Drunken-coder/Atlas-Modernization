import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import {
  assertPluginCompatible,
  comparePluginVersions,
  fetchBounded,
  type PluginCatalogRelease,
  type PluginContracts,
  type PluginRelease,
  type PluginReleaseCandidate,
  type PluginTrust,
  parsePluginRelease,
  parseStrictJsonBytes,
  type SignedCatalogReceipt,
  verifyCatalog
} from "./plugin-distribution.js";

const CATALOG_LIMIT = 4 << 20;
const SIGNATURE_LIMIT = 1 << 10;
const RELEASE_LIMIT = 1 << 20;
// catalog_bytes_base64 expands a 4 MiB catalog to 5,592,408 bytes. Leave
// room for the detached signature and bounded receipt metadata too, without
// allowing a state file to grow without relation to the authenticated inputs.
const STATE_METADATA_LIMIT = 32 << 10;
const STATE_LIMIT = Math.ceil(CATALOG_LIMIT / 3) * 4 + Math.ceil(SIGNATURE_LIMIT / 3) * 4 + STATE_METADATA_LIMIT;
const DEFAULT_RELEASE_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com"
] as const;

export type PluginCatalogStoreOptions = {
  configDir: string;
  catalogURL: string;
  trust: PluginTrust;
  fetch?: typeof fetch;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type PluginCatalogCandidatesOptions = {
  /** Filter release documents before downloading them. */
  contracts?: PluginContracts;
  /** Request one exact stable release version. */
  version?: string;
  /** Current installed version; preserve its revoked catalog entry for remediation. */
  currentVersion?: string;
  /** Exact locally retained release bytes for a revoked current version. */
  currentRelease?: PluginRelease;
};

type PersistedCatalogState = {
  schema: 1;
  sequence: number;
  catalog_sha256: string;
  key_epoch: number;
  key_id: string;
  issued_at: string;
  expires_at: string;
  catalog_bytes_base64: string;
  signature_bytes_base64: string;
  observed_at: string;
};

class RetiredCatalogReceiptError extends Error {
  readonly keyEpoch: number;
  readonly observedAt: Date;

  constructor(keyEpoch: number, observedAt: Date) {
    super("The stored Plugin catalog was signed by a retired key");
    this.name = "RetiredCatalogReceiptError";
    this.keyEpoch = keyEpoch;
    this.observedAt = observedAt;
  }
}

/** Owns the verified catalog receipt. It never returns an unverified static or bundled catalog. */
export class PluginCatalogStore {
  readonly #configDir: string;
  readonly #statePath: string;
  readonly #catalogURL: string;
  readonly #trust: PluginTrust;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => Date;
  readonly #allowedHosts: readonly string[];

  constructor(options: PluginCatalogStoreOptions) {
    this.#configDir = resolve(options.configDir);
    this.#statePath = join(this.#configDir, "catalog-state.json");
    this.#catalogURL = options.catalogURL;
    this.#trust = options.trust;
    this.#fetchImpl = options.fetchImpl ?? options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    let catalogHost: string;
    try {
      const url = new URL(this.#catalogURL);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
      catalogHost = url.hostname.toLowerCase();
    } catch {
      throw new Error("Plugin catalog URL must be an HTTPS URL without credentials, query, or fragment");
    }
    this.#allowedHosts = [
      ...new Set(
        [catalogHost, ...DEFAULT_RELEASE_HOSTS, ...(options.trust.allowedRedirectHosts ?? [])].map((host) =>
          host.toLowerCase()
        )
      )
    ];
  }

  /** Refresh mutates the monotonic receipt and must run under the deployment coordinator lock. */
  async refresh(options: { allowCachedOnFailure?: boolean } = {}): Promise<SignedCatalogReceipt> {
    // A cached receipt below a newly embedded checkpoint is still needed as
    // authenticated history for the next refresh. Fresh network acceptance
    // below the checkpoint remains fail-closed in verifyCatalog.
    let previous: { receipt: SignedCatalogReceipt; observedAt: Date } | undefined;
    let retiredObservedAt: Date | undefined;
    let retiredKeyEpoch: number | undefined;
    try {
      previous = this.#readStoredReceipt(true, true);
    } catch (error) {
      if (!(error instanceof RetiredCatalogReceiptError)) throw error;
      retiredKeyEpoch = error.keyEpoch;
      retiredObservedAt = error.observedAt;
    }
    const current = this.#observedNow(previous?.observedAt ?? retiredObservedAt);
    if (previous && current.getTime() > previous.observedAt.getTime()) this.#writeState(previous.receipt, current);
    let receipt: SignedCatalogReceipt;
    try {
      const catalogBytes = await fetchBounded(this.#catalogURL, {
        maxBytes: CATALOG_LIMIT,
        allowedHosts: this.#allowedHosts,
        fetchImpl: this.#fetchImpl
      });
      const signatureBytes = await fetchBounded(`${this.#catalogURL}.sig`, {
        maxBytes: SIGNATURE_LIMIT,
        allowedHosts: this.#allowedHosts,
        fetchImpl: this.#fetchImpl
      });
      receipt = verifyCatalog(catalogBytes, signatureBytes, this.#trust, previous?.receipt, current);
      if (retiredKeyEpoch !== undefined && receipt.keyEpoch <= retiredKeyEpoch) {
        throw new Error("The refreshed Plugin catalog must use a newer signing-key epoch than the retired receipt");
      }
    } catch (error) {
      if (options.allowCachedOnFailure) {
        try {
          return this.read();
        } catch {
          // Missing, expired, or no-longer-trusted cache cannot admit a mutation.
        }
      }
      throw error;
    }
    const observedAt = maxDate(current, previous?.observedAt ?? retiredObservedAt);
    this.#writeState(receipt, observedAt);
    return receipt;
  }

  /** Read advances observed_at when needed; callers must hold the deployment coordinator lock. */
  read(): SignedCatalogReceipt {
    const stored = this.#readStoredReceipt(true);
    if (!stored) throw new Error("No verified Plugin catalog is installed. Run atlas-core plugins refresh and retry.");
    const current = this.#observedNow(stored.observedAt);
    if (current.getTime() > stored.observedAt.getTime()) this.#writeState(stored.receipt, current);
    if (Date.parse(stored.receipt.expiresAt) <= current.getTime())
      throw new Error("The Plugin catalog is expired; run atlas-core plugins refresh and retry.");
    return stored.receipt;
  }

  /** Inspect authenticated history, including expiry, without admitting mutations or writing observed_at. */
  inspect(): SignedCatalogReceipt & { expired: boolean } {
    const stored = this.#readStoredReceipt(true);
    if (!stored) throw new Error("No verified Plugin catalog is installed. Run atlas-core plugins refresh and retry.");
    const observedAt = this.#observedNow(stored.observedAt);
    return {
      ...stored.receipt,
      expired: Date.parse(stored.receipt.expiresAt) <= observedAt.getTime()
    };
  }

  async candidates(pluginId: string, options: PluginCatalogCandidatesOptions = {}): Promise<PluginReleaseCandidate[]> {
    const catalog = this.read().catalog;
    const plugin = catalog.plugins.find((entry) => entry.pluginId === pluginId);
    if (!plugin) return [];
    if (options.version !== undefined) validateVersion(options.version, "version");
    if (options.currentVersion !== undefined) validateVersion(options.currentVersion, "currentVersion");
    const releases = [...plugin.releases].sort((left, right) => comparePluginVersions(right.version, left.version));
    const candidates: PluginReleaseCandidate[] = [];
    const currentRevoked =
      options.currentVersion === undefined
        ? undefined
        : releases.find((release) => release.version === options.currentVersion && release.revoked === true);
    if (currentRevoked && (options.version === undefined || options.version === currentRevoked.version)) {
      candidates.push(
        options.currentRelease
          ? this.#candidateFromRelease(pluginId, currentRevoked, options.currentRelease)
          : await this.#downloadCandidate(pluginId, currentRevoked)
      );
    }
    for (const catalogRelease of releases) {
      if (catalogRelease === currentRevoked) continue;
      if (options.version !== undefined && catalogRelease.version !== options.version) continue;
      // Revocation is authenticated by the catalog. Constrained selection fetches a revoked
      // document only when it is the installed release; an unconstrained caller receives the
      // complete candidate set for its own policy and inspection.
      if (
        catalogRelease.revoked &&
        (options.contracts !== undefined || options.version !== undefined || options.currentVersion !== undefined)
      )
        continue;
      const candidate = await this.#downloadCandidate(pluginId, catalogRelease);
      if (options.contracts !== undefined) {
        try {
          assertPluginCompatible(candidate.release, options.contracts);
        } catch {
          continue;
        }
      }
      candidates.push(candidate);
      if (options.version !== undefined) break;
      if (
        options.contracts !== undefined ||
        (options.currentVersion !== undefined &&
          comparePluginVersions(catalogRelease.version, options.currentVersion) > 0)
      )
        break;
    }
    return candidates;
  }

  async #downloadCandidate(pluginId: string, catalogRelease: PluginCatalogRelease): Promise<PluginReleaseCandidate> {
    const bytes = await fetchBounded(catalogRelease.documentUrl, {
      maxBytes: RELEASE_LIMIT,
      allowedHosts: this.#allowedHosts,
      fetchImpl: this.#fetchImpl
    });
    if (sha256(bytes) !== catalogRelease.documentSha256) {
      throw new Error(`Plugin ${pluginId} ${catalogRelease.version} release document hash does not match the catalog`);
    }
    const release = parsePluginRelease(bytes);
    if (
      release.pluginId !== pluginId ||
      release.version !== catalogRelease.version ||
      release.displayName !== catalogRelease.displayName
    ) {
      throw new Error(`Plugin ${pluginId} ${catalogRelease.version} release document does not match the catalog`);
    }
    return { release, catalog: catalogRelease };
  }

  #candidateFromRelease(
    pluginId: string,
    catalogRelease: PluginCatalogRelease,
    currentRelease: PluginRelease
  ): PluginReleaseCandidate {
    const release = parsePluginRelease(currentRelease.bytes);
    if (
      release.pluginId !== pluginId ||
      release.version !== catalogRelease.version ||
      release.displayName !== catalogRelease.displayName ||
      sha256(release.bytes) !== catalogRelease.documentSha256
    ) {
      throw new Error(`Plugin ${pluginId} ${catalogRelease.version} retained release does not match the catalog`);
    }
    return { release, catalog: catalogRelease };
  }

  #readStoredReceipt(
    allowExpired: boolean,
    historical = false
  ): { receipt: SignedCatalogReceipt; observedAt: Date } | undefined {
    if (!existsSync(this.#statePath)) return undefined;
    assertPrivateDirectory(this.#configDir);
    assertPrivateFile(this.#statePath);
    const stateBytes = readFileSync(this.#statePath);
    const parsed = parseStrictJsonBytes(stateBytes, STATE_LIMIT, "catalog-state.json");
    const state = persistedState(parsed);
    const catalogBytes = decodeBase64(state.catalog_bytes_base64, CATALOG_LIMIT, "catalog_bytes_base64");
    const signatureBytes = decodeBase64(state.signature_bytes_base64, SIGNATURE_LIMIT, "signature_bytes_base64");
    const observedAt = parseUtc(state.observed_at, "observed_at");
    const issuedAt = parseUtc(state.issued_at, "issued_at");
    const expiresAt = parseUtc(state.expires_at, "expires_at");
    const current = this.#observedNow(observedAt);
    const verificationNow = allowExpired
      ? new Date(Math.max(issuedAt.getTime(), Math.min(current.getTime(), expiresAt.getTime() - 1)))
      : current;
    if (
      historical &&
      !this.#trust.keys.some((key) => key.keyId === state.key_id && key.keyEpoch === state.key_epoch) &&
      this.#trust.keys.some((key) => key.keyEpoch > state.key_epoch)
    ) {
      // A later CLI may intentionally remove a compromised key. The receipt
      // still provides the local clock floor, but the fresh catalog must be
      // verified by a newer embedded key before it can replace this state.
      throw new RetiredCatalogReceiptError(state.key_epoch, observedAt);
    }
    const verificationTrust = historical ? trustForHistoricalReceipt(this.#trust) : this.#trust;
    const receipt = verifyCatalog(catalogBytes, signatureBytes, verificationTrust, undefined, verificationNow);
    if (
      receipt.sequence !== state.sequence ||
      receipt.catalogSha256 !== state.catalog_sha256 ||
      receipt.keyEpoch !== state.key_epoch ||
      receipt.keyId !== state.key_id ||
      receipt.issuedAt !== state.issued_at ||
      receipt.expiresAt !== state.expires_at ||
      receipt.catalogBytesBase64 !== state.catalog_bytes_base64 ||
      receipt.signatureBytesBase64 !== state.signature_bytes_base64
    ) {
      throw new Error("catalog-state.json does not match its authenticated catalog receipt");
    }
    return { receipt, observedAt };
  }

  #observedNow(previous: Date | undefined): Date {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("catalog clock is invalid");
    return maxDate(now, previous);
  }

  #writeState(receipt: SignedCatalogReceipt, observedAt: Date): void {
    ensurePrivateDirectory(this.#configDir);
    const state: PersistedCatalogState = {
      schema: 1,
      sequence: receipt.sequence,
      catalog_sha256: receipt.catalogSha256,
      key_epoch: receipt.keyEpoch,
      key_id: receipt.keyId,
      issued_at: receipt.issuedAt,
      expires_at: receipt.expiresAt,
      catalog_bytes_base64: receipt.catalogBytesBase64,
      signature_bytes_base64: receipt.signatureBytesBase64,
      observed_at: observedAt.toISOString()
    };
    const temporary = join(this.#configDir, `.catalog-state.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, new TextEncoder().encode(`${JSON.stringify(state)}\n`));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.#statePath);
    fsyncDirectory(this.#configDir);
  }
}

function persistedState(value: unknown): PersistedCatalogState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("catalog-state.json must be an object");
  const object = value as Record<string, unknown>;
  const keys = [
    "schema",
    "sequence",
    "catalog_sha256",
    "key_epoch",
    "key_id",
    "issued_at",
    "expires_at",
    "catalog_bytes_base64",
    "signature_bytes_base64",
    "observed_at"
  ];
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error("catalog-state.json contains missing or unknown fields");
  if (
    object.schema !== 1 ||
    !Number.isSafeInteger(object.sequence) ||
    (object.sequence as number) < 1 ||
    !Number.isSafeInteger(object.key_epoch) ||
    (object.key_epoch as number) < 1
  )
    throw new Error("catalog-state.json has invalid checkpoint fields");
  if (typeof object.catalog_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(object.catalog_sha256))
    throw new Error("catalog-state.json has an invalid catalog hash");
  if (
    typeof object.key_id !== "string" ||
    object.key_id.length === 0 ||
    typeof object.issued_at !== "string" ||
    typeof object.expires_at !== "string" ||
    typeof object.catalog_bytes_base64 !== "string" ||
    typeof object.signature_bytes_base64 !== "string" ||
    typeof object.observed_at !== "string"
  )
    throw new Error("catalog-state.json has invalid fields");
  parseUtc(object.issued_at, "issued_at");
  parseUtc(object.expires_at, "expires_at");
  parseUtc(object.observed_at, "observed_at");
  return object as PersistedCatalogState;
}

function decodeBase64(value: string, maximum: number, name: string): Uint8Array {
  const maximumEncodedLength = Math.ceil(maximum / 3) * 4;
  if (value.length > maximumEncodedLength || value.length % 4 !== 0) throw new Error(`${name} must be standard base64`);
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index++) {
    const code = value.charCodeAt(index);
    const isUpper = code >= 0x41 && code <= 0x5a;
    const isLower = code >= 0x61 && code <= 0x7a;
    const isDigit = code >= 0x30 && code <= 0x39;
    if (!isUpper && !isLower && !isDigit && code !== 0x2b && code !== 0x2f)
      throw new Error(`${name} must be standard base64`);
  }
  for (let index = contentLength; index < value.length; index++) {
    if (value[index] !== "=") throw new Error(`${name} must be standard base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value)
    throw new Error(`${name} exceeds its limit or is not canonical`);
  return new Uint8Array(bytes);
}

function parseUtc(value: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value))
    throw new Error(`${name} must be a UTC RFC 3339 timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date;
}

function validateVersion(value: string, name: string): void {
  if (typeof value !== "string") throw new Error(`${name} must be a stable Semantic Version`);
  comparePluginVersions(value, value);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function maxDate(left: Date, right: Date | undefined): Date {
  return right && right.getTime() > left.getTime() ? new Date(right.getTime()) : new Date(left.getTime());
}

function trustForHistoricalReceipt(trust: PluginTrust): PluginTrust {
  const { minimumCheckpoint: _minimumCheckpoint, ...historicalTrust } = trust;
  return historicalTrust;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path} must be a private directory`);
  chmodIfSupported(path, 0o700);
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} must be a private directory`);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`${path} must have mode 700`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} is owned by another user`);
}

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be a regular file`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${path} must have mode 600`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} is owned by another user`);
}

function chmodIfSupported(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows has no POSIX mode bits. The directory still receives an atomic path check.
  }
}

function fsyncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Directory fsync is unavailable on some supported filesystems.
  }
}
