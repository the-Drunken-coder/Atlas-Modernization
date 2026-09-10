import { createHash, createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";

const MAX_RELEASE_BYTES = 1 << 20;
const MAX_CATALOG_BYTES = 4 << 20;
const MAX_SIGNATURE_BYTES = 1 << 10;
const MAX_STRING_BYTES = 2048;
const MAX_PLUGINS = 128;
const MAX_RELEASES = 256;
const MAX_REDIRECTS = 5;
const MAX_CATALOG_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type PluginInteraction = "map_area";

export type PluginSourceRoute = {
  method: string;
  path_prefix: string;
  allowed_query_names: readonly string[];
  allowed_request_headers: readonly string[];
  allowed_response_headers: readonly string[];
  read_only: boolean;
  cache: { ttl_ms: number };
  retry: {
    max_retries: number;
    statuses: readonly number[];
    failures: readonly string[];
    idempotency_header: string;
  };
};

export type PluginSourceConnector = {
  id: string;
  origin: string;
  routes: readonly PluginSourceRoute[];
  secret_headers: Record<string, never>;
  egress: { allow_private: boolean; allow_loopback: boolean; allow_link_local: boolean };
  limits: {
    timeout_ms: number;
    max_request_bytes: number;
    max_response_bytes: number;
    max_concurrency: number;
    max_header_count: number;
    max_header_bytes: number;
  };
  rate: { requests_per_second: number };
  circuit_breaker: { failures: number; open_ms: number };
};

export type PluginRelease = {
  schema: 1;
  pluginId: string;
  version: string;
  displayName: string;
  lifecycle: "query_only";
  image: string;
  coreToPluginProtocolMajor: number;
  pluginToSourceGatewayProtocolMajor: number;
  atlasProtocolRevision: string | null;
  interactions: readonly PluginInteraction[];
  sourceConnector: PluginSourceConnector | null;
  /** The exact bytes authenticated by the catalog's document_sha256. */
  bytes: Uint8Array;
};

export type PluginCatalogRelease = {
  pluginId: string;
  version: string;
  displayName: string;
  documentUrl: string;
  documentSha256: string;
  revoked: boolean;
  revocationReason: string | null;
};

export type PluginCatalogPlugin = {
  pluginId: string;
  releases: readonly PluginCatalogRelease[];
};

export type PluginCatalog = {
  schema: 1;
  sequence: number;
  previousCatalogSha256: string | null;
  issuedAt: string;
  expiresAt: string;
  keyEpoch: number;
  keyId: string;
  plugins: readonly PluginCatalogPlugin[];
};

export type PluginReleaseCandidate = {
  release: PluginRelease;
  catalog: PluginCatalogRelease;
};

export type CatalogCheckpoint = { keyEpoch: number; sequence: number };

export type PluginTrustKey = {
  keyId: string;
  keyEpoch: number;
  publicKey: KeyObject | string | Uint8Array;
  minimumSequence?: number;
};

export type PluginTrust = {
  keys: readonly PluginTrustKey[];
  minimumCheckpoint?: CatalogCheckpoint;
  allowedRedirectHosts?: readonly string[];
};

export type PluginTrustConfiguration = {
  schema: 1;
  catalogURL: string;
  trust: PluginTrust;
};

export type SignedCatalogReceipt = {
  schema: 1;
  sequence: number;
  previousCatalogSha256: string | null;
  issuedAt: string;
  expiresAt: string;
  keyEpoch: number;
  keyId: string;
  catalogSha256: string;
  catalogBytesBase64: string;
  signatureBytesBase64: string;
  catalog: PluginCatalog;
};

export type BoundedFetchOptions = {
  maxBytes: number;
  allowedHosts: readonly string[];
  maxRedirects?: number;
  /** Overall deadline, including redirects and response-body consumption. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export function parsePluginRelease(input: Uint8Array): PluginRelease {
  const bytes = copyBoundedBytes(input, MAX_RELEASE_BYTES, "Plugin release");
  const value = parseStrictJson(bytes, "Plugin release");
  const object = exactObject(
    value,
    [
      "schema",
      "plugin_id",
      "version",
      "display_name",
      "lifecycle",
      "image",
      "core_to_plugin_protocol_major",
      "plugin_to_source_gateway_protocol_major",
      "atlas_protocol_revision",
      "interactions",
      "source_connector"
    ],
    "Plugin release"
  );

  if (object.schema !== 1) throw new Error("Plugin release schema must be 1");
  const pluginId = pluginIdValue(object.plugin_id, "plugin_id", 50);
  const version = semverValue(object.version, "version");
  const displayName = displayNameValue(object.display_name, "display_name");
  if (object.lifecycle !== "query_only") throw new Error("Plugin release lifecycle must be query_only");
  const image = stringValue(object.image, "image");
  const expectedImage = `ghcr.io/the-drunken-coder/atlas-${pluginId.replaceAll("_", "-")}@sha256:`;
  if (
    !image.startsWith(expectedImage) ||
    !/^ghcr\.io\/the-drunken-coder\/atlas-[a-z0-9]+(?:-[a-z0-9]+)*@sha256:[0-9a-f]{64}$/u.test(image)
  ) {
    throw new Error("Plugin release image must be a digest-pinned first-party GHCR image");
  }
  const coreMajor = positiveSafeInteger(object.core_to_plugin_protocol_major, "core_to_plugin_protocol_major");
  const gatewayMajor = positiveSafeInteger(
    object.plugin_to_source_gateway_protocol_major,
    "plugin_to_source_gateway_protocol_major"
  );
  const atlasRevision = hashOrNull(object.atlas_protocol_revision, "atlas_protocol_revision");
  const interactions = interactionsValue(object.interactions);
  const sourceConnector =
    object.source_connector === null ? null : sourceConnectorValue(object.source_connector, pluginId);

  return {
    schema: 1,
    pluginId,
    version,
    displayName,
    lifecycle: "query_only",
    image,
    coreToPluginProtocolMajor: coreMajor,
    pluginToSourceGatewayProtocolMajor: gatewayMajor,
    atlasProtocolRevision: atlasRevision,
    interactions,
    sourceConnector,
    bytes
  };
}

/** Validate the source-controlled trust configuration without embedding a production key in the CLI. */
export function parsePluginTrustConfiguration(value: unknown): PluginTrustConfiguration {
  const object = exactObject(
    value,
    ["schema", "catalog_url", "keys", "minimum_checkpoint"],
    "Plugin trust configuration"
  );
  if (object.schema !== 1) throw new Error("Plugin trust configuration schema must be 1");
  const catalogURL = boundedString(object.catalog_url, "catalog_url");
  let parsedURL: URL;
  try {
    parsedURL = new URL(catalogURL);
  } catch {
    throw new Error("catalog_url must be a URL");
  }
  if (parsedURL.protocol !== "https:" || parsedURL.username || parsedURL.password || parsedURL.search || parsedURL.hash)
    throw new Error("catalog_url must be an HTTPS URL without credentials, query, or fragment");
  const keyValues = arrayValue(object.keys, "keys");
  if (keyValues.length > 32) throw new Error("trust configuration contains too many keys");
  const keyIds = new Set<string>();
  const keyEpochs = new Set<number>();
  const keys = keyValues.map((raw, index) => {
    const key = exactObject(raw, ["key_id", "key_epoch", "public_key_pem", "minimum_sequence"], `trust keys[${index}]`);
    const keyId = nonEmptyString(key.key_id, "trust key_id");
    if (keyIds.has(keyId)) throw new Error(`trust configuration contains duplicate key ${keyId}`);
    keyIds.add(keyId);
    const keyEpoch = positiveSafeInteger(key.key_epoch, "trust key_epoch");
    if (keyEpochs.has(keyEpoch)) throw new Error(`trust configuration contains duplicate epoch ${keyEpoch}`);
    keyEpochs.add(keyEpoch);
    const publicKey = boundedString(key.public_key_pem, "trust public_key_pem");
    let parsedKey: KeyObject;
    try {
      parsedKey = createPublicKey(publicKey);
    } catch {
      throw new Error(`trust key ${keyId} is not a valid public key`);
    }
    if (parsedKey.asymmetricKeyType !== "ed25519") throw new Error(`trust key ${keyId} must be Ed25519`);
    const minimumSequence = positiveSafeInteger(key.minimum_sequence, "trust minimum_sequence");
    return { keyId, keyEpoch, publicKey, minimumSequence };
  });
  const checkpointValue = object.minimum_checkpoint;
  let minimumCheckpoint: CatalogCheckpoint | undefined;
  if (checkpointValue !== null) {
    const checkpoint = exactObject(checkpointValue, ["key_epoch", "sequence"], "minimum_checkpoint");
    minimumCheckpoint = {
      keyEpoch: positiveSafeInteger(checkpoint.key_epoch, "minimum_checkpoint.key_epoch"),
      sequence: positiveSafeInteger(checkpoint.sequence, "minimum_checkpoint.sequence")
    };
  }
  return { schema: 1, catalogURL, trust: { keys, ...(minimumCheckpoint ? { minimumCheckpoint } : {}) } };
}

export function verifyCatalog(
  input: Uint8Array,
  signatureInput: Uint8Array,
  trust: PluginTrust,
  previous: SignedCatalogReceipt | undefined,
  now = new Date()
): SignedCatalogReceipt {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error("catalog verification time is invalid");
  const bytes = copyBoundedBytes(input, MAX_CATALOG_BYTES, "Plugin catalog");
  const signatureBytes = copyBoundedBytes(signatureInput, MAX_SIGNATURE_BYTES, "Plugin catalog signature");
  const catalogValue = parseStrictJson(bytes, "Plugin catalog");
  const catalog = catalogValueOf(catalogValue);
  const signature = signatureValue(parseStrictJson(signatureBytes, "Plugin catalog signature"));
  if (signature.keyId !== catalog.keyId)
    throw new Error("Plugin catalog signature key_id does not match catalog key_id");

  const key = trust.keys.find((candidate) => candidate.keyId === catalog.keyId);
  if (!key) throw new Error(`Plugin catalog signing key ${catalog.keyId} is not trusted`);
  if (key.keyEpoch !== catalog.keyEpoch) throw new Error("Plugin catalog key epoch does not match trusted key");
  const checkpoint = trust.minimumCheckpoint;
  if (checkpoint && compareCheckpoint({ keyEpoch: catalog.keyEpoch, sequence: catalog.sequence }, checkpoint) < 0) {
    throw new Error("Plugin catalog is below the CLI trust checkpoint");
  }
  if (key.minimumSequence !== undefined && catalog.sequence < key.minimumSequence) {
    throw new Error("Plugin catalog sequence is below the trusted key floor");
  }
  if (!verifyEd25519(bytes, signature.signature, key.publicKey)) throw new Error("Plugin catalog signature is invalid");

  const issued = Date.parse(catalog.issuedAt);
  const expires = Date.parse(catalog.expiresAt);
  const current = now.getTime();
  if (issued > current + MAX_CLOCK_SKEW_MS) throw new Error("Plugin catalog issue time is too far in the future");
  if (expires <= issued || expires - issued > MAX_CATALOG_LIFETIME_MS)
    throw new Error("Plugin catalog expiry is invalid");
  if (expires <= current) throw new Error("Plugin catalog is expired");
  if (previous) {
    const pair = { keyEpoch: catalog.keyEpoch, sequence: catalog.sequence };
    const previousPair = { keyEpoch: previous.keyEpoch, sequence: previous.sequence };
    const order = compareCheckpoint(pair, previousPair);
    if (order < 0) throw new Error("Plugin catalog is older than the accepted catalog");
    if (order === 0) {
      if (sha256(bytes) !== previous.catalogSha256) throw new Error("Catalog sequence was reused with different bytes");
    } else {
      if (issued <= Date.parse(previous.issuedAt)) throw new Error("Plugin catalog issue time did not increase");
      if (catalog.keyEpoch === previous.keyEpoch && catalog.sequence === previous.sequence + 1) {
        if (catalog.previousCatalogSha256 !== previous.catalogSha256) {
          throw new Error("Plugin catalog does not chain from the previous catalog");
        }
      }
    }
  }

  const catalogSha256 = sha256(bytes);
  return {
    schema: 1,
    sequence: catalog.sequence,
    previousCatalogSha256: catalog.previousCatalogSha256,
    issuedAt: catalog.issuedAt,
    expiresAt: catalog.expiresAt,
    keyEpoch: catalog.keyEpoch,
    keyId: catalog.keyId,
    catalogSha256,
    catalogBytesBase64: Buffer.from(bytes).toString("base64"),
    signatureBytesBase64: Buffer.from(signatureBytes).toString("base64"),
    catalog
  };
}

export function assertPluginCompatible(release: PluginRelease, contracts: PluginContracts): void {
  if (contracts.supportedPackageSchemaMajors && !contracts.supportedPackageSchemaMajors.includes(release.schema)) {
    throw new Error(`Plugin package schema ${release.schema} is not supported by this Core`);
  }
  if (!contracts.coreToPluginProtocolMajors.includes(release.coreToPluginProtocolMajor)) {
    throw new Error(`Plugin requires unsupported Core-to-Plugin protocol major ${release.coreToPluginProtocolMajor}`);
  }
  if (!contracts.pluginToSourceGatewayProtocolMajors.includes(release.pluginToSourceGatewayProtocolMajor)) {
    throw new Error(
      `Plugin requires unsupported Plugin-to-Source-Gateway protocol major ${release.pluginToSourceGatewayProtocolMajor}`
    );
  }
  if (release.atlasProtocolRevision !== null && release.atlasProtocolRevision !== contracts.atlasProtocolRevision) {
    throw new Error("Plugin requires a different Atlas Protocol revision");
  }
  if (contracts.supportedInteractions) {
    for (const interaction of release.interactions) {
      if (!contracts.supportedInteractions.includes(interaction))
        throw new Error(`Plugin interaction ${interaction} is not supported`);
    }
  }
}

export type PluginContracts = {
  coreToPluginProtocolMajors: readonly number[];
  pluginToSourceGatewayProtocolMajors: readonly number[];
  atlasProtocolRevision: string | null;
  supportedPackageSchemaMajors?: readonly number[];
  supportedInteractions?: readonly PluginInteraction[];
};

export function selectPluginRelease(
  candidates: readonly PluginReleaseCandidate[],
  currentVersion?: string,
  options: { remediateRevoked?: boolean } = {}
): PluginReleaseCandidate | undefined {
  if (candidates.length === 0) return undefined;
  for (const candidate of candidates) {
    if (
      candidate.release.pluginId !== candidate.catalog.pluginId ||
      candidate.release.version !== candidate.catalog.version ||
      candidate.release.displayName !== candidate.catalog.displayName
    ) {
      throw new Error("Plugin release does not match its catalog entry");
    }
  }
  const current = currentVersion === undefined ? undefined : semverValue(currentVersion, "current version");
  const sorted = [...candidates].sort((left, right) => compareSemver(right.release.version, left.release.version));
  const currentCandidate = current ? sorted.find((candidate) => candidate.release.version === current) : undefined;
  const remediation = options.remediateRevoked === true && currentCandidate?.catalog.revoked === true;
  return sorted.find((candidate) => {
    if (candidate.catalog.revoked) return false;
    if (!current) return true;
    if (remediation) return candidate.release.version !== current;
    return compareSemver(candidate.release.version, current) > 0;
  });
}

export function comparePluginVersions(left: string, right: string): number {
  return compareSemver(semverValue(left, "left version"), semverValue(right, "right version"));
}

/** Parse a bounded JSON document with the same byte-level rules as release and catalog documents. */
export function parseStrictJsonBytes(input: Uint8Array, maximum: number, name: string): unknown {
  return parseStrictJson(copyBoundedBytes(input, maximum, name), name);
}

export async function fetchBounded(url: string, options: BoundedFetchOptions): Promise<Uint8Array> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    throw new Error("maxBytes must be a positive safe integer");
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.maxRedirects ?? MAX_REDIRECTS;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_REDIRECTS) throw new Error("maxRedirects is invalid");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error("timeoutMs must be between 1 and 300000 milliseconds");
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error("download timed out");
    controller.abort(error);
    timeoutReject(error);
  }, timeoutMs);
  let timeoutReject!: (reason: Error) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
  });
  let removeCallerAbort: (() => void) | undefined;
  const callerAbort = options.signal
    ? new Promise<never>((_, reject) => {
        const abort = () => {
          const reason = options.signal?.reason;
          const error = reason instanceof Error ? reason : new Error("download aborted");
          controller.abort(error);
          reject(error);
        };
        if (options.signal?.aborted) abort();
        else {
          options.signal?.addEventListener("abort", abort, { once: true });
          removeCallerAbort = () => options.signal?.removeEventListener("abort", abort);
        }
      })
    : undefined;
  const download = async (): Promise<Uint8Array> => {
    let current = checkedDownloadUrl(url, allowedHosts);
    for (let redirects = 0; redirects <= limit; redirects++) {
      const response = await fetchImpl(current, { method: "GET", redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        if (redirects === limit) throw new Error("download exceeded redirect limit");
        const location = response.headers.get("location");
        if (!location) throw new Error("download redirect has no Location header");
        // GitHub's release-asset redirects carry a signed query string. The
        // canonical catalog/release URL is still required to be query-free;
        // only an allowlisted HTTPS redirect target may have a query.
        current = checkedDownloadUrl(new URL(location, current).toString(), allowedHosts, true);
        continue;
      }
      if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > options.maxBytes) {
        throw new Error("download exceeds size limit");
      }
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel();
          throw new Error("download exceeds size limit");
        }
        chunks.push(next.value);
      }
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    }
    throw new Error("download failed");
  };
  try {
    return await Promise.race(
      callerAbort !== undefined ? [download(), timeoutPromise, callerAbort] : [download(), timeoutPromise]
    );
  } finally {
    clearTimeout(timeout);
    removeCallerAbort?.();
  }
}

