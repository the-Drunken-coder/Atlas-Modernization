import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  BeginTransactionOptions,
  DeploymentTransactionStore,
  TransactionPhase as DurableTransactionPhase,
  TransactionOperation
} from "./deployment-transaction.js";
import { DeploymentTransactionStore as DurableDeploymentTransactionStore } from "./deployment-transaction.js";
import type { ImageReceipt } from "./image-receipts.js";
import {
  assertPluginCompatible,
  comparePluginVersions,
  type PluginCatalogRelease,
  type PluginContracts,
  type PluginRelease,
  type PluginReleaseCandidate,
  parsePluginRelease,
  parseStrictJsonBytes,
  selectPluginRelease
} from "./plugin-distribution.js";

export type PluginImageReceipt = ImageReceipt;
export type IndependentPluginRelease = PluginRelease;
export type IndependentPluginReleaseCandidate = PluginReleaseCandidate;

export type PluginLifecycleHost = {
  /** The owner-only Atlas configuration directory. */
  configDir: string;
  dockerEngineId: string;
  contracts: PluginContracts;
  readEnabled(): Promise<readonly string[]> | readonly string[];
  writeEnabled(pluginIds: readonly string[]): Promise<void> | void;
  isRunning(): Promise<boolean> | boolean;
  pullAndInspectImage(imageIndex: string): Promise<PluginImageReceipt>;
  /** Verify a previously recorded image without contacting a registry. */
  verifyImage?(receipt: PluginImageReceipt): Promise<void> | void;
  verifyRetainedBundle(): Promise<void> | void;
  /** Run Compose against the retained Core bundle. The final flag requests cleanup semantics. */
  runCompose(
    args: readonly string[],
    pluginIds: readonly string[],
    cleanup?: boolean
  ): Promise<void | { status?: number; stdout?: string; stderr?: string }>;
  verifyRuntime(release: IndependentPluginRelease, receipt?: PluginImageReceipt): Promise<void> | void;
  /** Verify the exact retained release remains trusted by the accepted catalog. */
  assertReleaseTrusted(release: IndependentPluginRelease, documentSha256: string): Promise<void> | void;
  /** Remove the plugin container while leaving downloaded image layers intact. */
  removePlugin(pluginId: string): Promise<void> | void;
  catalogFresh?(): Promise<boolean> | boolean;
  refreshCatalog?(): Promise<unknown>;
  now?: () => Date;
};

export type TransactionPhase = DurableTransactionPhase;
export type DeploymentTransaction = Pick<
  DeploymentTransactionStore,
  "snapshot" | "stage" | "advance" | "markCommitted" | "rollback" | "cleanup"
> & {
  snapshotTree?(relativeDirectory: string): readonly string[];
};
export type TransactionFactory = (
  options: Pick<BeginTransactionOptions, "operation" | "dockerEngineId" | "desiredRunning" | "previousRunning">
) => DeploymentTransaction;

export type InstalledPluginReceipt = {
  schema: 1;
  plugin_id: string;
  selected: PluginImageReceipt & {
    version: string;
    release_document_sha256: string;
  };
  previous:
    | (PluginImageReceipt & {
        version: string;
        release_document_sha256: string;
      })
    | null;
};

export type PluginListItem = {
  pluginId: string;
  displayName: string;
  installed: boolean;
  enabled: boolean;
  selected: string | null;
  previous: string | null;
  available: readonly string[];
  status: "installed" | "enabled" | "available" | "uninstalled";
};

export type PluginLifecycleOutcome = {
  pluginId: string;
  operation: "install" | "enable" | "disable" | "update" | "rollback" | "uninstall";
  changed: boolean;
  version?: string;
  previousVersion?: string | null;
  message: string;
};

const MAX_TEMPLATE_BYTES = 1_048_576;
const MAX_INSTALLED_BYTES = 64 * 1024;
const PLUGIN_ID = /^[a-z][a-z0-9_]{0,49}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const TEMPLATE_MARKER = /@atlas\/[^@\s]+@/g;
const TEMPLATE_MARKERS = new Set([
  "@atlas/plugin-id@",
  "@atlas/plugin-service@",
  "@atlas/plugin-image@",
  "@atlas/display-name@",
  "@atlas/core-endpoint-id@",
  "@atlas/core-endpoint-mount@",
  "@atlas/core-protocol-major@",
  "@atlas/core-origin@",
  "@atlas/api-auth-key@",
  "@atlas/source-gateway-protocol-major@",
  "@atlas/atlas-protocol-revision@",
  "@atlas/source-connector-mount@",
  "@atlas/source-connector-json@"
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPluginId(pluginId: string): void {
  if (!PLUGIN_ID.test(pluginId)) throw new Error(`Invalid Plugin ID ${JSON.stringify(pluginId)}.`);
}

function assertVersion(version: string): void {
  if (!VERSION.test(version)) throw new Error(`Invalid stable Plugin version ${JSON.stringify(version)}.`);
}

function releaseBytes(release: IndependentPluginRelease): Uint8Array {
  return toBytes(release.bytes);
}

function releaseDocumentHash(release: IndependentPluginRelease, candidate?: PluginCatalogRelease): string {
  const bytes = releaseBytes(release);
  const actual = sha256(bytes);
  const expected = candidate?.documentSha256;
  if (expected !== undefined && expected !== actual) {
    throw new Error(`Plugin ${release.pluginId} ${release.version} release document hash does not match its bytes.`);
  }
  return actual;
}

function receiptFor(
  release: IndependentPluginRelease,
  image: PluginImageReceipt,
  documentHash: string
): InstalledPluginReceipt["selected"] {
  if (image.image_index !== release.image)
    throw new Error("Docker returned an image index different from the release document.");
  if (!SHA256.test(image.platform_manifest_sha256) || !SHA256.test(image.local_image_id)) {
    throw new Error("Docker returned invalid image identity data.");
  }
  return {
    version: release.version,
    release_document_sha256: documentHash,
    image_index: image.image_index,
    platform_manifest_sha256: image.platform_manifest_sha256,
    local_image_id: image.local_image_id
  };
}

function serviceName(pluginId: string): string {
  return `atlas-plugin-${pluginId.replaceAll("_", "-")}`;
}

function assertSafeRelativePath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, path);
  const prefix = `${absoluteRoot}${sep}`;
  if (absolute !== absoluteRoot && !absolute.startsWith(prefix)) throw new Error(`Unsafe path ${path}.`);
  return absolute;
}

