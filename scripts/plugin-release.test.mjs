import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repositoryRoot, "scripts", "plugin-release.mjs");
const image = `ghcr.io/the-drunken-coder/atlas-building-scan@sha256:${"a".repeat(64)}`;

const candidateManifest = {
  plugin_id: "building_scan",
  display_name: "Building Scan",
  core_to_plugin_protocol_major: 1,
  operations: [
    {
      operation_id: "search_buildings",
      display_name: "Search buildings",
      timeout_ms: 15_000,
      interaction: { kind: "map_area" }
    }
  ]
};

function runCandidate(manifest, routeBody = '{"code":"route_not_found"}', contentType = "application/json", failingPlatform = "") {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-candidate-"));
  const bin = join(directory, "bin");
  const docker = join(bin, "docker");
  const curl = join(bin, "curl");
  const platformLog = join(directory, "platforms.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(platformLog, "");
  writeFileSync(
    docker,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "run") {
  const platform = args[args.indexOf("--platform") + 1];
  appendFileSync(process.env.CANDIDATE_PLATFORM_LOG, platform + "\\n");
  if (platform === process.env.CANDIDATE_FAIL_PLATFORM) {
    process.stderr.write("candidate platform failed: " + platform + "\\n");
    process.exit(1);
  }
  process.stdout.write("abcdef123456\\n");
}
else if (args[0] === "port") process.stdout.write("0.0.0.0:12345\\n");
else if (args[0] === "network" && args[1] === "create") process.stdout.write("network123\\n");
else if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) process.stdout.write("");
else process.exit(1);
`
  );
  writeFileSync(
    curl,
    `#!/usr/bin/env node
const url = process.argv.at(-1);
const contentType = process.env.CANDIDATE_CONTENT_TYPE ?? "application/json";
if (url.endsWith("/manifest")) process.stdout.write(process.env.CANDIDATE_MANIFEST + "\\n" + contentType + "\\n200\\n");
else if (url.endsWith("/health")) process.stdout.write('{"status":"ok"}\\n' + contentType + "\\n200\\n");
else process.stdout.write((process.env.CANDIDATE_ROUTE_BODY ?? '{"code":"route_not_found"}') + "\\n" + contentType + "\\n404\\n");
`
  );
  chmodSync(docker, 0o755);
  chmodSync(curl, 0o755);
  try {
    const result = spawnSync(process.execPath, [script, "check-candidate", "building_scan", image], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CANDIDATE_MANIFEST: JSON.stringify(manifest),
        CANDIDATE_ROUTE_BODY: routeBody,
        CANDIDATE_CONTENT_TYPE: contentType,
        CANDIDATE_FAIL_PLATFORM: failingPlatform,
        CANDIDATE_PLATFORM_LOG: platformLog
      }
    });
    result.platforms = readFileSync(platformLog, "utf8").trim().split("\n").filter(Boolean);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runReleaseDocument(imageReference) {
  return spawnSync(process.execPath, [script, "release-document", "building_scan", "0.1.0", imageReference], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env
  });
}

function makeOversizedReleaseDocument(document) {
  const oversized = structuredClone(document);
  oversized.source_connector.routes[0].allowed_query_names = Array.from({ length: 100_000 }, (_, index) => `query_${index}`);
  return Buffer.from(`${JSON.stringify(oversized, null, 2)}\n`);
}

function runMutatingRetryDocument(idempotencyHeader, allowedRequestHeaders) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-mutating-retry-"));
  try {
    const validResult = runReleaseDocument(image);
    assert.equal(validResult.status, 0, validResult.stderr);
    const document = JSON.parse(validResult.stdout);
    const route = document.source_connector.routes[0];
    route.read_only = false;
    route.allowed_request_headers = allowedRequestHeaders;
    route.retry = { max_retries: 1, statuses: [503], failures: [], idempotency_header: idempotencyHeader };
    const documentPath = join(directory, "mutating-retry.atlas-plugin");
    writeFileSync(documentPath, `${JSON.stringify(document)}\n`);
    return spawnSync(process.execPath, [script, "verify-document", documentPath], { cwd: repositoryRoot, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runPublicRelease(localPath, preloadPath, url, mode) {
  return spawnSync(process.execPath, [script, "verify-public-release", url, localPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "the-Drunken-coder/Atlas-Modernization",
      GITHUB_SERVER_URL: "https://github.com",
      NODE_OPTIONS: `--import=${preloadPath}`,
      ATLAS_TEST_RELEASE_BYTES: localPath,
      ATLAS_TEST_PUBLIC_RELEASE_MODE: mode
    }
  });
}

function runTagVerification(mode) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-release-tag-"));
  const bin = join(directory, "bin");
  const gh = join(bin, "gh");
  const expected = "a".repeat(40);
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const endpoint = process.argv.at(-1);
const expected = process.env.ATLAS_TEST_TAG_EXPECTED;
const mode = process.env.ATLAS_TEST_TAG_MODE;
if (mode === "missing") {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}

if (endpoint.endsWith("/git/ref/tags/atlas-plugin-building_scan-v0.1.0")) {
  if (mode === "annotated") process.stdout.write(JSON.stringify({ object: { type: "tag", sha: "b".repeat(40) } }));
  else process.stdout.write(JSON.stringify({ object: { type: "commit", sha: mode === "wrong" ? "f".repeat(40) : expected } }));
} else if (endpoint.endsWith("/git/tags/" + "b".repeat(40))) {
  process.stdout.write(JSON.stringify({ object: { type: "commit", sha: expected } }));
} else {
  process.stderr.write("unexpected endpoint\\n");
  process.exit(1);
}
`
  );
  chmodSync(gh, 0o755);
  try {
    return spawnSync(process.execPath, [script, "verify-release-tag", "the-Drunken-coder/Atlas-Modernization", "atlas-plugin-building_scan-v0.1.0", expected], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATLAS_TEST_TAG_MODE: mode, ATLAS_TEST_TAG_EXPECTED: expected }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runReusePublication(mode, releaseBytes) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-reuse-publication-"));
  const bin = join(directory, "bin");
  const docker = join(bin, "docker");
  const gh = join(bin, "gh");
  const outputDirectory = join(directory, "release-artifacts");
  const releaseSource = join(directory, "existing.atlas-plugin");
  const ghLog = join(directory, "gh.log");
  const sourceSha = "b".repeat(40);
  mkdirSync(bin, { recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(releaseSource, releaseBytes);
  writeFileSync(ghLog, "");
  writeFileSync(
    docker,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "buildx" && args[1] === "imagetools" && process.env.ATLAS_TEST_REUSE_MODE === "registry-error") {
  process.stderr.write("ERROR: unexpected EOF while contacting the registry\\n");
  process.exit(1);
} else if (args[0] === "buildx" && args[1] === "imagetools" && process.env.ATLAS_TEST_REUSE_MODE === "missing-image") {
  process.stderr.write("ERROR: manifest unknown\\n");
  process.exit(1);
} else if (args[0] === "buildx" && args[1] === "imagetools" && process.env.ATLAS_TEST_REUSE_MODE === "missing-reference") {
  process.stderr.write("ERROR: ghcr.io/the-drunken-coder/atlas-building-scan:0.1.0: not found\\n");
  process.exit(1);
} else if (args[0] === "buildx" && args[1] === "imagetools" && process.env.ATLAS_TEST_REUSE_MODE === "malformed-image") {
  process.stdout.write(JSON.stringify({ digest: "sha256:not-a-valid-digest" }) + "\\n");
} else if (args[0] === "buildx" && args[1] === "imagetools") {
  process.stdout.write(JSON.stringify({ digest: process.env.ATLAS_TEST_DIGEST }) + "\\n");
} else {
  process.stderr.write("unexpected docker invocation\\n");
  process.exit(1);
}
`
  );
  writeFileSync(
    gh,
    `#!/usr/bin/env node
import { appendFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.ATLAS_TEST_GH_LOG, args.join(" ") + "\\n");
if (args[0] === "api" && args.at(-1).includes("/git/ref/tags/")) {
  process.stdout.write(JSON.stringify({ object: { type: "commit", sha: process.env.ATLAS_TEST_SOURCE_SHA } }));
} else if (args[0] === "release" && args[1] === "view") {
  if (process.env.ATLAS_TEST_REUSE_MODE === "missing-release") {
    process.stderr.write("release not found\\n");
    process.exit(1);
  }
  const assets = process.env.ATLAS_TEST_REUSE_MODE === "missing-asset" ? [] : [{ name: "building_scan-0.1.0.atlas-plugin" }];
  process.stdout.write(JSON.stringify({ name: "Atlas Plugin building_scan 0.1.0", targetCommitish: process.env.ATLAS_TEST_SOURCE_SHA, assets }));
} else if (args[0] === "release" && args[1] === "download") {
  const outputDirectory = args[args.indexOf("--dir") + 1];
  copyFileSync(process.env.ATLAS_TEST_RELEASE_SOURCE, join(outputDirectory, "building_scan-0.1.0.atlas-plugin"));
} else {
  process.stderr.write("unexpected gh invocation\\n");
  process.exit(1);
}
`
  );
  chmodSync(docker, 0o755);
  chmodSync(gh, 0o755);
  try {
    const result = spawnSync(
      process.execPath,
      [script, "reuse-publication", "building_scan", "0.1.0", sourceSha, outputDirectory],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: "test-token",
          GITHUB_REPOSITORY: "the-Drunken-coder/Atlas-Modernization",
          ATLAS_TEST_DIGEST: "sha256:" + "a".repeat(64),
          ATLAS_TEST_GH_LOG: ghLog,
          ATLAS_TEST_RELEASE_SOURCE: releaseSource,
          ATLAS_TEST_REUSE_MODE: mode,
          ATLAS_TEST_SOURCE_SHA: sourceSha
        }
      }
    );
    return {
      result,
      bytes: existsSync(join(outputDirectory, "building_scan-0.1.0.atlas-plugin"))
        ? readFileSync(join(outputDirectory, "building_scan-0.1.0.atlas-plugin"))
        : undefined,
      ghCalls: readFileSync(ghLog, "utf8")
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("embeds the strict source connector and generated SDK Protocol revision", () => {
  const result = runReleaseDocument(image);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.source_connector.id, "building_scan");
  assert.deepEqual(document.source_connector.secret_headers, {});
  assert.deepEqual(document.source_connector.egress, {
    allow_private: false,
    allow_loopback: false,
    allow_link_local: false
  });
  assert.match(document.atlas_protocol_revision, /^sha256:[0-9a-f]{64}$/u);
});

test("rejects a source connector origin array before release publication", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-release-document-"));
  try {
    const validResult = runReleaseDocument(image);
    assert.equal(validResult.status, 0, validResult.stderr);
    const valid = JSON.parse(validResult.stdout);
    const documentPath = join(directory, "invalid.atlas-plugin");
    writeFileSync(documentPath, `${JSON.stringify({ ...valid, source_connector: { ...valid.source_connector, origin: [valid.source_connector.origin] } }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [script, "verify-document", documentPath], { cwd: repositoryRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /origin must be a string/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects source connector strings above the client UTF-8 byte limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-release-string-limit-"));
  try {
    const validResult = runReleaseDocument(image);
    assert.equal(validResult.status, 0, validResult.stderr);
    const document = JSON.parse(validResult.stdout);
    document.source_connector.routes[0].path_prefix = "/" + "é".repeat(1024);
    const documentPath = join(directory, "oversized-path.atlas-plugin");
    writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
    const result = spawnSync(process.execPath, [script, "verify-document", documentPath], { cwd: repositoryRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /path_prefix is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an oversized release document before verify-document accepts it", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-release-document-size-"));
  try {
    const validResult = runReleaseDocument(image);
    assert.equal(validResult.status, 0, validResult.stderr);
    const oversizedBytes = makeOversizedReleaseDocument(JSON.parse(validResult.stdout));
    assert.ok(oversizedBytes.byteLength > 1 << 20);
    const documentPath = join(directory, "oversized.atlas-plugin");
    writeFileSync(documentPath, oversizedBytes);
    const result = spawnSync(process.execPath, [script, "verify-document", documentPath], { cwd: repositoryRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release document exceeds the 1048576-byte limit/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an oversized generated release before touching an existing output", () => {
  const pluginId = "oversized_release";
  const pluginDirectory = join(repositoryRoot, "plugins", pluginId);
  const outputDirectory = mkdtempSync(join(tmpdir(), "atlas-plugin-release-output-"));
  const outputPath = join(outputDirectory, "release.atlas-plugin");
  const sentinel = Buffer.from("existing release bytes\n");
  const generatedImage = `ghcr.io/the-drunken-coder/atlas-oversized-release@sha256:${"b".repeat(64)}`;
  try {
    cpSync(join(repositoryRoot, "plugins", "building_scan"), pluginDirectory, { recursive: true });
    const manifestPath = join(pluginDirectory, "atlas-plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.plugin_id = pluginId;
    manifest.package = "@the-drunken-coder/atlas-oversized-release-plugin";
    manifest.release.image_repository = "ghcr.io/the-drunken-coder/atlas-oversized-release";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const packagePath = join(pluginDirectory, "package.json");
    const packageJSON = JSON.parse(readFileSync(packagePath, "utf8"));
    packageJSON.name = manifest.package;
    writeFileSync(packagePath, `${JSON.stringify(packageJSON, null, 2)}\n`);
    const endpointPath = join(pluginDirectory, manifest.core_endpoint);
    const endpoint = JSON.parse(readFileSync(endpointPath, "utf8"));
    endpoint.id = pluginId;
    writeFileSync(endpointPath, `${JSON.stringify(endpoint, null, 2)}\n`);
    const connectorPath = join(pluginDirectory, manifest.source_connector);
    const connector = JSON.parse(readFileSync(connectorPath, "utf8"));
    connector.id = pluginId;
    connector.routes[0].allowed_query_names = Array.from({ length: 100_000 }, (_, index) => `query_${index}`);
    writeFileSync(connectorPath, `${JSON.stringify(connector, null, 2)}\n`);
    writeFileSync(outputPath, sentinel);

    const result = spawnSync(
      process.execPath,
      [script, "release-document", pluginId, "0.1.0", generatedImage, outputPath],
      { cwd: repositoryRoot, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release document exceeds the 1048576-byte limit/);
    assert.deepEqual(readFileSync(outputPath), sentinel);
  } finally {
    rmSync(pluginDirectory, { recursive: true, force: true });
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("rejects a mutating retry whose idempotency header is not allowed", () => {
  const result = runMutatingRetryDocument("idempotency-key", []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must appear in allowed_request_headers/);
});

test("accepts a mutating retry with a case-normalized allowed idempotency header", () => {
  const result = runMutatingRetryDocument("Idempotency-Key", ["IDEMPOTENCY-KEY"]);
  assert.equal(result.status, 0, result.stderr);
});

test("accepts a candidate only when its private manifest matches the authored interaction contract", () => {
  const result = runCandidate(candidateManifest);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.platforms, ["linux/amd64", "linux/arm64"]);
});

test("fails candidate acceptance when either published platform fails its contract probe", () => {
  const result = runCandidate(candidateManifest, undefined, undefined, "linux/arm64");
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.platforms, ["linux/amd64", "linux/arm64"]);
  assert.match(result.stderr, /linux\/arm64.*candidate platform failed|candidate platform failed.*linux\/arm64/);
});

test("requires candidate JSON probes to advertise an application/json media type", () => {
  const result = runCandidate(candidateManifest, undefined, "text/plain");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate manifest returned text\/plain; expected application\/json/);
});

test("accepts candidate JSON media types with valid parameters", () => {
  const result = runCandidate(candidateManifest, undefined, "Application/JSON; Charset=UTF-8");
  assert.equal(result.status, 0, result.stderr);
});

test("rejects malformed application/json media parameters", () => {
  const result = runCandidate(candidateManifest, undefined, "application/json; malformed");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected application\/json/);
});

test("rejects candidate manifest fields that can change the managed query-only contract", () => {
  const result = runCandidate({
    plugin_id: "building_scan",
    display_name: "Building Scan",
    core_to_plugin_protocol_major: 1,
    tool_asset_id: "plugin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    operations: [
      {
        operation_id: "search_buildings",
        display_name: "Search buildings",
        timeout_ms: 15_000,
        interaction: { kind: "map_area" }
      }
    ]
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not expose tool_asset_id/);
});

test("rejects candidate manifests above the runtime operation limit", () => {
  const operations = Array.from({ length: 129 }, (_, index) => ({
    operation_id: `operation_${String(index).padStart(3, "0")}`,
    display_name: `Operation ${index}`,
    timeout_ms: 15_000,
    ...(index === 0 ? { interaction: { kind: "map_area" } } : {})
  }));
  const result = runCandidate({
    plugin_id: "building_scan",
    display_name: "Building Scan",
    core_to_plugin_protocol_major: 1,
    operations
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /too many operations/);
});

test("requires the missing candidate route to return the exact JSON error", () => {
  const result = runCandidate({
    plugin_id: "building_scan",
    display_name: "Building Scan",
    core_to_plugin_protocol_major: 1,
    operations: [
      {
        operation_id: "search_buildings",
        display_name: "Search buildings",
        timeout_ms: 15_000,
        interaction: { kind: "map_area" }
      }
    ]
  }, '{"code":"wrong_route"}');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /route_not_found/);
});

test("verifies the anonymous release URL and bounded redirect", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-public-release-"));
  try {
    const releasePath = join(directory, "building_scan.atlas-plugin");
    const documentResult = runReleaseDocument(image);
    assert.equal(documentResult.status, 0, documentResult.stderr);
    writeFileSync(releasePath, documentResult.stdout);
    const preloadPath = join(directory, "fetch.mjs");
    writeFileSync(preloadPath, `
import { readFileSync } from "node:fs";
const bytes = readFileSync(process.env.ATLAS_TEST_RELEASE_BYTES);
let calls = 0;
globalThis.fetch = async (_url) => {
  calls += 1;
  if (process.env.ATLAS_TEST_PUBLIC_RELEASE_MODE === "oversized") return new Response(Buffer.alloc((1 << 20) + 1), { status: 200 });
  if (process.env.ATLAS_TEST_PUBLIC_RELEASE_MODE === "evil") return new Response(null, { status: 302, headers: { location: "https://evil.example/release" } });
  if (calls === 1) return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/release?X-Amz-Signature=test" } });
  return new Response(bytes, { status: 200 });
};
`);
    const url = "https://github.com/the-Drunken-coder/Atlas-Modernization/releases/download/atlas-plugin-building_scan-v0.1.0/building_scan-0.1.0.atlas-plugin";
    const result = runPublicRelease(releasePath, preloadPath, url);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounds anonymous release downloads and rejects untrusted redirects", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-public-release-bounds-"));
  try {
    const releasePath = join(directory, "building_scan.atlas-plugin");
    const documentResult = runReleaseDocument(image);
    assert.equal(documentResult.status, 0, documentResult.stderr);
    writeFileSync(releasePath, documentResult.stdout);
    const preloadPath = join(directory, "fetch.mjs");
    writeFileSync(preloadPath, `
import { readFileSync } from "node:fs";
const bytes = readFileSync(process.env.ATLAS_TEST_RELEASE_BYTES);
globalThis.fetch = async () => {
  if (process.env.ATLAS_TEST_PUBLIC_RELEASE_MODE === "oversized") return new Response(Buffer.alloc((1 << 20) + 1), { status: 200 });
  return new Response(null, { status: 302, headers: { location: "https://evil.example/release" } });
};
void bytes;
`);
    const url = "https://github.com/the-Drunken-coder/Atlas-Modernization/releases/download/atlas-plugin-building_scan-v0.1.0/building_scan-0.1.0.atlas-plugin";
    const oversized = runPublicRelease(releasePath, preloadPath, url, "oversized");
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /size limit/);
    const evil = runPublicRelease(releasePath, preloadPath, url, "evil");
    assert.notEqual(evil.status, 0);
    assert.match(evil.stderr, /allowlisted/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts a lightweight release tag that resolves to the reviewed commit", () => {
  const result = runTagVerification("lightweight");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /resolves to/);
});

test("peels an annotated release tag before accepting its commit", () => {
  const result = runTagVerification("annotated");
  assert.equal(result.status, 0, result.stderr);
});

test("rejects a release tag that resolves to a different commit", () => {
  const result = runTagVerification("wrong");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /resolves to/);
});

test("reports a missing release tag without treating it as valid", () => {
  const result = runTagVerification("missing");
  assert.equal(result.status, 2, result.stderr);
});

test("treats only a confirmed missing image manifest as an absent publication", () => {
  const missing = runReusePublication("missing-image", Buffer.from("unused"));
  assert.equal(missing.result.status, 2, missing.result.stderr);
  const missingReference = runReusePublication("missing-reference", Buffer.from("unused"));
  assert.equal(missingReference.result.status, 2, missingReference.result.stderr);

  const registryError = runReusePublication("registry-error", Buffer.from("unused"));
  assert.notEqual(registryError.result.status, 0);
  assert.notEqual(registryError.result.status, 2);
  assert.match(registryError.result.stderr, /imagetools inspect .* failed/);

  const malformed = runReusePublication("malformed-image", Buffer.from("unused"));
  assert.notEqual(malformed.result.status, 0);
  assert.match(malformed.result.stderr, /did not resolve to an immutable manifest digest/);
});

test("reuses the authenticated release asset only after verifying its source tag and exact metadata", () => {
  const documentResult = runReleaseDocument(image);
  assert.equal(documentResult.status, 0, documentResult.stderr);
  const reuse = runReusePublication("asset", documentResult.stdout);
  assert.equal(reuse.result.status, 0, reuse.result.stderr);
  assert.deepEqual(reuse.bytes, Buffer.from(documentResult.stdout));
  assert.match(reuse.ghCalls, /api repos\/the-Drunken-coder\/Atlas-Modernization\/git\/ref\/tags\/atlas-plugin-building_scan-v0\.1\.0/);
  assert.match(reuse.ghCalls, /release download atlas-plugin-building_scan-v0\.1\.0/);
  assert.match(reuse.result.stdout, /"image_reference":"ghcr\.io\/the-drunken-coder\/atlas-building-scan@sha256:/);
});

test("regenerates a release document for an already promoted image when publication stopped before release creation", () => {
  const documentResult = runReleaseDocument(image);
  assert.equal(documentResult.status, 0, documentResult.stderr);
  const reuse = runReusePublication("missing-release", Buffer.from("unused"));
  assert.equal(reuse.result.status, 0, reuse.result.stderr);
  assert.deepEqual(JSON.parse(reuse.bytes), JSON.parse(documentResult.stdout));
  assert.match(reuse.ghCalls, /release view atlas-plugin-building_scan-v0\.1\.0/);
  assert.doesNotMatch(reuse.ghCalls, /release download/);
});

test("rejects a reused release asset whose metadata differs from the reviewed plugin", () => {
  const documentResult = runReleaseDocument(image);
  assert.equal(documentResult.status, 0, documentResult.stderr);
  const altered = JSON.parse(documentResult.stdout);
  altered.display_name = "Tampered";
  const reuse = runReusePublication("asset", `${JSON.stringify(altered)}\n`);
  assert.notEqual(reuse.result.status, 0);
  assert.match(reuse.result.stderr, /does not match the reviewed plugin metadata/);
});

test("rejects a reused release asset with duplicate JSON keys", () => {
  const documentResult = runReleaseDocument(image);
  assert.equal(documentResult.status, 0, documentResult.stderr);
  const duplicateKeyDocument = documentResult.stdout.replace(
    '  "display_name": "Building Scan",\n',
    '  "display_name": "Building Scan",\n  "display_name": "Building Scan",\n'
  );
  const reuse = runReusePublication("asset", duplicateKeyDocument);
  assert.notEqual(reuse.result.status, 0);
  assert.match(reuse.result.stderr, /does not match the reviewed plugin metadata/);
});

test("checks release tag provenance before promoting the version image", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "release-atlas-plugin.yml"), "utf8");
  const guard = workflow.indexOf("- name: Verify release tag provenance");
  const promotion = workflow.indexOf("- name: Promote immutable image to the version tag");
  assert.ok(guard >= 0 && guard < promotion);
  assert.match(workflow.slice(guard, promotion), /verify-release-tag/);
  assert.match(workflow, /gh release create "\$tag" --verify-tag --target "\$SOURCE_SHA"/);
});

test("fails closed when checking an existing version image before promotion", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "release-atlas-plugin.yml"), "utf8");
  const promotion = workflow.indexOf("- name: Promote immutable image to the version tag");
  const release = workflow.indexOf("- name: Create or verify immutable GitHub release");
  assert.ok(promotion >= 0 && promotion < release);
  const block = workflow.slice(promotion, release);
  assert.match(block, /node scripts\/plugin-release\.mjs image-digest "\$final_image"/);
  assert.match(block, /existing_status.*-eq 2/);
  assert.match(block, /exit "\$existing_status"/);
  assert.match(block, /final_status.*-ne 0/);
  assert.match(block, /node scripts\/plugin-release\.mjs image-digest "\$final_image"/g);
});

test("reuses a promoted image and release document before rebuilding on a publication retry", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "release-atlas-plugin.yml"), "utf8");
  const reuse = workflow.indexOf("- name: Reuse a previously promoted immutable image when available");
  const build = workflow.indexOf("- name: Publish candidate image");
  const select = workflow.indexOf("- name: Select immutable candidate image");
  const document = workflow.indexOf("- name: Generate and verify immutable release document");
  assert.ok(reuse >= 0 && reuse < build);
  assert.ok(build < select && select < document);
  assert.match(workflow.slice(reuse, build), /node scripts\/plugin-release\.mjs reuse-publication/);
  assert.match(workflow.slice(reuse, build), /\"\$SOURCE_SHA\" release-artifacts/);
  assert.match(workflow.slice(build, select), /if: steps\.reuse\.outputs\.found != 'true'/);
  assert.match(workflow.slice(select, document), /REUSED_REFERENCE/);
  assert.match(workflow.slice(document), /if \[ \"\$\{\{ steps\.reuse\.outputs\.found \}\}\" != \"true\" \]/);
  assert.match(workflow.slice(document), /sha256sum .*release-artifacts\/SHA256SUMS/);
});

test("sets up QEMU before probing every published candidate platform", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "release-atlas-plugin.yml"), "utf8");
  const qemu = workflow.indexOf("- name: Set up QEMU");
  const probe = workflow.indexOf("- name: Run candidate image contract checks");
  assert.ok(qemu >= 0 && qemu < probe);
  const script = readFileSync(join(repositoryRoot, "scripts", "plugin-release.mjs"), "utf8");
  assert.match(script, /const candidatePlatforms = \["linux\/amd64", "linux\/arm64"\]/);
  assert.match(script, /\["run", "--platform", platform/);
});

test("builds workspace runtime dependencies before running plugin tests", () => {
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "release-atlas-plugin.yml"), "utf8");
  const install = workflow.indexOf("npm ci --ignore-scripts");
  const sdk = workflow.indexOf("npm run build:sdk");
  const runtime = workflow.indexOf("npm run build:plugin-runtime");
  const pluginTests = workflow.indexOf('npm test --workspace "$PACKAGE_NAME"');
  assert.ok(install >= 0 && install < sdk);
  assert.ok(sdk >= 0 && sdk < runtime);
  assert.ok(runtime >= 0 && runtime < pluginTests);
});
