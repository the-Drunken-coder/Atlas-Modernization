#!/usr/bin/env node

import { createPrivateKey, createPublicKey, createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseDocument } from "./plugin-release-validation.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const trustPath = process.env.ATLAS_PLUGIN_CATALOG_TRUST_PATH
  ? resolve(repositoryRoot, process.env.ATLAS_PLUGIN_CATALOG_TRUST_PATH)
  : join(repositoryRoot, "surfaces", "core-cli", "assets", "plugin-trust.json");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const catalogKeyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const maxStringBytes = 2048;
const publishedVerificationGraceMs = 120_000;
const publishedVerificationRetryDelayMs = 5_000;

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "preflight":
    preflight();
    break;
  case "keygen":
    printKeyMaterial(required(args[0], "key_id"), positiveInteger(args[1], "key_epoch"));
    break;
  case "append":
    appendCatalog(required(args[0], "release document"), resolve(repositoryRoot, args[1] ?? "catalog-ledger"), args[2]);
    break;
  case "renew":
    renewCatalog(resolve(repositoryRoot, args[0] ?? "catalog-ledger"));
    break;
  case "revoke":
    revokeCatalog(
      required(args[0], "plugin_id"),
      required(args[1], "version"),
      required(args[2], "revocation reason"),
      resolve(repositoryRoot, args[3] ?? "catalog-ledger")
    );
    break;
  case "verify-published":
    await verifyPublishedCatalog(resolve(repositoryRoot, args[0] ?? "catalog-ledger"), parseVerifyPublishedArgs(args.slice(1)));
    break;
  default:
    throw new Error(
      "Usage: node scripts/plugin-release-catalog.mjs <keygen|preflight|append|renew|revoke|verify-published> ..."
    );
}

function printKeyMaterial(keyId, keyEpoch) {
  if (!catalogKeyIdPattern.test(keyId)) throw new Error("key_id must contain only letters, numbers, dot, underscore, or hyphen");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" }
  });
  process.stdout.write(
    `${JSON.stringify({
      key_id: keyId,
      key_epoch: keyEpoch,
      public_key_pem: createPublicKey({ key: publicKey, format: "der", type: "spki" }).export({ format: "pem", type: "spki" }),
      minimum_sequence: 1,
      private_key_pem: privateKey
    }, null, 2)}\n`
  );
}

function preflight() {
  const trust = readTrust();
  if (!Array.isArray(trust.keys) || trust.keys.length === 0) {
    throw new Error(
      `Plugin catalog publishing is unconfigured: ${relative(repositoryRoot, trustPath)} has no trusted Ed25519 key. ` +
        "Generate an offline Ed25519 key, publish its public key in this file with its key_id and key_epoch, " +
        "then store the matching private PEM as the protected ATLAS_PLUGIN_CATALOG_PRIVATE_KEY secret."
    );
  }
  const privateKeyText = process.env.ATLAS_PLUGIN_CATALOG_PRIVATE_KEY;
  if (!privateKeyText?.trim()) {
    throw new Error("Plugin catalog publishing is unconfigured: ATLAS_PLUGIN_CATALOG_PRIVATE_KEY is not set");
  }
  const privateKey = parsePrivateKey(privateKeyText);
  const keyId = required(process.env.ATLAS_PLUGIN_CATALOG_KEY_ID, "ATLAS_PLUGIN_CATALOG_KEY_ID");
  const keyEpoch = positiveInteger(process.env.ATLAS_PLUGIN_CATALOG_KEY_EPOCH, "ATLAS_PLUGIN_CATALOG_KEY_EPOCH");
  const configured = trust.keys.find((key) => key.key_id === keyId && key.key_epoch === keyEpoch);
  if (!configured) throw new Error(`Catalog key ${keyId} epoch ${keyEpoch} is not present in ${relative(repositoryRoot, trustPath)}`);
  if (
    !catalogKeyIdPattern.test(configured.key_id) ||
    !positiveSafeInteger(configured.key_epoch) ||
    !positiveSafeInteger(configured.minimum_sequence) ||
    typeof configured.public_key_pem !== "string"
  ) {
    throw new Error(`Catalog trust key ${keyId} has invalid key_id, key_epoch, minimum_sequence, or public_key_pem`);
  }
  let configuredPublic;
  try {
    configuredPublic = createPublicKey(configured.public_key_pem);
  } catch (error) {
    throw new Error(`Catalog trust key ${keyId} must contain a valid public Ed25519 PEM: ${error instanceof Error ? error.message : error}`);
  }
  if (configuredPublic.asymmetricKeyType !== "ed25519") throw new Error(`Catalog trust key ${keyId} must be Ed25519`);
  const privatePublic = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
  const configuredPublicBytes = configuredPublic.export({ format: "der", type: "spki" }).toString("base64");
  if (privatePublic !== configuredPublicBytes) throw new Error(`Catalog private key does not match ${keyId} in ${relative(repositoryRoot, trustPath)}`);
  process.stdout.write(`Catalog signing key ${keyId} epoch ${keyEpoch} is configured.\n`);
  return {
    keyId,
    keyEpoch,
    minimumSequence: configured.minimum_sequence,
    minimumCheckpoint: trust.minimum_checkpoint
      ? { keyEpoch: trust.minimum_checkpoint.key_epoch, sequence: trust.minimum_checkpoint.sequence }
      : null
  };
}