function assertNoSymlink(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in Plugin configuration path: ${path}`);
}

function assertNoSymlinkAncestors(root: string, path: string): void {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const prefix = `${absoluteRoot}${sep}`;
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(prefix)) {
    throw new Error(`Unsafe path ${path}.`);
  }
  let current = absolutePath;
  while (true) {
    assertNoSymlink(current);
    if (current === absoluteRoot) return;
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not verify path ancestors for ${path}.`);
    current = parent;
  }
}

function assertPrivateDirectory(path: string): void {
  assertNoSymlink(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`Plugin configuration path ${path} must be a directory.`);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`Plugin configuration directory ${path} must have mode 700.`);
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stat.uid !== currentUserId) {
    throw new Error(`Plugin configuration directory ${path} is owned by UID ${stat.uid}, not the current user.`);
  }
}

function assertPrivateFile(path: string): void {
  assertNoSymlink(path);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Expected a regular private file at ${path}.`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`Plugin configuration file ${path} must have mode 600.`);
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stat.uid !== currentUserId) {
    throw new Error(`Plugin configuration file ${path} is owned by UID ${stat.uid}, not the current user.`);
  }
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertNoSymlink(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`Expected directory at ${path}.`);
  chmodSync(path, 0o700);
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  ensureDirectory(dirname(path));
  assertNoSymlink(path);
  const temporary = join(dirname(path), `.${path.split(sep).at(-1) ?? "file"}.tmp-${randomBytes(8).toString("hex")}`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
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
    // Directory fsync is unavailable on some supported host filesystems. The atomic rename still stands.
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function walkFiles(root: string): string[] {
  assertNoSymlink(root);
  if (!existsSync(root)) return [];
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in Plugin configuration path: ${root}`);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) throw new Error(`Unexpected filesystem object at ${root}.`);
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    files.push(...walkFiles(join(root, entry)));
  }
  return files;
}

function decodeInstalled(value: unknown, pluginId: string): InstalledPluginReceipt {
  if (!isRecord(value)) throw new Error(`Installed Plugin ${pluginId} metadata must be an object.`);
  if (value.schema !== 1 || value.plugin_id !== pluginId)
    throw new Error(`Installed Plugin ${pluginId} metadata is invalid.`);
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "plugin_id,previous,schema,selected") {
    throw new Error(`Installed Plugin ${pluginId} metadata contains unexpected fields.`);
  }
  const readReceipt = (candidate: unknown, label: string): InstalledPluginReceipt["selected"] | null => {
    if (candidate === null) return null;
    if (!isRecord(candidate)) throw new Error(`Installed Plugin ${pluginId} ${label} receipt is invalid.`);
    const required = [
      "version",
      "release_document_sha256",
      "image_index",
      "platform_manifest_sha256",
      "local_image_id"
    ];
    if (required.some((key) => typeof candidate[key] !== "string")) {
      throw new Error(`Installed Plugin ${pluginId} ${label} receipt is invalid.`);
    }
    const version = candidate.version;
    const releaseDocumentHash = candidate.release_document_sha256;
    const imageIndex = candidate.image_index;
    const platformManifestHash = candidate.platform_manifest_sha256;
    const localImageId = candidate.local_image_id;
    if (
      typeof version !== "string" ||
      typeof releaseDocumentHash !== "string" ||
      typeof imageIndex !== "string" ||
      typeof platformManifestHash !== "string" ||
      typeof localImageId !== "string"
    ) {
      throw new Error(`Installed Plugin ${pluginId} ${label} receipt is invalid.`);
    }
    if (Object.keys(candidate).sort().join(",") !== required.sort().join(",")) {
      throw new Error(`Installed Plugin ${pluginId} ${label} receipt contains unexpected fields.`);
    }
    assertVersion(version);
    if (!SHA256.test(releaseDocumentHash)) throw new Error(`Invalid ${label} release document hash.`);
    const expectedImagePrefix = `ghcr.io/the-drunken-coder/atlas-${pluginId.replaceAll("_", "-")}@sha256:`;
    if (
      !imageIndex.startsWith(expectedImagePrefix) ||
      !/^ghcr\.io\/the-drunken-coder\/atlas-[a-z0-9]+(?:-[a-z0-9]+)*@sha256:[0-9a-f]{64}$/u.test(imageIndex)
    ) {
      throw new Error(`Invalid ${label} image index.`);
    }
    if (!SHA256.test(platformManifestHash) || !SHA256.test(localImageId)) {
      throw new Error(`Invalid ${label} Docker identity.`);
    }
    return {
      version,
      release_document_sha256: releaseDocumentHash,
      image_index: imageIndex,
      platform_manifest_sha256: platformManifestHash,
      local_image_id: localImageId
    };
  };
  const selected = readReceipt(value.selected, "selected");
  if (!selected) throw new Error(`Installed Plugin ${pluginId} has no selected release.`);
  const previous = readReceipt(value.previous, "previous");
  if (previous?.version === selected.version) {
    throw new Error(`Installed Plugin ${pluginId} selected and previous releases must differ.`);
  }
  return { schema: 1, plugin_id: pluginId, selected, previous };
}