function catalogValueOf(value: unknown): PluginCatalog {
  const object = exactObject(
    value,
    ["schema", "sequence", "previous_catalog_sha256", "issued_at", "expires_at", "key_epoch", "key_id", "plugins"],
    "Plugin catalog"
  );
  if (object.schema !== 1) throw new Error("Plugin catalog schema must be 1");
  const sequence = positiveSafeInteger(object.sequence, "sequence");
  const keyEpoch = positiveSafeInteger(object.key_epoch, "key_epoch");
  const previousCatalogSha256 = hashOrNull(object.previous_catalog_sha256, "previous_catalog_sha256");
  if (keyEpoch === 1 && sequence === 1 && previousCatalogSha256 !== null)
    throw new Error("first Plugin catalog must not have a previous hash");
  if ((keyEpoch !== 1 || sequence !== 1) && previousCatalogSha256 === null)
    throw new Error("later Plugin catalogs must have a previous hash");
  const issuedAt = rfc3339Utc(object.issued_at, "issued_at");
  const expiresAt = rfc3339Utc(object.expires_at, "expires_at");
  const keyId = nonEmptyString(object.key_id, "key_id");
  const pluginsArray = arrayValue(object.plugins, "plugins");
  if (pluginsArray.length > MAX_PLUGINS) throw new Error(`Plugin catalog may contain at most ${MAX_PLUGINS} Plugins`);
  const seenPlugins = new Set<string>();
  const plugins = pluginsArray.map((entry, index) => {
    const item = exactObject(entry, ["plugin_id", "releases"], `Plugin catalog plugins[${index}]`);
    const pluginId = pluginIdValue(item.plugin_id, `plugins[${index}].plugin_id`, 50);
    if (seenPlugins.has(pluginId)) throw new Error(`Plugin catalog contains duplicate Plugin ${pluginId}`);
    seenPlugins.add(pluginId);
    const releaseValues = arrayValue(item.releases, `plugins[${index}].releases`);
    if (releaseValues.length > MAX_RELEASES) throw new Error(`Plugin catalog Plugin ${pluginId} has too many releases`);
    const seenVersions = new Set<string>();
    const releases = releaseValues.map((raw, releaseIndex) => {
      const release = exactObject(
        raw,
        ["version", "display_name", "document_url", "document_sha256", "revoked", "revocation_reason"],
        `catalog release ${pluginId}[${releaseIndex}]`
      );
      const version = semverValue(release.version, "catalog release version");
      if (seenVersions.has(version))
        throw new Error(`Plugin catalog contains duplicate ${pluginId} version ${version}`);
      seenVersions.add(version);
      const displayName = displayNameValue(release.display_name, "catalog release display_name");
      const documentSha256 = hashValue(release.document_sha256, "document_sha256");
      const documentUrl = releaseUrlValue(release.document_url, pluginId, version);
      if (typeof release.revoked !== "boolean") throw new Error("catalog release revoked must be boolean");
      const revoked = release.revoked;
      const revocationReason =
        release.revocation_reason === null ? null : boundedString(release.revocation_reason, "revocation_reason");
      if (revoked && (!revocationReason || revocationReason.trim() !== revocationReason))
        throw new Error("revoked catalog release requires a reason");
      if (!revoked && revocationReason !== null)
        throw new Error("non-revoked catalog release must not have a revocation reason");
      return { pluginId, version, displayName, documentUrl, documentSha256, revoked, revocationReason };
    });
    return { pluginId, releases };
  });
  return { schema: 1, sequence, previousCatalogSha256, issuedAt, expiresAt, keyEpoch, keyId, plugins };
}