function appendCatalog(releasePath, ledgerDirectory, documentUrl) {
  const signing = preflight();
  const release = readJSON(resolve(repositoryRoot, releasePath));
  validateReleaseDocument(release);
  const keyId = signing.keyId;
  const keyEpoch = signing.keyEpoch;
  const ledgerPath = join(ledgerDirectory, "catalog.json");
  const signaturePath = join(ledgerDirectory, "catalog.json.sig");
  const previousBytes = existsSync(ledgerPath) ? readFileSync(ledgerPath) : undefined;
  const previous = previousBytes ? readJSON(ledgerPath) : undefined;
  const previousHash = previousBytes ? sha256(previousBytes) : null;
  if (previous) {
    validateCatalog(previous);
    verifyLedgerSignature(ledgerDirectory, previous, previousBytes);
  } else if (existsSync(signaturePath)) {
    throw new Error("Catalog ledger has a signature without catalog.json");
  }
  if (!previous && (signing.keyEpoch !== 1 || signing.minimumSequence !== 1)) {
    throw new Error("The first catalog publication must use key epoch 1 with minimum sequence 1");
  }
  if (previous && signing.keyEpoch < previous.key_epoch) {
    throw new Error(`Catalog key epoch ${signing.keyEpoch} is older than ledger epoch ${previous.key_epoch}`);
  }
  if (previous && signing.keyEpoch > previous.key_epoch + 1) {
    throw new Error(`Catalog key epoch ${signing.keyEpoch} must immediately follow ledger epoch ${previous.key_epoch}`);
  }
  if (previous && signing.keyEpoch === previous.key_epoch && signing.keyId !== previous.key_id) {
    throw new Error(`Catalog key ${signing.keyId} does not match the ledger's current key ${previous.key_id}`);
  }
  const pluginId = release.plugin_id;
  const version = release.version;
  const resolvedUrl = documentUrl ?? defaultDocumentUrl(pluginId, version);
  validateDocumentUrl(resolvedUrl, pluginId, version);
  const releaseBytes = readFileSync(resolve(repositoryRoot, releasePath));
  const releaseHash = sha256(releaseBytes);
  const previousPlugin = previous?.plugins.find((entry) => entry.plugin_id === pluginId);
  const previousRelease = previousPlugin?.releases.find((entry) => entry.version === version);
  if (previousRelease) {
    if (previousRelease.display_name !== release.display_name || previousRelease.document_sha256 !== releaseHash || previousRelease.document_url !== resolvedUrl) {
      throw new Error(`Catalog already contains ${pluginId} ${version} with different immutable bytes`);
    }
    process.stdout.write(`Catalog already contains ${pluginId} ${version} with matching immutable metadata.\n`);
    return;
  }
  const { issuedAt, expiresAt } = nextCatalogTimes(previous);
  const catalog = {
    schema: 1,
    sequence: previous
      ? signing.keyEpoch === previous.key_epoch
        ? previous.sequence + 1
        : signing.minimumSequence
      : signing.minimumSequence,
    previous_catalog_sha256: previousHash,
    issued_at: issuedAt,
    expires_at: expiresAt,
    key_epoch: keyEpoch,
    key_id: keyId,
    plugins: previous ? structuredClone(previous.plugins) : [],
  };
  const catalogPlugin = catalog.plugins.find((entry) => entry.plugin_id === pluginId);
  if (catalogPlugin) {
    catalogPlugin.releases.push({
      version,
      display_name: release.display_name,
      document_url: resolvedUrl,
      document_sha256: releaseHash,
      revoked: false,
      revocation_reason: null
    });
  } else {
    catalog.plugins.push({
      plugin_id: pluginId,
      releases: [{
        version,
        display_name: release.display_name,
        document_url: resolvedUrl,
        document_sha256: releaseHash,
        revoked: false,
        revocation_reason: null
      }]
    });
  }
  writeSignedCatalog(catalog, ledgerDirectory, signing);
  process.stdout.write(`Published catalog sequence ${catalog.sequence} for ${pluginId} ${version}.\n`);
}