function renderTemplateValue(value: unknown, replacements: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === "string") {
    const markers = value.match(TEMPLATE_MARKER) ?? [];
    for (const marker of markers) {
      if (!TEMPLATE_MARKERS.has(marker)) throw new Error(`Unknown Plugin template placeholder ${marker}.`);
    }
    if (markers.length === 1 && value === markers[0]) return replacements.get(markers[0]);
    let rendered = value;
    for (const marker of markers) {
      const replacement = replacements.get(marker);
      if (typeof replacement !== "string") throw new Error(`Object placeholder ${marker} must stand alone.`);
      rendered = rendered.replaceAll(marker, replacement);
    }
    return rendered;
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, replacements));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const renderedKey = renderTemplateValue(key, replacements);
        if (typeof renderedKey !== "string") throw new Error("Plugin template object keys must be strings.");
        return [renderedKey, renderTemplateValue(item, replacements)];
      })
    );
  }
  return value;
}

function pruneTemplateNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== null).map(pruneTemplateNulls);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, pruneTemplateNulls(item)] as const)
        .filter(([key, item]) => item !== null && !(key === "volumes" && Array.isArray(item) && item.length === 0))
    );
  }
  return value;
}

function readTemplate(path: string): unknown {
  // Retained bundle files are owner-only state. Verify every existing
  // ancestor before opening a template so a replaced directory cannot redirect
  // reads outside the bundle.
  assertNoSymlinkAncestors(resolve(path, "../.."), path);
  assertNoSymlink(path);
  const stats = lstatSync(path);
  if (!stats.isFile()) throw new Error(`Expected a regular Plugin template at ${path}.`);
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stats.uid !== currentUserId) {
    throw new Error(`Plugin template ${path} is owned by UID ${stats.uid}, not the current user.`);
  }
  const mode = stats.mode & 0o777;
  if (mode !== 0o600 && mode !== 0o644) throw new Error(`Plugin template ${path} must have mode 600 or 644.`);
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) throw new Error(`Plugin template ${path} exceeds the size limit.`);
  try {
    return parseStrictJsonBytes(new Uint8Array(bytes), MAX_TEMPLATE_BYTES, "Plugin template");
  } catch (error) {
    throw new Error(`Plugin template ${path} is invalid JSON: ${errorMessage(error)}`);
  }
}

export class IndependentPluginManager {
  readonly #host: PluginLifecycleHost;
  readonly #transactionFactory: TransactionFactory;
  #activeTransaction: DeploymentTransaction | undefined;
  #runtimeChanged = false;
  readonly #configDir: string;
  readonly #pluginsDir: string;

  constructor(host: PluginLifecycleHost, transactionFactory?: TransactionFactory) {
    this.#host = host;
    this.#transactionFactory =
      transactionFactory ??
      ((options) => {
        const now = host.now?.();
        return DurableDeploymentTransactionStore.begin(host.configDir, {
          ...options,
          ...(now ? { now } : {})
        });
      });
    this.#configDir = resolve(host.configDir);
    this.#pluginsDir = join(this.#configDir, "plugins");
  }