function signatureValue(value: unknown): { algorithm: "ed25519"; keyId: string; signature: Uint8Array } {
  const object = exactObject(value, ["algorithm", "key_id", "signature"], "Plugin catalog signature");
  if (object.algorithm !== "ed25519") throw new Error("Plugin catalog signature algorithm must be ed25519");
  const keyId = nonEmptyString(object.key_id, "signature key_id");
  const encoded = boundedString(object.signature, "signature");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded))
    throw new Error("signature must be standard base64");
  const signature = Buffer.from(encoded, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== encoded)
    throw new Error("signature must encode exactly 64 bytes");
  return { algorithm: "ed25519", keyId, signature };
}

function sourceConnectorValue(value: unknown, pluginId: string): PluginSourceConnector {
  const object = exactObject(
    value,
    ["id", "origin", "routes", "secret_headers", "egress", "limits", "rate", "circuit_breaker"],
    "source_connector"
  );
  const id = pluginIdValue(object.id, "source_connector.id", 50);
  if (id !== pluginId) throw new Error("source_connector.id must equal plugin_id");
  const origin = stringValue(object.origin, "source_connector.origin");
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error("source_connector.origin must be an HTTP origin");
  }
  if (
    (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") ||
    !parsedOrigin.hostname ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    (parsedOrigin.pathname !== "/" && parsedOrigin.pathname !== "") ||
    parsedOrigin.search ||
    parsedOrigin.hash
  )
    throw new Error("source_connector.origin must be an HTTP origin without credentials or path");
  const secretHeaders = exactObject(object.secret_headers, [], "source_connector.secret_headers") as Record<
    string,
    never
  >;
  const routesValues = arrayValue(object.routes, "source_connector.routes");
  if (routesValues.length === 0) throw new Error("source_connector.routes must not be empty");
  const seenRoutes = new Set<string>();
  const routes = routesValues.map((raw, index) => routeValue(raw, index, seenRoutes));
  const egressObject = exactObject(
    object.egress,
    ["allow_private", "allow_loopback", "allow_link_local"],
    "source_connector.egress"
  );
  const egress = {
    allow_private: booleanValue(egressObject.allow_private, "egress.allow_private"),
    allow_loopback: booleanValue(egressObject.allow_loopback, "egress.allow_loopback"),
    allow_link_local: booleanValue(egressObject.allow_link_local, "egress.allow_link_local")
  };
  const limitsObject = exactObject(
    object.limits,
    [
      "timeout_ms",
      "max_request_bytes",
      "max_response_bytes",
      "max_concurrency",
      "max_header_count",
      "max_header_bytes"
    ],
    "source_connector.limits"
  );
  const limits = {
    timeout_ms: boundedInteger(limitsObject.timeout_ms, "limits.timeout_ms", 1, 30_000),
    max_request_bytes: boundedInteger(limitsObject.max_request_bytes, "limits.max_request_bytes", 1, 4 << 20),
    max_response_bytes: boundedInteger(limitsObject.max_response_bytes, "limits.max_response_bytes", 1, 16 << 20),
    max_concurrency: boundedInteger(limitsObject.max_concurrency, "limits.max_concurrency", 1, 64),
    max_header_count: boundedInteger(limitsObject.max_header_count, "limits.max_header_count", 1, 128),
    max_header_bytes: boundedInteger(limitsObject.max_header_bytes, "limits.max_header_bytes", 1, 256 << 10)
  };
  const rateObject = exactObject(object.rate, ["requests_per_second"], "source_connector.rate");
  const requestsPerSecond = finiteNumber(rateObject.requests_per_second, "rate.requests_per_second");
  if (requestsPerSecond < 0 || requestsPerSecond > 1000) throw new Error("rate.requests_per_second is out of range");
  const breakerObject = exactObject(
    object.circuit_breaker,
    ["failures", "open_ms"],
    "source_connector.circuit_breaker"
  );
  const circuitBreaker = {
    failures: boundedInteger(breakerObject.failures, "circuit_breaker.failures", 1, 100),
    open_ms: boundedInteger(breakerObject.open_ms, "circuit_breaker.open_ms", 1, 3_600_000)
  };
  return {
    id,
    origin,
    routes,
    secret_headers: secretHeaders,
    egress,
    limits,
    rate: { requests_per_second: requestsPerSecond },
    circuit_breaker: circuitBreaker
  };
}