function renewCatalog(ledgerDirectory) {
  const signing = preflight();
  const ledgerPath = join(ledgerDirectory, "catalog.json");
  if (!existsSync(ledgerPath)) throw new Error("Cannot renew a catalog before its first release is published");
  const previousBytes = readFileSync(ledgerPath);
  const previous = readJSON(ledgerPath);
  validateCatalog(previous);
  verifyLedgerSignature(ledgerDirectory, previous, previousBytes);
  if (signing.keyEpoch < previous.key_epoch || signing.keyEpoch > previous.key_epoch + 1) {
    throw new Error(`Catalog renewal key epoch ${signing.keyEpoch} must be the current or immediately next epoch after ${previous.key_epoch}`);
  }
  if (signing.keyEpoch === previous.key_epoch && signing.keyId !== previous.key_id) {
    throw new Error(`Catalog renewal key ${signing.keyId} does not match the ledger's current key ${previous.key_id}`);
  }
  const rotated = signing.keyEpoch !== previous.key_epoch;
  const { issuedAt, expiresAt } = nextCatalogTimes(previous);
  const catalog = {
    ...previous,
    sequence: rotated ? signing.minimumSequence : previous.sequence + 1,
    previous_catalog_sha256: sha256(previousBytes),
    issued_at: issuedAt,
    expires_at: expiresAt,
    key_epoch: signing.keyEpoch,
    key_id: signing.keyId
  };
  writeSignedCatalog(catalog, ledgerDirectory, signing);
  process.stdout.write(`Renewed catalog sequence ${catalog.sequence}.\n`);
}