  async install(
    candidate: IndependentPluginRelease | IndependentPluginReleaseCandidate
  ): Promise<PluginLifecycleOutcome> {
    await this.#requireFreshCatalog();
    const { release, catalog } = this.#candidate(candidate);
    this.#assertCompatible(release);
    const pluginDir = this.#pluginDir(release.pluginId);
    // A failed first install can leave the now-empty plugin directory behind.
    // The durable receipt is the installation boundary, so an orphaned
    // directory must not prevent retrying the install.
    if (existsSync(join(pluginDir, "installed.json"))) {
      throw new Error(`Plugin ${release.pluginId} is already installed; use update.`);
    }
    const bytes = releaseBytes(release);
    const documentHash = releaseDocumentHash(release, catalog);
    await this.#host.assertReleaseTrusted(release, documentHash);
    const image = receiptFor(release, await this.#host.pullAndInspectImage(release.image), documentHash);
    const running = await this.#host.isRunning();
    await this.#runTransaction("plugin-install", running, running, async () => {
      await this.#stageSnapshot(pluginDir, false);
      await this.#writeStaged(`plugins/${release.pluginId}/releases/${release.version}.atlas-plugin`, bytes);
      await this.#writeStaged(
        `plugins/${release.pluginId}/installed.json`,
        jsonBytes({
          schema: 1,
          plugin_id: release.pluginId,
          selected: image,
          previous: null
        } satisfies InstalledPluginReceipt)
      );
    });
    return {
      pluginId: release.pluginId,
      operation: "install",
      changed: true,
      version: release.version,
      previousVersion: null,
      message: `Installed ${release.displayName} ${release.version}.`
    };
  }

  async enable(pluginId: string): Promise<PluginLifecycleOutcome> {
    await this.#requireFreshCatalog();
    const installed = this.#readInstalled(pluginId);
    const release = this.#readSelectedRelease(installed);
    this.#assertCompatible(release);
    const documentHash = releaseDocumentHash(release);
    await this.#host.assertReleaseTrusted(release, documentHash);
    const enabled = [...(await this.#host.readEnabled())];
    if (enabled.includes(pluginId))
      return {
        pluginId,
        operation: "enable",
        changed: false,
        version: release.version,
        message: `${release.displayName} is already enabled.`
      };
    const wasRunning = await this.#host.isRunning();
    await this.#runTransaction(
      "plugin-enable",
      wasRunning,
      wasRunning,
      async (transaction) => {
        await this.#host.verifyRetainedBundle();
        const next = [...new Set([...enabled, pluginId])].sort();
        await this.#stageSnapshot(this.#pluginDir(pluginId), true);
        const receipt = await this.#ensureImageReceipt(release, installed.selected);
        await this.#writeActive(release, receipt, transaction);
        await this.#host.runCompose(["config", "--quiet"], next);
        await this.#host.writeEnabled(next);
        if (wasRunning) {
          await this.#markRuntimeChanging();
          await this.#host.runCompose(["down", "--remove-orphans"], enabled, true);
          await this.#host.runCompose(["up", "-d", "--no-build", "--pull", "never"], next);
          await this.#host.verifyRuntime(release, receipt);
        }
      },
      async () => {
        await this.#host.writeEnabled(enabled);
        if (this.#runtimeChanged) await this.#restoreRuntime(enabled, wasRunning);
      }
    );
    return {
      pluginId,
      operation: "enable",
      changed: true,
      version: release.version,
      message: wasRunning ? `${release.displayName} enabled.` : `${release.displayName} enabled for the next start.`
    };
  }

  async disable(pluginId: string): Promise<PluginLifecycleOutcome> {
    const installed = this.#readInstalled(pluginId);
    const release = this.#readSelectedRelease(installed);
    const enabled = [...(await this.#host.readEnabled())];
    if (!enabled.includes(pluginId))
      return {
        pluginId,
        operation: "disable",
        changed: false,
        version: release.version,
        message: `${release.displayName} is already disabled.`
      };
    const wasRunning = await this.#host.isRunning();
    const next = enabled.filter((candidate) => candidate !== pluginId);
    await this.#runTransaction(
      "plugin-disable",
      wasRunning,
      wasRunning,
      async () => {
        if (wasRunning) await this.#host.verifyRetainedBundle();
        await this.#stageSnapshot(this.#pluginDir(pluginId), true);
        await this.#removeActive(pluginId);
        await this.#host.runCompose(["config", "--quiet"], next);
        await this.#host.writeEnabled(next);
        if (wasRunning) {
          await this.#markRuntimeChanging();
          await this.#host.runCompose(["down", "--remove-orphans"], enabled, true);
          await this.#host.runCompose(["up", "-d", "--no-build", "--pull", "never"], next);
        } else {
          await this.#host.removePlugin(pluginId);
        }
      },
      async () => {
        await this.#host.writeEnabled(enabled);
        if (this.#runtimeChanged) await this.#restoreRuntime(enabled, wasRunning);
      }
    );
    return {
      pluginId,
      operation: "disable",
      changed: true,
      version: release.version,
      message: `${release.displayName} disabled.`
    };
  }

  async update(
    pluginId: string,
    candidateOrCandidates?:
      | IndependentPluginRelease
      | IndependentPluginReleaseCandidate
      | readonly IndependentPluginReleaseCandidate[]
  ): Promise<PluginLifecycleOutcome> {
    await this.#requireFreshCatalog();
    const installed = this.#readInstalled(pluginId);
    const current = this.#readSelectedRelease(installed);
    const currentRevoked =
      Array.isArray(candidateOrCandidates) &&
      candidateOrCandidates.some(
        (candidate) =>
          candidate.release.pluginId === pluginId &&
          candidate.release.version === current.version &&
          candidate.catalog.revoked
      );
    const candidate = this.#pickUpdate(current, candidateOrCandidates, currentRevoked);
    if (!candidate) {
      return {
        pluginId,
        operation: "update",
        changed: false,
        version: current.version,
        message: currentRevoked
          ? `${current.displayName} has no permitted non-revoked replacement.`
          : `${current.displayName} is current.`
      };
    }
    const { release, catalog } = this.#candidate(candidate);
    if (release.pluginId !== pluginId)
      throw new Error(`Plugin update candidate belongs to ${release.pluginId}, not ${pluginId}.`);
    if (catalog?.revoked) throw new Error(`Plugin ${pluginId} release ${release.version} is revoked.`);
    if (!Array.isArray(candidateOrCandidates)) {
      const comparison = comparePluginVersions(release.version, current.version);
      if (comparison === 0) {
        return {
          pluginId,
          operation: "update",
          changed: false,
          version: current.version,
          message: `${current.displayName} is current.`
        };
      }
      if (comparison < 0) {
        throw new Error(`Plugin update candidate ${release.version} is older than selected ${current.version}.`);
      }
    }
    this.#assertCompatible(release);
    const documentHash = releaseDocumentHash(release, catalog);
    await this.#host.assertReleaseTrusted(release, documentHash);
    const image = receiptFor(release, await this.#host.pullAndInspectImage(release.image), documentHash);
    const enabled = [...(await this.#host.readEnabled())];
    const wasRunning = await this.#host.isRunning();
    if (enabled.includes(pluginId) && !wasRunning)
      throw new Error(`Cannot update enabled Plugin ${pluginId} while Atlas is stopped.`);
    const nextRecord: InstalledPluginReceipt = {
      schema: 1,
      plugin_id: pluginId,
      selected: image,
      previous: installed.selected
    };
    await this.#runTransaction(
      "plugin-update",
      wasRunning,
      wasRunning,
      async (transaction) => {
        await this.#stageSnapshot(this.#pluginDir(pluginId), true);
        if (enabled.includes(pluginId)) {
          await this.#host.verifyRetainedBundle();
        }
        await this.#writeStaged(`plugins/${pluginId}/releases/${release.version}.atlas-plugin`, releaseBytes(release));
        await this.#writeStaged(`plugins/${pluginId}/installed.json`, jsonBytes(nextRecord));
        if (enabled.includes(pluginId)) {
          await this.#writeActive(release, image, transaction);
          await this.#host.runCompose(["config", "--quiet"], enabled);
          await this.#host.writeEnabled(enabled);
          await this.#markRuntimeChanging();
          await this.#host.runCompose(["down", "--remove-orphans"], enabled, true);
          await this.#host.runCompose(["up", "-d", "--no-build", "--pull", "never"], enabled);
          await this.#host.verifyRuntime(release, image);
        }
        await this.#pruneReleases(pluginId, nextRecord);
      },
      async () => {
        await this.#host.writeEnabled(enabled);
        if (this.#runtimeChanged) await this.#restoreRuntime(enabled, wasRunning);
      }
    );
    const remediationDowngrade = currentRevoked && comparePluginVersions(release.version, current.version) < 0;
    return {
      pluginId,
      operation: "update",
      changed: true,
      version: release.version,
      previousVersion: current.version,
      message: remediationDowngrade
        ? `${current.displayName} remediated from revoked ${current.version} to ${release.version} (downgrade).`
        : `${current.displayName} updated from ${current.version} to ${release.version}.`
    };
  }

  async rollback(pluginId: string): Promise<PluginLifecycleOutcome> {
    await this.#requireFreshCatalog();
    const installed = this.#readInstalled(pluginId);
    if (!installed.previous) throw new Error(`Plugin ${pluginId} has no previous release to roll back to.`);
    const previousRelease = this.#readRelease(pluginId, installed.previous.version);
    this.#assertCompatible(previousRelease);
    const previousDocumentHash = releaseDocumentHash(previousRelease);
    if (previousDocumentHash !== installed.previous.release_document_sha256) {
      throw new Error(`Previous release bytes for Plugin ${pluginId} changed.`);
    }
    await this.#host.assertReleaseTrusted(previousRelease, previousDocumentHash);
    const enabled = [...(await this.#host.readEnabled())];
    const wasRunning = await this.#host.isRunning();
    if (enabled.includes(pluginId) && !wasRunning)
      throw new Error(`Cannot roll back enabled Plugin ${pluginId} while Atlas is stopped.`);
    const image = receiptFor(
      previousRelease,
      await this.#ensureImageReceipt(previousRelease, installed.previous),
      installed.previous.release_document_sha256
    );
    const nextRecord: InstalledPluginReceipt = {
      schema: 1,
      plugin_id: pluginId,
      selected: image,
      previous: installed.selected
    };
    await this.#runTransaction(
      "plugin-rollback",
      wasRunning,
      wasRunning,
      async (transaction) => {
        await this.#stageSnapshot(this.#pluginDir(pluginId), true);
        if (enabled.includes(pluginId)) {
          await this.#host.verifyRetainedBundle();
        }
        await this.#writeStaged(`plugins/${pluginId}/installed.json`, jsonBytes(nextRecord));
        if (enabled.includes(pluginId)) {
          await this.#writeActive(previousRelease, image, transaction);
          await this.#host.runCompose(["config", "--quiet"], enabled);
          await this.#markRuntimeChanging();
          await this.#host.runCompose(["down", "--remove-orphans"], enabled, true);
          await this.#host.runCompose(["up", "-d", "--no-build", "--pull", "never"], enabled);
          await this.#host.verifyRuntime(previousRelease, image);
        }
      },
      async () => {
        await this.#host.writeEnabled(enabled);
        if (this.#runtimeChanged) await this.#restoreRuntime(enabled, wasRunning);
      }
    );
    return {
      pluginId,
      operation: "rollback",
      changed: true,
      version: previousRelease.version,
      previousVersion: installed.selected.version,
      message: `Rolled ${previousRelease.displayName} back to ${previousRelease.version}.`
    };
  }

  async uninstall(pluginId: string): Promise<PluginLifecycleOutcome> {
    const installed = this.#readInstalled(pluginId);
    const enabled = [...(await this.#host.readEnabled())];
    if (enabled.includes(pluginId)) throw new Error(`Disable Plugin ${pluginId} before uninstalling it.`);
    const release = this.#readSelectedRelease(installed);
    const running = await this.#host.isRunning();
    await this.#runTransaction("plugin-uninstall", running, running, async () => {
      await this.#stageSnapshot(this.#pluginDir(pluginId), false);
      await this.#host.removePlugin(pluginId);
      this.#removePluginDirectory(pluginId);
    });
    return {
      pluginId,
      operation: "uninstall",
      changed: true,
      version: release.version,
      message: `Uninstalled ${release.displayName}.`
    };
  }

  async list(candidates: readonly IndependentPluginReleaseCandidate[] = []): Promise<PluginListItem[]> {
    const enabled = new Set(await this.#host.readEnabled());
    const byId = new Map<string, PluginListItem>();
    for (const candidate of candidates) {
      const release = candidate.release;
      const existing = byId.get(release.pluginId);
      if (candidate.catalog.revoked) continue;
      if (!existing) {
        byId.set(release.pluginId, {
          pluginId: release.pluginId,
          displayName: release.displayName,
          installed: false,
          enabled: false,
          selected: null,
          previous: null,
          available: [release.version],
          status: "available"
        });
      } else {
        existing.available = [...new Set([...existing.available, release.version])]
          .sort(comparePluginVersions)
          .reverse();
      }
    }
    if (existsSync(this.#pluginsDir)) {
      assertPrivateDirectory(this.#pluginsDir);
      for (const entry of readdirSync(this.#pluginsDir)) {
        assertPluginId(entry);
        const directory = this.#pluginDir(entry);
        assertPrivateDirectory(directory);
        // A failed first install may leave an empty directory after rollback.
        // It has no local state to report and is safe to reuse on retry.
        if (!existsSync(join(directory, "installed.json"))) continue;
        const installed = this.#readInstalled(entry);
        const release = this.#readSelectedRelease(installed);
        const existing = byId.get(entry);
        byId.set(entry, {
          pluginId: entry,
          displayName: release.displayName,
          installed: true,
          enabled: enabled.has(entry),
          selected: installed.selected.version,
          previous: installed.previous?.version ?? null,
          available: existing?.available ?? [],
          status: enabled.has(entry) ? "enabled" : "installed"
        });
      }
    }
    return [...byId.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  async refresh(): Promise<unknown> {
    if (!this.#host.refreshCatalog) throw new Error("Catalog refresh is not configured for this CLI.");
    return await this.#host.refreshCatalog();
  }

  /** Regenerate disposable active files for normal start and Core-update preflight. */
  async regenerateActiveFiles(): Promise<void> {
    await this.#host.verifyRetainedBundle();
    const enabled = [...(await this.#host.readEnabled())];
    for (const pluginId of enabled) {
      const installed = this.#readInstalled(pluginId);
      const release = this.#readSelectedRelease(installed);
      this.#assertCompatible(release);
      const image = await this.#ensureImageReceipt(release, installed.selected);
      await this.#writeActive(release, image);
    }
  }

  readInstalled(pluginId: string): InstalledPluginReceipt {
    return this.#readInstalled(pluginId);
  }

  readSelected(pluginId: string): IndependentPluginRelease {
    return this.#readSelectedRelease(this.#readInstalled(pluginId));
  }

  readSelectedRecord(pluginId: string): {
    release: IndependentPluginRelease;
    receipt: InstalledPluginReceipt["selected"];
  } {
    const installed = this.#readInstalled(pluginId);
    const release = this.#readSelectedRelease(installed);
    return { release, receipt: installed.selected };
  }

  readSelectedRecords(
    pluginIds?: readonly string[]
  ): ReadonlyMap<string, { release: IndependentPluginRelease; receipt: InstalledPluginReceipt["selected"] }> {
    const ids = pluginIds ?? this.#installedPluginIds();
    return new Map(ids.map((pluginId) => [pluginId, this.readSelectedRecord(pluginId)]));
  }

  async preflightEnabled(): Promise<void> {
    await this.#host.verifyRetainedBundle();
    const enabled = await this.#host.readEnabled();
    for (const pluginId of enabled) {
      const selected = this.readSelectedRecord(pluginId);
      this.#assertCompatible(selected.release);
    }
  }

  async regenerateAll(): Promise<void> {
    await this.regenerateActiveFiles();
  }

  #candidate(candidate: IndependentPluginRelease | IndependentPluginReleaseCandidate): {
    release: IndependentPluginRelease;
    catalog?: PluginCatalogRelease;
  } {
    const release = "release" in candidate ? candidate.release : candidate;
    // The parsed document, rather than caller-provided convenience fields, is
    // authoritative for image, identity, and protocol declarations.
    const parsed = parsePluginRelease(releaseBytes(release));
    if ("release" in candidate) return { release: parsed, catalog: candidate.catalog };
    return { release: parsed };
  }

  #pickUpdate(
    current: IndependentPluginRelease,
    candidateOrCandidates?:
      | IndependentPluginRelease
      | IndependentPluginReleaseCandidate
      | readonly IndependentPluginReleaseCandidate[],
    currentRevoked = false
  ): IndependentPluginRelease | IndependentPluginReleaseCandidate | undefined {
    if (!candidateOrCandidates) return undefined;
    if (Array.isArray(candidateOrCandidates)) {
      const candidates = candidateOrCandidates
        .filter((candidate) => candidate.release.pluginId === current.pluginId)
        // Keep the current catalog entry as a remediation sentinel even if a
        // Core upgrade made that old release incompatible. Selection itself
        // will never return it while it is revoked.
        .filter((candidate) => candidate.release.version === current.version || this.#isCompatible(candidate.release))
        .filter((candidate) => !candidate.catalog.revoked || candidate.release.version === current.version);
      return selectPluginRelease(candidates, current.version, { remediateRevoked: currentRevoked });
    }
    return candidateOrCandidates as IndependentPluginRelease | IndependentPluginReleaseCandidate;
  }

  #isCompatible(release: IndependentPluginRelease): boolean {
    try {
      assertPluginCompatible(release, this.#host.contracts);
      return true;
    } catch {
      return false;
    }
  }

  #assertCompatible(release: IndependentPluginRelease): void {
    try {
      assertPluginCompatible(release, this.#host.contracts);
    } catch (error) {
      throw new Error(
        `Plugin ${release.pluginId} ${release.version} is incompatible with this Core: ${errorMessage(error)}`
      );
    }
  }

  async #requireFreshCatalog(): Promise<void> {
    if (this.#host.catalogFresh && !(await this.#host.catalogFresh())) {
      throw new Error("The Plugin catalog is expired or unavailable. Run atlas-core plugins refresh and retry.");
    }
  }

  #pluginDir(pluginId: string): string {
    assertPluginId(pluginId);
    return assertSafeRelativePath(this.#pluginsDir, pluginId);
  }

  #installedPluginIds(): string[] {
    if (!existsSync(this.#pluginsDir)) return [];
    assertPrivateDirectory(this.#pluginsDir);
    return readdirSync(this.#pluginsDir)
      .filter((entry) => {
        assertPluginId(entry);
        const directory = this.#pluginDir(entry);
        assertPrivateDirectory(directory);
        return existsSync(join(directory, "installed.json"));
      })
      .sort();
  }

  #readInstalled(pluginId: string): InstalledPluginReceipt {
    const directory = this.#pluginDir(pluginId);
    assertNoSymlinkAncestors(this.#configDir, directory);
    if (existsSync(this.#pluginsDir)) assertPrivateDirectory(this.#pluginsDir);
    assertPrivateDirectory(directory);
    const path = join(directory, "installed.json");
    assertNoSymlinkAncestors(this.#configDir, path);
    assertPrivateFile(path);
    const installed = decodeInstalled(
      parseStrictJsonBytes(new Uint8Array(readFileSync(path)), MAX_INSTALLED_BYTES, "installed.json"),
      pluginId
    );
    this.#assertReceiptRelease(pluginId, installed.selected, "selected");
    if (installed.previous) this.#assertReceiptRelease(pluginId, installed.previous, "previous");
    return installed;
  }

  #readRelease(pluginId: string, version: string): IndependentPluginRelease {
    assertVersion(version);
    const directory = this.#pluginDir(pluginId);
    const releases = join(directory, "releases");
    assertNoSymlinkAncestors(this.#configDir, releases);
    assertPrivateDirectory(releases);
    const path = join(releases, `${version}.atlas-plugin`);
    assertNoSymlinkAncestors(this.#configDir, path);
    assertPrivateFile(path);
    const bytes = new Uint8Array(readFileSync(path));
    const release = parsePluginRelease(bytes);
    if (release.pluginId !== pluginId || release.version !== version)
      throw new Error(`Release document identity mismatch for Plugin ${pluginId}.`);
    return release;
  }

  #readSelectedRelease(installed: InstalledPluginReceipt): IndependentPluginRelease {
    const release = this.#readRelease(installed.plugin_id, installed.selected.version);
    const hash = releaseDocumentHash(release);
    if (hash !== installed.selected.release_document_sha256)
      throw new Error(`Selected release bytes for Plugin ${installed.plugin_id} changed.`);
    if (release.image !== installed.selected.image_index)
      throw new Error(`Selected image for Plugin ${installed.plugin_id} changed.`);
    return release;
  }

  #assertReceiptRelease(pluginId: string, receipt: InstalledPluginReceipt["selected"], label: string): void {
    const release = this.#readRelease(pluginId, receipt.version);
    const hash = releaseDocumentHash(release);
    if (hash !== receipt.release_document_sha256 || release.image !== receipt.image_index) {
      throw new Error(`Plugin ${pluginId} ${label} receipt does not match its retained release document.`);
    }
  }

  async #ensureImageReceipt(
    release: IndependentPluginRelease,
    recorded: InstalledPluginReceipt["selected"]
  ): Promise<InstalledPluginReceipt["selected"]> {
    if (recorded.image_index !== release.image)
      throw new Error(`Recorded image for Plugin ${release.pluginId} does not match its release.`);
    if (this.#host.verifyImage) {
      await this.#host.verifyImage(recorded);
      return recorded;
    }
    const image = await this.#host.pullAndInspectImage(recorded.image_index);
    if (
      image.platform_manifest_sha256 !== recorded.platform_manifest_sha256 ||
      image.local_image_id !== recorded.local_image_id
    ) {
      throw new Error(`Local image manifest for Plugin ${release.pluginId} does not match its recorded receipt.`);
    }
    return {
      ...image,
      version: recorded.version,
      release_document_sha256: recorded.release_document_sha256
    };
  }

  async #stageSnapshot(directory: string, includeState: boolean): Promise<void> {
    const transaction = this.#requireActiveTransaction();
    const relativeDirectory = relative(this.#configDir, directory);
    if (transaction.snapshotTree) {
      transaction.snapshotTree(relativeDirectory);
    } else {
      const files = walkFiles(directory);
      for (const file of files) await transaction.snapshot(relative(this.#configDir, file));
    }
    if (includeState) await this.#snapshotState();
  }

  async #snapshotState(): Promise<void> {
    const statePath = join(this.#configDir, "state.json");
    if (existsSync(statePath)) await this.#requireActiveTransaction().snapshot("state.json");
  }

  async #writeStaged(relativePath: string, bytes: Uint8Array): Promise<void> {
    const path = assertSafeRelativePath(this.#configDir, relativePath);
    const transaction = this.#requireActiveTransaction();
    await transaction.snapshot(relativePath);
    await transaction.stage(relativePath, bytes);
    atomicWrite(path, bytes);
  }

  async #writeActive(
    release: IndependentPluginRelease,
    receipt: InstalledPluginReceipt["selected"],
    transaction?: DeploymentTransaction
  ): Promise<void> {
    const active = join(this.#pluginDir(release.pluginId), "active");
    const templateRoot = join(this.#configDir, "base", "plugin-templates");
    assertNoSymlink(templateRoot);
    const replacements = new Map<string, unknown>([
      ["@atlas/plugin-id@", release.pluginId],
      ["@atlas/plugin-service@", serviceName(release.pluginId)],
      ["@atlas/plugin-image@", release.image],
      ["@atlas/display-name@", release.displayName],
      ["@atlas/core-endpoint-id@", release.pluginId],
      [
        "@atlas/core-endpoint-mount@",
        `\${ATLAS_PLUGIN_CONFIG_ROOT:-plugins}/${release.pluginId}/active/core-endpoint.json:/app/plugin-endpoints/${release.pluginId}.json:ro`
      ],
      ["@atlas/core-protocol-major@", release.coreToPluginProtocolMajor],
      ["@atlas/core-origin@", release.atlasProtocolRevision === null ? null : "http://api:8000"],
      ["@atlas/api-auth-key@", release.atlasProtocolRevision === null ? null : "${ATLAS_PLUGIN_API_KEY}"],
      ["@atlas/source-gateway-protocol-major@", release.pluginToSourceGatewayProtocolMajor],
      ["@atlas/atlas-protocol-revision@", release.atlasProtocolRevision ?? ""],
      [
        "@atlas/source-connector-mount@",
        release.sourceConnector === null
          ? null
          : `\${ATLAS_PLUGIN_CONFIG_ROOT:-plugins}/${release.pluginId}/active/source-connector.json:/app/source-connectors/${release.pluginId}.json:ro`
      ],
      ["@atlas/source-connector-json@", release.sourceConnector]
    ]);
    const compose = pruneTemplateNulls(
      renderTemplateValue(readTemplate(join(templateRoot, "service.json")), replacements)
    );
    const endpoint = renderTemplateValue(readTemplate(join(templateRoot, "core-endpoint.json")), replacements);
    if (!isRecord(compose) || !isRecord(compose.services))
      throw new Error("Plugin service template must contain services.");
    const services = Object.keys(compose.services);
    const allowedServices = new Set(["api", "source-gateway", serviceName(release.pluginId)]);
    if (services.some((service) => !allowedServices.has(service))) {
      throw new Error("Plugin service template contains an unexpected service.");
    }
    if (services.length > 1 && (!services.includes("api") || !services.includes("source-gateway"))) {
      throw new Error("Plugin service template must include both API and Source Gateway overlays.");
    }
    if (!isRecord(endpoint) || endpoint.id !== release.pluginId)
      throw new Error("Plugin endpoint template identity mismatch.");
    const generated = new Map<string, Uint8Array>([
      ["compose.yml", jsonBytes(compose)],
      ["core-endpoint.json", jsonBytes(endpoint)],
      [
        "deployment.json",
        jsonBytes({
          schema: 1,
          plugin_id: release.pluginId,
          version: receipt.version,
          release_document_sha256: receipt.release_document_sha256,
          image_index: receipt.image_index,
          platform_manifest_sha256: receipt.platform_manifest_sha256,
          local_image_id: receipt.local_image_id
        })
      ]
    ]);
    if (release.sourceConnector !== null) {
      generated.set(
        "source-connector.json",
        jsonBytes(renderTemplateValue(readTemplate(join(templateRoot, "source-connector.json")), replacements))
      );
    }
    if (existsSync(active)) {
      // Active files are regenerated outside a transaction during normal
      // startup. Walk them first so a symlink cannot be silently replaced.
      walkFiles(active);
    }
    for (const [name, bytes] of generated) {
      const relativePath = relative(this.#configDir, join(active, name));
      if (transaction) {
        await transaction.snapshot(relativePath);
        await transaction.stage(relativePath, bytes);
      }
    }
    if (existsSync(active)) rmSync(active, { recursive: true, force: true });
    for (const [name, bytes] of generated) atomicWrite(join(active, name), bytes);
  }

  async #removeActive(pluginId: string): Promise<void> {
    const active = join(this.#pluginDir(pluginId), "active");
    const transaction = this.#requireActiveTransaction();
    if (transaction.snapshotTree) {
      transaction.snapshotTree(relative(this.#configDir, active));
    } else {
      for (const file of walkFiles(active)) await transaction.snapshot(relative(this.#configDir, file));
    }
    if (existsSync(active)) rmSync(active, { recursive: true, force: true });
  }

  async #pruneReleases(pluginId: string, record: InstalledPluginReceipt): Promise<void> {
    const releases = join(this.#pluginDir(pluginId), "releases");
    if (!existsSync(releases)) return;
    for (const file of walkFiles(releases)) {
      const version = file
        .split(sep)
        .at(-1)
        ?.replace(/\.atlas-plugin$/, "");
      if (version !== record.selected.version && version !== record.previous?.version) {
        rmSync(file, { force: true });
      }
    }
  }

  #removePluginDirectory(pluginId: string): void {
    const directory = this.#pluginDir(pluginId);
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }

  async #markRuntimeChanging(): Promise<void> {
    await this.#requireActiveTransaction().advance("runtime-changing");
    this.#runtimeChanged = true;
  }

  async #restoreRuntime(pluginIds: readonly string[], wasRunning: boolean): Promise<void> {
    if (!wasRunning) return;
    await this.#host.runCompose(["down", "--remove-orphans"], pluginIds, true);
    await this.#host.runCompose(["up", "-d", "--no-build", "--pull", "never"], pluginIds);
  }

  async #runTransaction(
    operation: TransactionOperation,
    desiredRunning: boolean,
    previousRunning: boolean,
    action: (transaction: DeploymentTransaction) => Promise<void>,
    restore?: () => Promise<void>
  ): Promise<void> {
    const transaction = this.#transactionFactory({
      operation,
      dockerEngineId: this.#host.dockerEngineId,
      desiredRunning,
      previousRunning
    });
    this.#activeTransaction = transaction;
    this.#runtimeChanged = false;
    try {
      await transaction.advance("prepared");
      await action(transaction);
      await transaction.markCommitted();
      await transaction.cleanup();
    } catch (error) {
      try {
        await transaction.rollback();
        await restore?.();
        await transaction.cleanup();
      } catch (rollbackError) {
        throw new Error(`${errorMessage(error)} Recovery is required: ${errorMessage(rollbackError)}`);
      }
      throw error;
    } finally {
      this.#runtimeChanged = false;
      this.#activeTransaction = undefined;
    }
  }

  #requireActiveTransaction(): DeploymentTransaction {
    if (!this.#activeTransaction) throw new Error("Plugin file mutation requires an active deployment transaction.");
    return this.#activeTransaction;
  }
}

export const pluginServiceName = serviceName;
