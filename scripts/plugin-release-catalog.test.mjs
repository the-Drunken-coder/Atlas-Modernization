import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repositoryRoot, "scripts", "plugin-release-catalog.mjs");

function run(args, environment) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment, GITHUB_REPOSITORY: "the-Drunken-coder/Atlas-Modernization" }
  });
}

function mockFetchPreload(directory) {
  const preloadPath = join(directory, "mock-fetch.mjs");
  writeFileSync(preloadPath, `
import { appendFileSync, readFileSync } from "node:fs";
const catalog = readFileSync(process.env.ATLAS_TEST_REMOTE_CATALOG);
const signature = readFileSync(process.env.ATLAS_TEST_REMOTE_SIGNATURE);
const staleCatalog = process.env.ATLAS_TEST_STALE_CATALOG ? readFileSync(process.env.ATLAS_TEST_STALE_CATALOG) : null;
const staleSignature = process.env.ATLAS_TEST_STALE_SIGNATURE ? readFileSync(process.env.ATLAS_TEST_STALE_SIGNATURE) : null;
let calls = 0;
let forceExpired = false;
if (process.env.ATLAS_TEST_REMOTE_MODE === "expired-mismatch") {
  const originalDateNow = Date.now.bind(Date);
  const startTime = originalDateNow();
  Date.now = () => {
    return forceExpired ? startTime + 121_000 : originalDateNow();
  };
}
globalThis.fetch = async (url) => {
  calls += 1;
  if (process.env.ATLAS_TEST_FETCH_LOG) appendFileSync(process.env.ATLAS_TEST_FETCH_LOG, calls + ": " + String(url) + "\\n");
  if (process.env.ATLAS_TEST_REMOTE_MODE === "oversized") {
    return new Response(Buffer.alloc(4 * 1024 * 1024 + 1), { status: 200 });
  }
  if (process.env.ATLAS_TEST_REMOTE_MODE === "stale-once" && calls === 1 && staleCatalog) {
    return new Response(staleCatalog, { status: 200 });
  }
  if (process.env.ATLAS_TEST_REMOTE_MODE === "stale-signature-once" && calls === 2 && staleSignature) {
    return new Response(staleSignature, { status: 200 });
  }
  if (process.env.ATLAS_TEST_REMOTE_MODE === "expired-mismatch" && calls === 2) forceExpired = true;
  return new Response(String(url).endsWith(".sig") ? signature : catalog, { status: 200 });
};
`);
  return `--import=${preloadPath}`;
}

function releaseDocument(version = "1.0.0") {
  return {
    schema: 1,
    plugin_id: "fixture",
    version,
    display_name: "Fixture",
    lifecycle: "query_only",
    image: `ghcr.io/the-drunken-coder/atlas-fixture@sha256:${"a".repeat(64)}`,
    core_to_plugin_protocol_major: 1,
    plugin_to_source_gateway_protocol_major: 1,
    atlas_protocol_revision: null,
    interactions: ["map_area"],
    source_connector: null
  };
}

function sourceConnector() {
  return {
    id: "fixture",
    origin: "https://example.test",
    routes: [{
      method: "GET",
      path_prefix: "/records",
      allowed_query_names: [],
      allowed_request_headers: [],
      allowed_response_headers: ["content-type"],
      read_only: true,
      cache: { ttl_ms: 0 },
      retry: { max_retries: 0, statuses: [], failures: [], idempotency_header: "" }
    }],
    secret_headers: {},
    egress: { allow_private: false, allow_loopback: false, allow_link_local: false },
    limits: {
      timeout_ms: 15_000,
      max_request_bytes: 65_536,
      max_response_bytes: 16 << 20,
      max_concurrency: 1,
      max_header_count: 64,
      max_header_bytes: 65_536
    },
    rate: { requests_per_second: 1 },
    circuit_breaker: { failures: 3, open_ms: 30_000 }
  };
}