function revokeCatalog(pluginId, version, reason, ledgerDirectory) {
  if (!identifierPattern.test(pluginId) || pluginId.length > 50) throw new Error("plugin_id is invalid");
  if (!semverPattern.test(version)) throw new Error("version must be a stable Semantic Version");
  if (reason.trim() !== reason || !reason || Buffer.byteLength(reason, "utf8") > maxStringBytes) throw new Error("revocation reason must be trimmed, non-empty, and at most 2048 UTF-8 bytes");
  const signing = preflight();
  const ledgerPath = join(ledgerDirectory, "catalog.json");
  if (!existsSync(ledgerPath)) throw new Error("Cannot revoke a release before its catalog entry is published");
  const previousBytes = readFileSync(ledgerPath);
  const previous = readJSON(ledgerPath);
  validateCatalog(previous);
  verifyLedgerSignature(ledgerDirectory, previous, previousBytes);
  if (signing.keyEpoch < previous.key_epoch) throw new Error(`Catalog key epoch ${signing.keyEpoch} is older than ledger epoch ${previous.key_epoch}`);
  if (signing.keyEpoch > previous.key_epoch + 1) throw new Error(`Catalog key epoch ${signing.keyEpoch} must immediately follow ledger epoch ${previous.key_epoch}`);
  if (signing.keyEpoch === previous.key_epoch && signing.keyId !== previous.key_id) {
    throw new Error(`Catalog key ${signing.keyId} does not match the ledger's current key ${previous.key_id}`);
  }
  const previousPlugin = previous.plugins.find((entry) => entry.plugin_id === pluginId);
  const previousRelease = previousPlugin?.releases.find((entry) => entry.version === version);
  if (!previousRelease) throw new Error(`Catalog does not contain ${pluginId} ${version}`);
  if (previousRelease.revoked) {
    if (previousRelease.revocation_reason !== reason) throw new Error(`Catalog already revoked ${pluginId} ${version} with a different reason`);
    process.stdout.write(`Catalog already revoked ${pluginId} ${version} with the same reason.\n`);
    return;
  }
  const catalog = structuredClone(previous);
  const release = catalog.plugins.find((entry) => entry.plugin_id === pluginId).releases.find((entry) => entry.version === version);
  release.revoked = true;
  release.revocation_reason = reason;
  catalog.sequence = signing.keyEpoch === previous.key_epoch ? previous.sequence + 1 : signing.minimumSequence;
  catalog.key_epoch = signing.keyEpoch;
  catalog.key_id = signing.keyId;
  catalog.previous_catalog_sha256 = sha256(previousBytes);
  const { issuedAt, expiresAt } = nextCatalogTimes(previous);
  catalog.issued_at = issuedAt;
  catalog.expires_at = expiresAt;
  writeSignedCatalog(catalog, ledgerDirectory, signing);
  process.stdout.write(`Revoked catalog release ${pluginId} ${version} at sequence ${catalog.sequence}.\n`);
}

function writeSignedCatalog(catalog, ledgerDirectory, signing) {
  if (signing.minimumCheckpoint && compareCheckpoint(catalog, signing.minimumCheckpoint) < 0) {
    throw new Error(
      `Catalog sequence ${catalog.sequence} at key epoch ${catalog.key_epoch} is below the configured trust checkpoint ` +
        `${signing.minimumCheckpoint.sequence} at key epoch ${signing.minimumCheckpoint.keyEpoch}`
    );
  }
  normalizeCatalog(catalog);
  validateCatalog(catalog);
  const bytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const privateKey = parsePrivateKey(required(process.env.ATLAS_PLUGIN_CATALOG_PRIVATE_KEY, "ATLAS_PLUGIN_CATALOG_PRIVATE_KEY"));
  const signature = sign(null, bytes, privateKey).toString("base64");
  const signatureBytes = Buffer.from(`${JSON.stringify({ algorithm: "ed25519", key_id: signing.keyId, signature }, null, 2)}\n`, "utf8");
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(join(ledgerDirectory, "catalog.json"), bytes);
  writeFileSync(join(ledgerDirectory, "catalog.json.sig"), signatureBytes);
}