function routeValue(value: unknown, index: number, seenRoutes: Set<string>): PluginSourceRoute {
  const object = exactObject(
    value,
    [
      "method",
      "path_prefix",
      "allowed_query_names",
      "allowed_request_headers",
      "allowed_response_headers",
      "read_only",
      "cache",
      "retry"
    ],
    `source_connector.routes[${index}]`
  );
  const method = stringValue(object.method, "route.method").trim().toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw new Error(`route ${index} method is unsupported`);
  const pathPrefix = stringValue(object.path_prefix, "route.path_prefix");
  if (
    !pathPrefix.startsWith("/") ||
    pathPrefix.startsWith("//") ||
    /[\\?#\u0000]/u.test(pathPrefix) ||
    pathPrefix.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(`route ${index} path_prefix is invalid`);
  const queryNames = namesValue(object.allowed_query_names, false, "route.allowed_query_names");
  const requestHeaders = namesValue(object.allowed_request_headers, true, "route.allowed_request_headers");
  const responseHeaders = namesValue(object.allowed_response_headers, true, "route.allowed_response_headers");
  const key = `${method} ${pathPrefix}`;
  if (seenRoutes.has(key)) throw new Error(`route ${key} is duplicated`);
  seenRoutes.add(key);
  if (
    requestHeaders.some((name) =>
      [
        "connection",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "authorization",
        "cookie"
      ].includes(name)
    )
  )
    throw new Error("route has a forbidden request header");
  if (
    responseHeaders.some((name) =>
      [
        "connection",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "authorization",
        "cookie",
        "set-cookie"
      ].includes(name)
    )
  )
    throw new Error("route has a forbidden response header");
  const readOnly = booleanValue(object.read_only, "route.read_only");
  const cacheObject = exactObject(object.cache, ["ttl_ms"], "route.cache");
  const ttl = boundedInteger(cacheObject.ttl_ms, "route.cache.ttl_ms", 0, 3_600_000);
  if (ttl > 0 && !readOnly) throw new Error("cached routes must be read_only");
  const retryObject = exactObject(
    object.retry,
    ["max_retries", "statuses", "failures", "idempotency_header"],
    "route.retry"
  );
  const maxRetries = boundedInteger(retryObject.max_retries, "route.retry.max_retries", 0, 3);
  const statuses = arrayValue(retryObject.statuses, "route.retry.statuses").map((status, statusIndex) =>
    boundedInteger(status, `route.retry.statuses[${statusIndex}]`, 100, 599)
  );
  if (new Set(statuses).size !== statuses.length) throw new Error("route retry statuses contain duplicates");
  const failures = arrayValue(retryObject.failures, "route.retry.failures").map((failure) =>
    stringValue(failure, "route.retry.failure").trim()
  );
  if (
    failures.some((failure) => !["upstream_timeout", "upstream_unreachable"].includes(failure)) ||
    new Set(failures).size !== failures.length
  )
    throw new Error("route retry failures are invalid");
  const idempotencyHeader = stringValue(retryObject.idempotency_header, "route.retry.idempotency_header")
    .trim()
    .toLowerCase();
  if (idempotencyHeader && !headerName(idempotencyHeader)) throw new Error("route retry idempotency_header is invalid");
  if (maxRetries > 0 && !readOnly && !idempotencyHeader) throw new Error("mutating retries require idempotency_header");
  return {
    method,
    path_prefix: pathPrefix,
    allowed_query_names: queryNames,
    allowed_request_headers: requestHeaders,
    allowed_response_headers: responseHeaders,
    read_only: readOnly,
    cache: { ttl_ms: ttl },
    retry: { max_retries: maxRetries, statuses, failures, idempotency_header: idempotencyHeader }
  };
}

function namesValue(value: unknown, headers: boolean, field: string): readonly string[] {
  const values = arrayValue(value, field);
  const result = values.map((entry) => {
    const name = stringValue(entry, field).trim();
    const normalized = headers ? name.toLowerCase() : name;
    if (!normalized || (headers && !headerName(normalized))) throw new Error(`${field} contains an invalid name`);
    return normalized;
  });
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicate names`);
  return result;
}

function interactionsValue(value: unknown): readonly PluginInteraction[] {
  const values = arrayValue(value, "interactions");
  const interactions = values.map((entry) => {
    if (entry !== "map_area") throw new Error("unsupported Plugin interaction");
    return entry as PluginInteraction;
  });
  if (
    new Set(interactions).size !== interactions.length ||
    interactions.some((entry, index) => index > 0 && entry < interactions[index - 1]!)
  )
    throw new Error("interactions must be sorted and duplicate-free");
  return interactions;
}

function exactObject(value: unknown, expectedKeys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`${name} contains missing or unknown fields`);
  return object;
}

function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES)
    throw new Error(`${name} exceeds ${MAX_STRING_BYTES} UTF-8 bytes`);
  return value;
}

function boundedString(value: unknown, name: string): string {
  return stringValue(value, name);
}

function nonEmptyString(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!result) throw new Error(`${name} must not be empty`);
  return result;
}

function displayNameValue(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!result || result.trim() !== result || [...result].length > 100)
    throw new Error(`${name} must be a trimmed string of 1 to 100 characters`);
  return result;
}

function pluginIdValue(value: unknown, name: string, maximum: number): string {
  const result = stringValue(value, name);
  if (result.length > maximum || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(result))
    throw new Error(`${name} is not a valid Plugin ID`);
  return result;
}

function semverValue(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(result))
    throw new Error(`${name} must be a stable Semantic Version`);
  return result;
}

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map((part) => BigInt(part));
  const b = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index++) if (a[index]! !== b[index]!) return a[index]! > b[index]! ? 1 : -1;
  return 0;
}

function hashValue(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return result;
}

function hashOrNull(value: unknown, name: string): string | null {
  return value === null ? null : hashValue(value, name);
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive safe integer`);
  return value as number;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value as number;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function rfc3339Utc(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(result) || !Number.isFinite(Date.parse(result)))
    throw new Error(`${name} must be a UTC RFC 3339 timestamp`);
  return result;
}

function releaseUrlValue(value: unknown, pluginId: string, version: string): string {
  const result = stringValue(value, "document_url");
  const expected = `https://github.com/the-Drunken-coder/Atlas-Modernization/releases/download/atlas-plugin-${pluginId}-v${version}/${pluginId}-${version}.atlas-plugin`;
  if (result !== expected) throw new Error("document_url does not match the immutable GitHub Release asset");
  return result;
}

function headerName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value);
}