function catalogFixture(directory) {
  const trustPath = join(directory, "plugin-trust.json");
  const ledgerPath = join(directory, "ledger");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" }
  });
  writeFileSync(
    trustPath,
    JSON.stringify({
      schema: 1,
      catalog_url: "https://example.test/catalog.json",
      minimum_checkpoint: { key_epoch: 1, sequence: 1 },
      keys: [{ key_id: "test-key", key_epoch: 1, public_key_pem: publicKey, minimum_sequence: 1 }]
    })
  );
  const releasePath = join(directory, "fixture.atlas-plugin");
  writeFileSync(releasePath, `${JSON.stringify(releaseDocument(), null, 2)}\n`);
  const environment = {
    ATLAS_PLUGIN_CATALOG_TRUST_PATH: trustPath,
    ATLAS_PLUGIN_CATALOG_KEY_ID: "test-key",
    ATLAS_PLUGIN_CATALOG_KEY_EPOCH: "1",
    ATLAS_PLUGIN_CATALOG_PRIVATE_KEY: privateKey
  };
  return { ledgerPath, releasePath, privateKey, publicKey, environment };
}

function expireCatalog(fixture) {
  const catalogPath = join(fixture.ledgerPath, "catalog.json");
  const signaturePath = join(fixture.ledgerPath, "catalog.json.sig");
  const previousBytes = readFileSync(catalogPath);
  const previous = JSON.parse(previousBytes);
  const expired = {
    ...previous,
    issued_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-01-02T00:00:00.000Z"
  };
  const expiredBytes = Buffer.from(`${JSON.stringify(expired, null, 2)}\n`);
  writeFileSync(catalogPath, expiredBytes);
  writeFileSync(
    signaturePath,
    `${JSON.stringify({
      algorithm: "ed25519",
      key_id: "test-key",
      signature: sign(null, expiredBytes, fixture.privateKey).toString("base64")
    }, null, 2)}\n`
  );
  return { previousBytes, expiredBytes, expired };
}