function validateCatalog(catalog) {
  assertExactKeys(catalog, ["schema", "sequence", "previous_catalog_sha256", "issued_at", "expires_at", "key_epoch", "key_id", "plugins"], "Catalog ledger");
  if (catalog.schema !== 1 || !positiveSafeInteger(catalog.sequence) || !positiveSafeInteger(catalog.key_epoch) || !boundedString(catalog.key_id) || !catalogKeyIdPattern.test(catalog.key_id) || !Array.isArray(catalog.plugins) || catalog.plugins.length > 128) throw new Error("Catalog ledger has invalid identity");
  validateTimestamp(catalog.issued_at, "Catalog ledger issued_at");
  validateTimestamp(catalog.expires_at, "Catalog ledger expires_at");
  if (Date.parse(catalog.issued_at) > Date.now() + 5 * 60 * 1000) throw new Error("Catalog ledger issued_at is too far ahead of the publisher clock");
  if (Date.parse(catalog.expires_at) <= Date.parse(catalog.issued_at) || Date.parse(catalog.expires_at) - Date.parse(catalog.issued_at) > 30 * 24 * 60 * 60 * 1000) throw new Error("Catalog ledger expiry must be after issue and no more than 30 days later");
  if (catalog.previous_catalog_sha256 !== null && !hashPattern.test(catalog.previous_catalog_sha256)) throw new Error("Catalog ledger has an invalid previous hash");
  if (catalog.sequence === 1 && catalog.key_epoch === 1 && catalog.previous_catalog_sha256 !== null) throw new Error("First catalog must not contain a previous hash");
  if ((catalog.sequence !== 1 || catalog.key_epoch !== 1) && !hashPattern.test(catalog.previous_catalog_sha256)) throw new Error("Later catalog must chain from a previous hash");
  const seen = new Set();
  for (const plugin of catalog.plugins) {
    assertExactKeys(plugin, ["plugin_id", "releases"], "Catalog Plugin entry");
    if (!boundedString(plugin.plugin_id) || !identifierPattern.test(plugin.plugin_id) || plugin.plugin_id.length > 50 || !Array.isArray(plugin.releases) || plugin.releases.length > 256 || seen.has(plugin.plugin_id)) throw new Error("Catalog contains duplicate or malformed Plugin entries");
    seen.add(plugin.plugin_id);
    const versions = new Set();
    for (const release of plugin.releases) {
      assertExactKeys(release, ["version", "display_name", "document_url", "document_sha256", "revoked", "revocation_reason"], `Catalog ${plugin.plugin_id} release`);
      if (!boundedString(release.version) || !semverPattern.test(release.version) || versions.has(release.version) || !boundedString(release.display_name) || !release.display_name || release.display_name.trim() !== release.display_name || [...release.display_name].length > 100 || !boundedString(release.document_sha256) || !hashPattern.test(release.document_sha256) || !boundedString(release.document_url) || typeof release.revoked !== "boolean" || (release.revoked ? !boundedString(release.revocation_reason) || !release.revocation_reason.trim() : release.revocation_reason !== null)) throw new Error(`Catalog contains malformed ${plugin.plugin_id} release`);
      validateDocumentUrl(release.document_url, plugin.plugin_id, release.version);
      versions.add(release.version);
    }
  }
}

function validateTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a UTC RFC 3339 timestamp`);
  }
}

function nextCatalogTimes(previous) {
  const previousIssuedAt = previous ? Date.parse(previous.issued_at) : Number.NaN;
  const issuedAtMs = Number.isFinite(previousIssuedAt) ? Math.max(Date.now(), previousIssuedAt + 1) : Date.now();
  const issuedAt = new Date(issuedAtMs).toISOString();
  return { issuedAt, expiresAt: new Date(issuedAtMs + 30 * 24 * 60 * 60 * 1000).toISOString() };
}

function verifyLedgerSignature(ledgerDirectory, catalog, catalogBytes) {
  const signaturePath = join(ledgerDirectory, "catalog.json.sig");
  if (!existsSync(signaturePath)) throw new Error("Catalog ledger is missing catalog.json.sig");
  verifyCatalogSignature(catalog, catalogBytes, readFileSync(signaturePath));
}

function verifyCatalogSignature(catalog, catalogBytes, signatureBytes) {
  const signature = parseSignature(signatureBytes);
  if (signature.key_id !== catalog.key_id) {
    throw new Error("Catalog ledger signature does not match catalog identity");
  }
  const signatureValue = Buffer.from(signature.signature, "base64");
  const trust = readTrust();
  const key = trust.keys.find((entry) => entry.key_id === catalog.key_id && entry.key_epoch === catalog.key_epoch);
  if (!key) throw new Error(`Catalog ledger key ${catalog.key_id} epoch ${catalog.key_epoch} is not trusted`);
  if (catalog.sequence < key.minimum_sequence) throw new Error(`Catalog ledger sequence ${catalog.sequence} is below the trusted floor ${key.minimum_sequence}`);
  if (trust.minimum_checkpoint && compareCheckpoint(catalog, {
    keyEpoch: trust.minimum_checkpoint.key_epoch,
    sequence: trust.minimum_checkpoint.sequence
  }) < 0) {
    throw new Error(
      `Catalog sequence ${catalog.sequence} at key epoch ${catalog.key_epoch} is below the configured trust checkpoint ` +
        `${trust.minimum_checkpoint.sequence} at epoch ${trust.minimum_checkpoint.key_epoch}`
    );
  }
  if (!verify(null, catalogBytes, createPublicKey(key.public_key_pem), signatureValue)) {
    throw new Error("Catalog ledger signature is invalid");
  }
}

function parseSignature(bytes) {
  let signature;
  try {
    signature = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`Catalog ledger signature is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  assertExactKeys(signature, ["algorithm", "key_id", "signature"], "Catalog ledger signature");
  if (signature.algorithm !== "ed25519" || typeof signature.key_id !== "string" || !catalogKeyIdPattern.test(signature.key_id)) {
    throw new Error("Catalog ledger signature has invalid identity");
  }
  if (typeof signature.signature !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(signature.signature)) {
    throw new Error("Catalog ledger signature is not standard base64");
  }
  const signatureValue = Buffer.from(signature.signature, "base64");
  if (signatureValue.length !== 64 || signatureValue.toString("base64") !== signature.signature) {
    throw new Error("Catalog ledger signature must encode exactly 64 bytes");
  }
  return signature;
}