function checkedDownloadUrl(value: string, allowedHosts: ReadonlySet<string>, allowQuery = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("download URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (!allowQuery && parsed.search) ||
    parsed.hash ||
    !allowedHosts.has(parsed.hostname.toLowerCase())
  )
    throw new Error("download URL is not an allowlisted HTTPS URL");
  return parsed.toString();
}

function compareCheckpoint(left: CatalogCheckpoint, right: CatalogCheckpoint): number {
  return left.keyEpoch === right.keyEpoch
    ? Math.sign(left.sequence - right.sequence)
    : Math.sign(left.keyEpoch - right.keyEpoch);
}

function verifyEd25519(
  data: Uint8Array,
  encodedSignature: Uint8Array,
  publicKey: KeyObject | string | Uint8Array
): boolean {
  let key: KeyObject;
  if (publicKey instanceof Uint8Array) {
    if (publicKey.byteLength !== 32) throw new Error("Ed25519 public key must be 32 bytes");
    key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: "der",
      type: "spki"
    });
  } else if (typeof publicKey === "string") {
    key = createPublicKey(publicKey);
  } else {
    key = publicKey;
  }
  return verifySignature(null, data, key, encodedSignature);
}

function sha256(data: Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function copyBoundedBytes(input: Uint8Array, maximum: number, name: string): Uint8Array {
  if (!(input instanceof Uint8Array)) throw new Error(`${name} must be bytes`);
  if (input.byteLength > maximum) throw new Error(`${name} exceeds ${maximum} bytes`);
  return new Uint8Array(input);
}

function parseStrictJson(bytes: Uint8Array, name: string): unknown {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error(`${name} must not contain a byte-order mark`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} must be valid UTF-8`);
  }
  scanJson(text, name);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${name} contains invalid JSON`);
  }
}