test("renews an expired matching append while preserving fresh idempotent bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-catalog-append-expired-"));
  try {
    const fixture = catalogFixture(directory);
    assert.equal(run(["append", fixture.releasePath, fixture.ledgerPath], fixture.environment).status, 0);
    const expired = expireCatalog(fixture);
    const renewed = run(["append", fixture.releasePath, fixture.ledgerPath], fixture.environment);
    assert.equal(renewed.status, 0, renewed.stderr);
    const catalogPath = join(fixture.ledgerPath, "catalog.json");
    const signaturePath = join(fixture.ledgerPath, "catalog.json.sig");
    const renewedBytes = readFileSync(catalogPath);
    const renewedCatalog = JSON.parse(renewedBytes);
    const renewedSignature = JSON.parse(readFileSync(signaturePath));
    assert.equal(renewedCatalog.sequence, 2);
    assert.equal(renewedCatalog.previous_catalog_sha256, `sha256:${createHash("sha256").update(expired.expiredBytes).digest("hex")}`);
    assert.ok(Date.parse(renewedCatalog.expires_at) > Date.now());
    assert.deepEqual(renewedCatalog.plugins, expired.expired.plugins);
    assert.equal(
      verify(null, renewedBytes, createPublicKey(fixture.publicKey), Buffer.from(renewedSignature.signature, "base64")),
      true
    );
    const repeat = run(["append", fixture.releasePath, fixture.ledgerPath], fixture.environment);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.deepEqual(readFileSync(catalogPath), renewedBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renews an expired matching revoke and leaves a fresh repeat byte stable", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-catalog-revoke-expired-"));
  try {
    const fixture = catalogFixture(directory);
    assert.equal(run(["append", fixture.releasePath, fixture.ledgerPath], fixture.environment).status, 0);
    expireCatalog(fixture);
    assert.equal(run(["revoke", "fixture", "1.0.0", "security issue", fixture.ledgerPath], fixture.environment).status, 0);
    const catalogPath = join(fixture.ledgerPath, "catalog.json");
    const signaturePath = join(fixture.ledgerPath, "catalog.json.sig");
    const renewedBytes = readFileSync(catalogPath);
    const renewedCatalog = JSON.parse(renewedBytes);
    const renewedSignature = JSON.parse(readFileSync(signaturePath));
    assert.equal(renewedCatalog.sequence, 2);
    assert.equal(renewedCatalog.plugins[0].releases[0].revoked, true);
    assert.equal(renewedCatalog.plugins[0].releases[0].revocation_reason, "security issue");
    assert.ok(Date.parse(renewedCatalog.expires_at) > Date.now());
    assert.equal(
      verify(null, renewedBytes, createPublicKey(fixture.publicKey), Buffer.from(renewedSignature.signature, "base64")),
      true
    );
    const repeat = run(["revoke", "fixture", "1.0.0", "security issue", fixture.ledgerPath], fixture.environment);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.deepEqual(readFileSync(catalogPath), renewedBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a currently expired published catalog", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-catalog-published-expired-"));
  try {
    const fixture = catalogFixture(directory);
    assert.equal(run(["append", fixture.releasePath, fixture.ledgerPath], fixture.environment).status, 0);
    expireCatalog(fixture);
    const result = run(["verify-published", fixture.ledgerPath], {
      ...fixture.environment,
      ATLAS_TEST_REMOTE_CATALOG: join(fixture.ledgerPath, "catalog.json"),
      ATLAS_TEST_REMOTE_SIGNATURE: join(fixture.ledgerPath, "catalog.json.sig"),
      NODE_OPTIONS: mockFetchPreload(directory)
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Protected catalog ledger is expired/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publishes and renews a signed append-only catalog with exact release URLs", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-catalog-"));
  try {
    const trustPath = join(directory, "plugin-trust.json");
    const ledgerPath = join(directory, "ledger");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" }
    });
    writeFileSync(
      trustPath,
      JSON.stringify({
        schema: 1,
        catalog_url: "https://example.test/catalog.json",
        minimum_checkpoint: { key_epoch: 1, sequence: 1 },
        keys: [{ key_id: "test-key", key_epoch: 1, public_key_pem: publicKey, minimum_sequence: 1 }]
      })
    );
    const releasePath = join(directory, "fixture.atlas-plugin");
    writeFileSync(releasePath, `${JSON.stringify(releaseDocument(), null, 2)}\n`);
    const environment = {
      ATLAS_PLUGIN_CATALOG_TRUST_PATH: trustPath,
      ATLAS_PLUGIN_CATALOG_KEY_ID: "test-key",
      ATLAS_PLUGIN_CATALOG_KEY_EPOCH: "1",
      ATLAS_PLUGIN_CATALOG_PRIVATE_KEY: privateKey
    };

    const first = run(["append", releasePath, ledgerPath], environment);
    assert.equal(first.status, 0, first.stderr);
    const catalogPath = join(ledgerPath, "catalog.json");
    const signaturePath = join(ledgerPath, "catalog.json.sig");
    const firstBytes = readFileSync(catalogPath);
    const firstCatalog = JSON.parse(firstBytes);
    const firstSignatureBytes = readFileSync(signaturePath);
    const firstSignature = JSON.parse(firstSignatureBytes);
    assert.equal(firstCatalog.sequence, 1);
    assert.equal(firstCatalog.previous_catalog_sha256, null);
    assert.equal(firstCatalog.plugins[0].releases[0].document_url, "https://github.com/the-Drunken-coder/Atlas-Modernization/releases/download/atlas-plugin-fixture-v1.0.0/fixture-1.0.0.atlas-plugin");
    assert.equal(firstSignature.key_id, "test-key");
    assert.equal(firstSignature.algorithm, "ed25519");
    assert.equal(
      verify(null, firstBytes, createPublicKey(publicKey), Buffer.from(firstSignature.signature, "base64")),
      true
    );

    const fetchEnvironment = {
      ...environment,
      ATLAS_TEST_REMOTE_CATALOG: catalogPath,
      ATLAS_TEST_REMOTE_SIGNATURE: signaturePath,
      NODE_OPTIONS: mockFetchPreload(directory)
    };
    const published = run(["verify-published", ledgerPath, "--plugin-id", "fixture", "--version", "1.0.0", "--release-document", releasePath], fetchEnvironment);
    assert.equal(published.status, 0, published.stderr);
    const alteredRemotePath = join(directory, "altered-catalog.json");
    writeFileSync(alteredRemotePath, Buffer.from("{}"));
    const alteredFetchLog = join(directory, "altered-fetch.log");
    const altered = run(["verify-published", ledgerPath], {
      ...fetchEnvironment,
      ATLAS_TEST_REMOTE_CATALOG: alteredRemotePath,
      ATLAS_TEST_FETCH_LOG: alteredFetchLog
    });
    assert.notEqual(altered.status, 0);
    assert.match(altered.stderr, /Catalog ledger must contain exactly|Catalog ledger has invalid identity/);
    assert.equal(readFileSync(alteredFetchLog, "utf8").trim().split("\n").length, 2);
    const malformedSignaturePath = join(directory, "malformed-catalog.json.sig");
    const malformedSignatureFetchLog = join(directory, "malformed-signature-fetch.log");
    writeFileSync(malformedSignaturePath, Buffer.from("{}"));
    const malformedSignature = run(["verify-published", ledgerPath], {
      ...fetchEnvironment,
      ATLAS_TEST_REMOTE_SIGNATURE: malformedSignaturePath,
      ATLAS_TEST_FETCH_LOG: malformedSignatureFetchLog
    });
    assert.notEqual(malformedSignature.status, 0);
    assert.match(malformedSignature.stderr, /Catalog ledger signature must contain exactly/);
    assert.equal(readFileSync(malformedSignatureFetchLog, "utf8").trim().split("\n").length, 2);
    const wrongReleasePath = join(directory, "wrong.atlas-plugin");
    writeFileSync(wrongReleasePath, `${JSON.stringify({ ...releaseDocument(), display_name: "Wrong" }, null, 2)}\n`);
    const wrongRelease = run(["verify-published", ledgerPath, "--plugin-id", "fixture", "--version", "1.0.0", "--release-document", wrongReleasePath], fetchEnvironment);
    assert.notEqual(wrongRelease.status, 0);
    assert.match(wrongRelease.stderr, /release metadata does not match/);
    const oversized = run(["verify-published", ledgerPath], {
      ...fetchEnvironment,
      ATLAS_TEST_REMOTE_MODE: "oversized"
    });
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /exceeded the 4194304-byte response limit/);

    const duplicate = run(["append", releasePath, ledgerPath], environment);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.deepEqual(readFileSync(catalogPath), firstBytes);

    writeFileSync(catalogPath, Buffer.from(firstBytes.toString().replace('"display_name": "Fixture"', '"display_name": "FixTure"')));
    const tampered = run(["append", releasePath, ledgerPath], environment);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /signature is invalid/);
    writeFileSync(catalogPath, firstBytes);

    const wrongURL = run(["append", releasePath, ledgerPath, "https://example.test/wrong"], environment);
    assert.notEqual(wrongURL.status, 0);
    assert.match(wrongURL.stderr, /document URL must exactly equal/);

    const catalogBeforeInvalidRelease = readFileSync(catalogPath);
    const oversizedReleasePath = join(directory, "oversized-release.atlas-plugin");
    const oversizedRelease = releaseDocument("1.0.1");
    oversizedRelease.source_connector = sourceConnector();
    oversizedRelease.source_connector.routes[0].allowed_query_names = Array.from({ length: 100_000 }, (_, index) => `query_${index}`);
    const oversizedReleaseBytes = Buffer.from(`${JSON.stringify(oversizedRelease, null, 2)}\n`);
    assert.ok(oversizedReleaseBytes.byteLength > 1 << 20);
    writeFileSync(oversizedReleasePath, oversizedReleaseBytes);
    const catalogBeforeOversizedRelease = readFileSync(catalogPath);
    const signatureBeforeOversizedRelease = readFileSync(signaturePath);
    const oversizedReleaseResult = run(["append", oversizedReleasePath, ledgerPath], environment);
    assert.notEqual(oversizedReleaseResult.status, 0);
    assert.match(oversizedReleaseResult.stderr, /Release document exceeds the 1048576-byte limit/);
    assert.deepEqual(readFileSync(catalogPath), catalogBeforeOversizedRelease);
    assert.deepEqual(readFileSync(signaturePath), signatureBeforeOversizedRelease);

    const invalidRoutePath = join(directory, "invalid-route.atlas-plugin");
    const invalidRouteDocument = { ...releaseDocument("1.0.1"), source_connector: sourceConnector() };
    invalidRouteDocument.source_connector.routes[0].path_prefix = "//records";
    writeFileSync(invalidRoutePath, `${JSON.stringify(invalidRouteDocument, null, 2)}\n`);
    const invalidRoute = run(["append", invalidRoutePath, ledgerPath], environment);
    assert.notEqual(invalidRoute.status, 0);
    assert.match(invalidRoute.stderr, /path_prefix is invalid/);
    assert.deepEqual(readFileSync(catalogPath), catalogBeforeInvalidRelease);

    const invalidPolicyPath = join(directory, "invalid-policy.atlas-plugin");
    const invalidPolicyDocument = { ...releaseDocument("1.0.1"), source_connector: sourceConnector() };
    const invalidPolicyRoute = invalidPolicyDocument.source_connector.routes[0];
    invalidPolicyRoute.read_only = false;
    invalidPolicyRoute.allowed_request_headers = [];
    invalidPolicyRoute.retry = { max_retries: 1, statuses: [503], failures: [], idempotency_header: "idempotency-key" };
    writeFileSync(invalidPolicyPath, `${JSON.stringify(invalidPolicyDocument, null, 2)}\n`);
    const invalidPolicy = run(["append", invalidPolicyPath, ledgerPath], environment);
    assert.notEqual(invalidPolicy.status, 0);
    assert.match(invalidPolicy.stderr, /must appear in allowed_request_headers/);
    assert.deepEqual(readFileSync(catalogPath), catalogBeforeInvalidRelease);

    const oversizedReason = run(["revoke", "fixture", "1.0.0", "é".repeat(1025), ledgerPath], environment);
    assert.notEqual(oversizedReason.status, 0);
    assert.match(oversizedReason.stderr, /2048 UTF-8 bytes/);
    assert.deepEqual(readFileSync(catalogPath), catalogBeforeInvalidRelease);

    const renewed = run(["renew", ledgerPath], environment);
    assert.equal(renewed.status, 0, renewed.stderr);
    const renewedCatalog = JSON.parse(readFileSync(catalogPath));
    assert.equal(renewedCatalog.sequence, 2);
    assert.equal(renewedCatalog.previous_catalog_sha256, `sha256:${createHash("sha256").update(firstBytes).digest("hex")}`);
    const renewedSignature = JSON.parse(readFileSync(signaturePath));
    assert.equal(verify(null, readFileSync(catalogPath), createPublicKey(publicKey), Buffer.from(renewedSignature.signature, "base64")), true);
    const staleCatalogPath = join(directory, "stale-catalog.json");
    const staleSignaturePath = join(directory, "stale-catalog.json.sig");
    writeFileSync(staleCatalogPath, firstBytes);
    writeFileSync(staleSignaturePath, firstSignatureBytes);
    const staleSignatureOnly = run(["verify-published", ledgerPath], {
      ...fetchEnvironment,
      ATLAS_TEST_STALE_SIGNATURE: staleSignaturePath,
      ATLAS_TEST_REMOTE_MODE: "stale-signature-once"
    });
    assert.equal(staleSignatureOnly.status, 0, staleSignatureOnly.stderr);
    const staleOnce = run(["verify-published", ledgerPath], {
      ...fetchEnvironment,
      ATLAS_TEST_STALE_CATALOG: staleCatalogPath,
      ATLAS_TEST_STALE_SIGNATURE: staleSignaturePath,
      ATLAS_TEST_REMOTE_MODE: "stale-once"
    });
    assert.equal(staleOnce.status, 0, staleOnce.stderr);
    const boundedFetchLog = join(directory, "bounded-fetch.log");
    const boundedMismatch = run(["verify-published", ledgerPath], {
      ...fetchEnvironment,
      ATLAS_TEST_REMOTE_CATALOG: staleCatalogPath,
      ATLAS_TEST_REMOTE_SIGNATURE: staleSignaturePath,
      ATLAS_TEST_REMOTE_MODE: "expired-mismatch",
      ATLAS_TEST_FETCH_LOG: boundedFetchLog
    });
    assert.notEqual(boundedMismatch.status, 0);
    assert.match(boundedMismatch.stderr, /within 120 seconds/);
    assert.equal(readFileSync(boundedFetchLog, "utf8").trim().split("\n").length, 2);

    writeFileSync(releasePath, `${JSON.stringify(releaseDocument("1.1.0"), null, 2)}\n`);
    const second = run(["append", releasePath, ledgerPath], environment);
    assert.equal(second.status, 0, second.stderr);
    const multiVersionCatalog = JSON.parse(readFileSync(catalogPath));
    assert.equal(multiVersionCatalog.sequence, 3);
    assert.equal(multiVersionCatalog.plugins.length, 1);
    assert.deepEqual(multiVersionCatalog.plugins[0].releases.map((release) => release.version), ["1.0.0", "1.1.0"]);

    const revoke = run(["revoke", "fixture", "1.0.0", "security issue", ledgerPath], environment);
    assert.equal(revoke.status, 0, revoke.stderr);
    const revokedBytes = readFileSync(catalogPath);
    const revokedCatalog = JSON.parse(revokedBytes);
    assert.equal(revokedCatalog.sequence, 4);
    assert.equal(revokedCatalog.plugins.length, 1);
    assert.deepEqual(revokedCatalog.plugins[0].releases.map((release) => [release.version, release.revoked]), [["1.0.0", true], ["1.1.0", false]]);
    assert.equal(revokedCatalog.plugins[0].releases[0].revocation_reason, "security issue");
    assert.equal(revokedCatalog.plugins[0].releases[0].document_sha256, multiVersionCatalog.plugins[0].releases[0].document_sha256);
    assert.equal(revokedCatalog.plugins[0].releases[0].document_url, multiVersionCatalog.plugins[0].releases[0].document_url);
    const malformedReasonCatalog = JSON.parse(revokedBytes);
    malformedReasonCatalog.plugins[0].releases[0].revocation_reason = "é".repeat(1025);
    writeFileSync(catalogPath, `${JSON.stringify(malformedReasonCatalog, null, 2)}\n`);
    const malformedReason = run(["renew", ledgerPath], environment);
    assert.notEqual(malformedReason.status, 0);
    assert.match(malformedReason.stderr, /malformed fixture release/);
    writeFileSync(catalogPath, revokedBytes);
    const repeatedRevoke = run(["revoke", "fixture", "1.0.0", "security issue", ledgerPath], environment);
    assert.equal(repeatedRevoke.status, 0, repeatedRevoke.stderr);
    assert.deepEqual(readFileSync(catalogPath), revokedBytes);
    const conflictingRevoke = run(["revoke", "fixture", "1.0.0", "different reason", ledgerPath], environment);
    assert.notEqual(conflictingRevoke.status, 0);
    assert.match(conflictingRevoke.stderr, /different reason/);

    const revokedSignatureBytes = readFileSync(signaturePath);
    const oversizedCatalog = {
      ...revokedCatalog,
      plugins: Array.from({ length: 128 }, (_, pluginIndex) => {
        const pluginId = `plugin_${String(pluginIndex).padStart(3, "0")}`;
        return {
          plugin_id: pluginId,
          releases: Array.from({ length: 256 }, (_, releaseIndex) => {
            const version = `1.${Math.floor(releaseIndex / 100)}.${releaseIndex % 100}`;
            return {
              version,
              display_name: `Plugin ${pluginIndex}`,
              document_url: `https://github.com/the-Drunken-coder/Atlas-Modernization/releases/download/atlas-plugin-${pluginId}-v${version}/${pluginId}-${version}.atlas-plugin`,
              document_sha256: `sha256:${"a".repeat(64)}`,
              revoked: false,
              revocation_reason: null
            };
          })
        };
      })
    };
    const oversizedCatalogBytes = Buffer.from(`${JSON.stringify(oversizedCatalog, null, 2)}\n`);
    assert.ok(oversizedCatalogBytes.byteLength > 4 * 1024 * 1024);
    const oversizedCatalogSignatureBytes = Buffer.from(`${JSON.stringify({
      algorithm: "ed25519",
      key_id: "test-key",
      signature: sign(null, oversizedCatalogBytes, privateKey).toString("base64")
    }, null, 2)}\n`);
    writeFileSync(catalogPath, oversizedCatalogBytes);
    writeFileSync(signaturePath, oversizedCatalogSignatureBytes);
    const oversizedCatalogBeforeRenew = readFileSync(catalogPath);
    const oversizedSignatureBeforeRenew = readFileSync(signaturePath);
    const oversizedRenew = run(["renew", ledgerPath], environment);
    assert.notEqual(oversizedRenew.status, 0);
    assert.match(oversizedRenew.stderr, /Catalog ledger exceeds the 4194304-byte limit/);
    assert.deepEqual(readFileSync(catalogPath), oversizedCatalogBeforeRenew);
    assert.deepEqual(readFileSync(signaturePath), oversizedSignatureBeforeRenew);
    writeFileSync(catalogPath, revokedBytes);
    writeFileSync(signaturePath, revokedSignatureBytes);

    const { privateKey: rotatedPrivateKey, publicKey: rotatedPublicKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" }
    });
    const trust = JSON.parse(readFileSync(trustPath, "utf8"));
    trust.keys.push({
      key_id: "rotated-key",
      key_epoch: 2,
      public_key_pem: rotatedPublicKey,
      minimum_sequence: 7
    });
    writeFileSync(trustPath, JSON.stringify(trust));
    const rotated = run(["renew", ledgerPath], {
      ...environment,
      ATLAS_PLUGIN_CATALOG_KEY_ID: "rotated-key",
      ATLAS_PLUGIN_CATALOG_KEY_EPOCH: "2",
      ATLAS_PLUGIN_CATALOG_PRIVATE_KEY: rotatedPrivateKey
    });
    assert.equal(rotated.status, 0, rotated.stderr);
    const rotatedCatalog = JSON.parse(readFileSync(catalogPath));
    assert.equal(rotatedCatalog.sequence, 7);
    assert.equal(rotatedCatalog.key_epoch, 2);
    assert.equal(rotatedCatalog.key_id, "rotated-key");
    assert.equal(rotatedCatalog.previous_catalog_sha256, `sha256:${createHash("sha256").update(revokedBytes).digest("hex")}`);
    const rotatedSignature = JSON.parse(readFileSync(signaturePath));
    assert.equal(
      verify(
        null,
        readFileSync(catalogPath),
        createPublicKey(rotatedPublicKey),
        Buffer.from(rotatedSignature.signature, "base64")
      ),
      true
    );
    assert.deepEqual(rotatedCatalog.plugins, revokedCatalog.plugins);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails clearly when stable catalog trust is unconfigured", () => {
  const result = run(["preflight"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publishing is unconfigured/);
  assert.match(result.stderr, /no trusted Ed25519 key/);
});

test("refuses to publish below the configured trust checkpoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-catalog-checkpoint-"));
  try {
    const trustPath = join(directory, "plugin-trust.json");
    const ledgerPath = join(directory, "ledger");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" }
    });
    writeFileSync(
      trustPath,
      JSON.stringify({
        schema: 1,
        catalog_url: "https://example.test/catalog.json",
        minimum_checkpoint: { key_epoch: 1, sequence: 2 },
        keys: [{ key_id: "test-key", key_epoch: 1, public_key_pem: publicKey, minimum_sequence: 1 }]
      })
    );
    const releasePath = join(directory, "fixture.atlas-plugin");
    writeFileSync(releasePath, `${JSON.stringify(releaseDocument(), null, 2)}\n`);
    const result = run(["append", releasePath, ledgerPath], {
      ATLAS_PLUGIN_CATALOG_TRUST_PATH: trustPath,
      ATLAS_PLUGIN_CATALOG_KEY_ID: "test-key",
      ATLAS_PLUGIN_CATALOG_KEY_EPOCH: "1",
      ATLAS_PLUGIN_CATALOG_PRIVATE_KEY: privateKey
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /below the configured trust checkpoint/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