function parseVerifyPublishedArgs(values) {
  const options = { pluginId: null, version: null, releaseDocument: null, revoked: false };
  const optionNames = new Map([
    ["--plugin-id", "pluginId"],
    ["--version", "version"],
    ["--release-document", "releaseDocument"]
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--revoked") {
      if (options.revoked) throw new Error("verify-published received duplicate --revoked");
      options.revoked = true;
      continue;
    }
    const property = optionNames.get(value);
    if (!property || index + 1 >= values.length || values[index + 1].startsWith("--")) {
      throw new Error(`Unknown or incomplete verify-published option ${value}`);
    }
    if (options[property] !== null) throw new Error(`verify-published received duplicate ${value}`);
    options[property] = values[index + 1];
    index += 1;
  }
  if ((options.pluginId === null) !== (options.version === null)) {
    throw new Error("verify-published requires both --plugin-id and --version");
  }
  if (options.pluginId !== null) {
    if (!identifierPattern.test(options.pluginId) || options.pluginId.length > 50) throw new Error("verify-published plugin_id is invalid");
    if (!semverPattern.test(options.version)) throw new Error("verify-published version is invalid");
  }
  if (options.releaseDocument !== null && options.pluginId === null) {
    throw new Error("verify-published --release-document requires --plugin-id and --version");
  }
  if (options.revoked && options.pluginId === null) {
    throw new Error("verify-published --revoked requires --plugin-id and --version");
  }
  return options;
}