function scanJson(text: string, name: string): void {
  let index = 0;
  const whitespace = (): void => {
    while (index < text.length && " \t\r\n".includes(text[index]!)) index++;
  };
  const string = (): string => {
    const start = index;
    if (text[index++] !== '"') throw new Error(`${name} contains invalid JSON`);
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          throw new Error(`${name} contains invalid JSON string`);
        }
      }
      if (character === "\\") {
        const escape = text[index++];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index, index + 4)))
            throw new Error(`${name} contains invalid JSON escape`);
          index += 4;
        } else if (!escape || !`"\\/bfnrt`.includes(escape)) throw new Error(`${name} contains invalid JSON escape`);
      } else if (character !== undefined && character < " ")
        throw new Error(`${name} contains an unescaped control character`);
    }
    throw new Error(`${name} contains an unterminated JSON string`);
  };
  const value = (): void => {
    whitespace();
    const character = text[index];
    if (character === "{") {
      object();
      return;
    }
    if (character === "[") {
      array();
      return;
    }
    if (character === '"') {
      string();
      return;
    }
    if (character === "-" || (character !== undefined && /\d/u.test(character))) {
      const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
      if (!match) throw new Error(`${name} contains invalid number`);
      index += match.length;
      return;
    }
    for (const literal of ["true", "false", "null"])
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    throw new Error(`${name} contains invalid JSON`);
  };
  const array = (): void => {
    index++;
    whitespace();
    if (text[index] === "]") {
      index++;
      return;
    }
    while (true) {
      value();
      whitespace();
      if (text[index] === "]") {
        index++;
        return;
      }
      if (text[index++] !== ",") throw new Error(`${name} contains invalid JSON array`);
      whitespace();
    }
  };
  const object = (): void => {
    index++;
    whitespace();
    const keys = new Set<string>();
    if (text[index] === "}") {
      index++;
      return;
    }
    while (true) {
      whitespace();
      if (text[index] !== '"') throw new Error(`${name} contains an invalid object key`);
      const key = string();
      if (keys.has(key)) throw new Error(`${name} contains duplicate object keys`);
      keys.add(key);
      whitespace();
      if (text[index++] !== ":") throw new Error(`${name} contains invalid JSON object`);
      value();
      whitespace();
      if (text[index] === "}") {
        index++;
        return;
      }
      if (text[index++] !== ",") throw new Error(`${name} contains invalid JSON object`);
    }
  };
  value();
  whitespace();
  if (index !== text.length) throw new Error(`${name} contains trailing JSON`);
}