async function verifyPublishedCatalog(ledgerDirectory, options) {
  const ledgerPath = join(ledgerDirectory, "catalog.json");
  const signaturePath = join(ledgerDirectory, "catalog.json.sig");
  if (!existsSync(ledgerPath) || !existsSync(signaturePath)) throw new Error("Catalog ledger is missing catalog.json or catalog.json.sig");
  const localBytes = readFileSync(ledgerPath);
  const localSignatureBytes = readFileSync(signaturePath);
  const localCatalog = readJSON(ledgerPath);
  validateCatalog(localCatalog);
  verifyLedgerSignature(ledgerDirectory, localCatalog, localBytes);
  const trust = readTrust();
  const remoteCatalogURL = new URL(trust.catalog_url);
  const remoteSignatureURL = new URL(remoteCatalogURL);
  remoteSignatureURL.pathname = `${remoteSignatureURL.pathname}.sig`;
  let remoteBytes;
  let remoteSignatureBytes;
  let lastCatalogMatches = false;
  let lastSignatureMatches = false;
  const deadline = Date.now() + publishedVerificationGraceMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      if (lastCatalogMatches && !lastSignatureMatches) {
        throw new Error("Stable catalog signature bytes did not catch up with the protected ledger within 120 seconds");
      }
      throw new Error("Stable catalog bytes did not catch up with the protected ledger within 120 seconds");
    }
    try {
      const timeoutMs = Math.min(15_000, remainingMs);
      remoteBytes = await fetchBounded(remoteCatalogURL, 4 * 1024 * 1024, "stable catalog", timeoutMs);
      remoteSignatureBytes = await fetchBounded(remoteSignatureURL, 1024, "stable catalog signature", Math.min(15_000, deadline - Date.now()));
    } catch (error) {
      if (!retryablePublishedFetchError(error) || deadline - Date.now() <= 0) throw error;
      await waitForPublishedRetry(deadline);
      continue;
    }
    lastCatalogMatches = remoteBytes.equals(localBytes);
    lastSignatureMatches = remoteSignatureBytes.equals(localSignatureBytes);
    if (lastCatalogMatches && lastSignatureMatches) break;
    const staleCatalog = parseJSONBytes(remoteBytes, "stable catalog");
    validateCatalog(staleCatalog);
    parseSignature(remoteSignatureBytes);
    await waitForPublishedRetry(deadline);
  }
  const remoteCatalog = parseJSONBytes(remoteBytes, "stable catalog");
  validateCatalog(remoteCatalog);
  verifyCatalogSignature(remoteCatalog, remoteBytes, remoteSignatureBytes);
  if (remoteCatalog.sequence !== localCatalog.sequence || remoteCatalog.key_epoch !== localCatalog.key_epoch || remoteCatalog.key_id !== localCatalog.key_id) {
    throw new Error("Stable catalog identity or sequence does not match the protected ledger");
  }
  if (options.pluginId !== null) {
    const release = remoteCatalog.plugins.find((plugin) => plugin.plugin_id === options.pluginId)?.releases.find((entry) => entry.version === options.version);
    if (!release) throw new Error(`Stable catalog does not contain ${options.pluginId} ${options.version}`);
    if (options.revoked !== release.revoked) throw new Error(`Stable catalog revocation state for ${options.pluginId} ${options.version} is unexpected`);
    if (options.releaseDocument !== null) {
      const releasePath = resolve(repositoryRoot, options.releaseDocument);
      const releaseBytes = readFileSync(releasePath);
      const releaseDocument = parseJSONBytes(releaseBytes, "release document");
      validateReleaseDocument(releaseDocument);
      if (releaseDocument.plugin_id !== options.pluginId || releaseDocument.version !== options.version) throw new Error("Release document identity does not match the requested catalog entry");
      if (sha256(releaseBytes) !== release.document_sha256 || releaseDocument.display_name !== release.display_name || defaultDocumentUrl(options.pluginId, options.version) !== release.document_url) {
        throw new Error("Stable catalog release metadata does not match the release document");
      }
    }
  }
  process.stdout.write(`Verified stable catalog sequence ${remoteCatalog.sequence} at ${trust.catalog_url}.\n`);
}

async function fetchBounded(url, limit, label, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    if (!response.body) throw new Error(`${label} returned an empty body`);
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error(`${label} exceeded the ${limit}-byte response limit`);
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`${label} request timed out after ${timeoutMs} milliseconds`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function retryablePublishedFetchError(error) {
  return error instanceof Error && (/returned HTTP [45]\d\d/u.test(error.message) || /request timed out/u.test(error.message));
}

async function waitForPublishedRetry(deadline) {
  const delay = Math.min(publishedVerificationRetryDelayMs, deadline - Date.now());
  if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
}

function parseJSONBytes(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function normalizeCatalog(catalog) {
  catalog.plugins.sort((left, right) => left.plugin_id.localeCompare(right.plugin_id));
  for (const plugin of catalog.plugins) plugin.releases.sort((left, right) => compareSemver(left.version, right.version));
}

function readTrust() {
  const trust = readJSON(trustPath);
  assertExactKeys(trust, ["schema", "catalog_url", "keys", "minimum_checkpoint"], relative(repositoryRoot, trustPath));
  if (trust.schema !== 1 || typeof trust.catalog_url !== "string" || !Array.isArray(trust.keys)) throw new Error(`${relative(repositoryRoot, trustPath)} must define schema, catalog_url, and keys`);
  let catalogURL;
  try {
    catalogURL = new URL(trust.catalog_url);
  } catch {
    throw new Error(`${relative(repositoryRoot, trustPath)} catalog_url must be a URL`);
  }
  if (catalogURL.protocol !== "https:" || catalogURL.username || catalogURL.password || catalogURL.search || catalogURL.hash) {
    throw new Error(`${relative(repositoryRoot, trustPath)} catalog_url must be HTTPS without credentials, query, or fragment`);
  }
  if (trust.keys.length > 32) throw new Error(`${relative(repositoryRoot, trustPath)} contains too many keys`);
  const keyIds = new Set();
  const keyEpochs = new Set();
  for (const [index, key] of trust.keys.entries()) {
    assertExactKeys(key, ["key_id", "key_epoch", "public_key_pem", "minimum_sequence"], `${relative(repositoryRoot, trustPath)} keys[${index}]`);
    if (typeof key.key_id !== "string" || !catalogKeyIdPattern.test(key.key_id) || keyIds.has(key.key_id)) throw new Error(`${relative(repositoryRoot, trustPath)} contains a duplicate or invalid key_id`);
    keyIds.add(key.key_id);
    if (!positiveSafeInteger(key.key_epoch) || keyEpochs.has(key.key_epoch)) throw new Error(`${relative(repositoryRoot, trustPath)} contains a duplicate or invalid key_epoch`);
    keyEpochs.add(key.key_epoch);
    if (typeof key.public_key_pem !== "string" || !positiveSafeInteger(key.minimum_sequence)) throw new Error(`${relative(repositoryRoot, trustPath)} has an invalid trust key`);
    try {
      const parsedKey = createPublicKey(key.public_key_pem);
      if (parsedKey.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    } catch (error) {
      throw new Error(`${relative(repositoryRoot, trustPath)} key ${key.key_id} must be a valid public Ed25519 PEM: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (trust.minimum_checkpoint !== null) {
    assertExactKeys(trust.minimum_checkpoint, ["key_epoch", "sequence"], `${relative(repositoryRoot, trustPath)} minimum_checkpoint`);
    if (!positiveSafeInteger(trust.minimum_checkpoint.key_epoch) || !positiveSafeInteger(trust.minimum_checkpoint.sequence)) {
      throw new Error(`${relative(repositoryRoot, trustPath)} minimum_checkpoint must contain positive safe integers`);
    }
  }
  return trust;
}

function parsePrivateKey(value) {
  try {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("key is not Ed25519");
    return key;
  } catch (error) {
    throw new Error(`ATLAS_PLUGIN_CATALOG_PRIVATE_KEY must be a valid Ed25519 PEM: ${error instanceof Error ? error.message : error}`);
  }
}

function defaultDocumentUrl(pluginId, version) {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  return `${server}/${repository}/releases/download/atlas-plugin-${pluginId}-v${version}/${pluginId}-${version}.atlas-plugin`;
}

function validateDocumentUrl(url, pluginId, version) {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const expected = `${server}/${repository}/releases/download/atlas-plugin-${pluginId}-v${version}/${pluginId}-${version}.atlas-plugin`;
  if (url !== expected) throw new Error(`Release document URL must exactly equal ${expected}`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function compareCheckpoint(catalog, checkpoint) {
  return catalog.key_epoch - checkpoint.keyEpoch || catalog.sequence - checkpoint.sequence;
}

function positiveInteger(value, label) {
  if (!/^\d+$/u.test(value ?? "") || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${relative(repositoryRoot, path)} is not valid JSON: ${error instanceof Error ? error.message : error}`); }
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

function boundedString(value) { return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxStringBytes; }

function assertExactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")) throw new Error(`${label} must contain exactly: ${keys.join(", ")}`);
}
