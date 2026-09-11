#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAuthoredManifest } from "./plugin-manifest-validation.mjs";
import { validateReleaseDocument, validateSourceConnector } from "./plugin-release-validation.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsRoot = join(repositoryRoot, "plugins");
const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const imagePattern = /^ghcr\.io\/the-drunken-coder\/[a-z0-9][a-z0-9-]*@sha256:[0-9a-f]{64}$/u;
const releaseDocumentLimit = 1 << 20;
const releaseRedirectLimit = 5;
const maxCandidateOperations = 128;
const candidatePlatforms = ["linux/amd64", "linux/arm64"];
const candidateHealthcheck = ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"];
const releaseHosts = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com"
]);
const privateManifestKeys = ["plugin_id", "display_name", "core_to_plugin_protocol_major", "operations", "tool_asset_id"];

const [command, ...rawArgs] = process.argv.slice(2);

switch (command) {
  case "validate-version":
    validateVersion(required(rawArgs[0], "version"));
    break;
  case "validate-plugin": {
    const plugin = readPlugin(required(rawArgs[0], "plugin_id"));
    validatePlugin(plugin);
    const version = rawArgs[1] ?? readPackageVersion(plugin);
    validateReleaseVersion(plugin, version);
    process.stdout.write(`${JSON.stringify({ plugin_id: plugin.id, version })}\n`);
    break;
  }
  case "protocol-revision": {
    const plugin = readPlugin(required(rawArgs[0], "plugin_id"));
    validatePlugin(plugin);
    process.stdout.write(`${plugin.manifest.uses_core_sdk ? readBuiltProtocolRevision(plugin) : "null"}\n`);
    break;
  }
  case "release-document": {
    const plugin = readPlugin(required(rawArgs[0], "plugin_id"));
    validatePlugin(plugin);
    const version = required(rawArgs[1], "version");
    const image = required(rawArgs[2], "image reference");
    validateReleaseVersion(plugin, version);
    const document = createReleaseDocument(plugin, version, image);
    const bytes = serializeReleaseDocument(document);
    const output = rawArgs[3] ? resolve(repositoryRoot, rawArgs[3]) : undefined;
    if (output) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes);
    } else {
      process.stdout.write(bytes);
    }
    break;
  }
  case "verify-document": {
    const { document } = readReleaseDocument(resolve(repositoryRoot, required(rawArgs[0], "document path")));
    validateReleaseDocument(document);
    break;
  }
  case "verify-public-release":
    await verifyPublicRelease(required(rawArgs[0], "release URL"), resolve(repositoryRoot, required(rawArgs[1], "local document path")));
    break;
  case "verify-release-tag": {
    const present = verifyRemoteReleaseTag(
      required(rawArgs[0], "repository"),
      required(rawArgs[1], "tag"),
      required(rawArgs[2], "release commit")
    );
    if (!present) process.exitCode = 2;
    break;
  }
  case "check-candidate": {
    const plugin = readPlugin(required(rawArgs[0], "plugin_id"));
    validatePlugin(plugin);
    checkCandidate(plugin, required(rawArgs[1], "image reference"));
    break;
  }
  case "image-digest": {
    const digest = readImmutableImageDigest(required(rawArgs[0], "image reference"));
    if (digest === null) {
      process.exitCode = 2;
    } else {
      process.stdout.write(`${digest}\n`);
    }
    break;
  }
  case "reuse-publication": {
    const publication = reuseExistingPublication(
      required(rawArgs[0], "plugin_id"),
      required(rawArgs[1], "version"),
      required(rawArgs[2], "source commit"),
      resolve(repositoryRoot, rawArgs[3] ?? "release-artifacts")
    );
    if (publication === null) {
      process.exitCode = 2;
    } else {
      process.stdout.write(`${JSON.stringify(publication)}\n`);
    }
    break;
  }
  default:
    throw new Error(
      "Usage: node scripts/plugin-release.mjs <validate-version|validate-plugin|protocol-revision|release-document|verify-document|verify-public-release|verify-release-tag|check-candidate|image-digest|reuse-publication> ..."
    );
}

function readPlugin(pluginId) {
  if (!identifierPattern.test(pluginId)) throw new Error(`Invalid plugin_id: ${pluginId}`);
  const directory = join(pluginsRoot, pluginId);
  const manifestPath = join(directory, "atlas-plugin.json");
  if (!existsSync(manifestPath)) throw new Error(`Plugin ${pluginId} has no atlas-plugin.json`);
  const manifest = readJSON(manifestPath);
  validateAuthoredManifest(manifest, manifestPath);
  if (manifest.plugin_id !== pluginId) throw new Error(`${manifestPath} plugin_id does not match its folder`);
  return { directory, id: pluginId, manifest, manifestPath };
}

function validatePlugin(plugin) {
  const { manifest } = plugin;
  if (manifest.release.channel !== "independent") {
    throw new Error(`${plugin.manifestPath} must declare an independent first-party release repository`);
  }
  const packageJSON = readJSON(join(plugin.directory, "package.json"));
  if (!isRecord(packageJSON) || packageJSON.name !== manifest.package) {
    throw new Error(`${plugin.id} package.json name does not match atlas-plugin.json`);
  }
  validateVersion(packageJSON.version);
  for (const requiredPath of ["package.json", "Dockerfile", "src", "test", manifest.compose, manifest.core_endpoint]) {
    if (!existsSync(join(plugin.directory, requiredPath))) throw new Error(`${plugin.id} is missing ${requiredPath}`);
  }
  if (manifest.source_connector !== null && !existsSync(join(plugin.directory, manifest.source_connector))) {
    throw new Error(`${plugin.id} is missing ${manifest.source_connector}`);
  }
  const endpoint = readJSON(join(plugin.directory, manifest.core_endpoint));
  if (!isRecord(endpoint) || endpoint.id !== plugin.id || typeof endpoint.base_url !== "string") {
    throw new Error(`${plugin.id} Core endpoint fragment has the wrong identity`);
  }
  if (manifest.source_connector !== null) validateSourceConnector(readJSON(join(plugin.directory, manifest.source_connector)), plugin.id);
  return plugin;
}

function createReleaseDocument(plugin, version, image) {
  if (!imagePattern.test(image)) throw new Error(`Image must be an immutable first-party GHCR digest reference: ${image}`);
  const repository = imageRepository(plugin);
  if (!image.startsWith(`${repository}@`)) throw new Error(`${plugin.id} image uses the wrong repository`);
  const connector = plugin.manifest.source_connector === null
    ? null
    : readJSON(join(plugin.directory, plugin.manifest.source_connector));
  return {
    schema: 1,
    plugin_id: plugin.id,
    version,
    display_name: plugin.manifest.display_name,
    lifecycle: "query_only",
    image,
    core_to_plugin_protocol_major: 1,
    plugin_to_source_gateway_protocol_major: 1,
    atlas_protocol_revision: plugin.manifest.uses_core_sdk ? readBuiltProtocolRevision(plugin) : null,
    interactions: [...plugin.manifest.interactions],
    source_connector: connector
  };
}

function checkCandidate(plugin, image) {
  if (!imagePattern.test(image)) throw new Error(`Candidate image is not an immutable first-party digest reference: ${image}`);
  const expectedRepository = imageRepository(plugin);
  if (!image.startsWith(`${expectedRepository}@`)) throw new Error(`${plugin.id} candidate image uses the wrong repository`);
  const networkName = `atlas-plugin-release-${process.pid}-${Date.now()}`;
  runCapture("docker", ["network", "create", networkName]);
  try {
    for (const platform of candidatePlatforms) {
      let containerId;
      try {
        const container = runCapture("docker", ["run", "--platform", platform, "--detach", "--rm", "--network", networkName, "--publish", "127.0.0.1::8080", image]);
        containerId = container.trim();
        if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new Error(`Docker returned an invalid ${platform} candidate container ID: ${containerId}`);
        const port = waitForCandidatePort(containerId);
        const manifest = waitForJSON(`http://127.0.0.1:${port}/manifest`, 200, `${platform} candidate manifest`);
        validateCandidateManifest(plugin, manifest);
        const health = waitForJSON(`http://127.0.0.1:${port}/health`, 200, `${platform} candidate health`);
        if (!isRecord(health) || Object.keys(health).length !== 1 || health.status !== "ok") {
          throw new Error(`${platform} candidate /health did not return {\"status\":\"ok\"}`);
        }
        runCapture("docker", ["exec", containerId, ...candidateHealthcheck]);
        const routeResponse = runCapture("curl", ["--silent", "--show-error", "--max-time", "2", "--write-out", "\n%{content_type}\n%{http_code}", `http://127.0.0.1:${port}/__atlas_candidate_missing__`], true).trimEnd();
        const routeLines = routeResponse.split("\n");
        const routeStatus = routeLines.pop();
        const routeContentType = routeLines.pop() ?? "";
        if (
          routeStatus !== "404" ||
          !isJSONContentType(routeContentType) ||
          routeLines.join("\n") !== '{"code":"route_not_found"}'
        ) {
          throw new Error(`${platform} candidate missing route must return {"code":"route_not_found"} as application/json with HTTP 404; got ${routeContentType || "no Content-Type"} HTTP ${routeStatus}`);
        }
      } finally {
        if (containerId) spawnSync("docker", ["rm", "--force", containerId], { cwd: repositoryRoot, stdio: "ignore" });
      }
    }
  } finally {
    spawnSync("docker", ["network", "rm", networkName], { cwd: repositoryRoot, stdio: "ignore" });
  }
  process.stdout.write(`Candidate ${image} passed the ${plugin.id} runtime contract checks on ${candidatePlatforms.join(", ")}.\n`);
}

async function verifyPublicRelease(url, localPath) {
  const { bytes: localBytes, document: localDocument } = readReleaseDocument(localPath);
  const document = validateReleaseDocument(localDocument);
  const expectedURL = releaseDocumentURL(document.plugin_id, document.version);
  if (url !== expectedURL) throw new Error(`Release URL must exactly equal ${expectedURL}`);
  const remoteBytes = await fetchPublicRelease(url);
  if (!remoteBytes.equals(localBytes)) throw new Error("Public release document bytes do not match the reviewed release document");
  process.stdout.write(`Verified anonymous public release document at ${url}.\n`);
}

function verifyRemoteReleaseTag(repository, tag, expectedSha, quiet = false) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error(`GitHub repository is invalid: ${repository}`);
  if (!/^atlas-plugin-[a-z][a-z0-9]*(?:_[a-z0-9]+)*-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag)) {
    throw new Error(`Plugin release tag is invalid: ${tag}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(expectedSha)) throw new Error(`Release commit is invalid: ${expectedSha}`);
  const actualSha = readRemoteReleaseTag(repository, tag);
  if (actualSha === null) return false;
  if (actualSha !== expectedSha) {
    throw new Error(`Plugin release tag ${tag} resolves to ${actualSha}, not ${expectedSha}`);
  }
  if (!quiet) process.stdout.write(`Plugin release tag ${tag} resolves to ${expectedSha}.\n`);
  return true;
}

function reuseExistingPublication(pluginId, version, sourceSha, releaseDirectory) {
  const plugin = readPlugin(pluginId);
  validatePlugin(plugin);
  validateReleaseVersion(plugin, version);
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error(`Release commit is invalid: ${sourceSha}`);

  const repository = imageRepository(plugin);
  const finalImage = `${repository}:${version}`;
  const digest = readImmutableImageDigest(finalImage);
  if (digest === null) return null;

  const imageReference = `${repository}@${digest}`;
  const releaseTag = `atlas-plugin-${pluginId}-v${version}`;
  const githubRepository = required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  if (!verifyRemoteReleaseTag(githubRepository, releaseTag, sourceSha, true)) {
    throw new Error(`Cannot reuse ${finalImage} without a release tag resolving to ${sourceSha}`);
  }

  mkdirSync(releaseDirectory, { recursive: true });
  const asset = `${pluginId}-${version}.atlas-plugin`;
  const assetPath = join(releaseDirectory, asset);
  const release = readGitHubRelease(githubRepository, releaseTag);
  let reusedAsset = false;
  if (release !== null) {
    const expectedTitle = `Atlas Plugin ${pluginId} ${version}`;
    if (release.name !== expectedTitle || release.targetCommitish !== sourceSha) {
      throw new Error(`GitHub Release ${releaseTag} does not identify the reviewed source commit`);
    }
    if (release.assets.some((candidate) => candidate.name === asset)) {
      runCapture("gh", ["release", "download", releaseTag, "--repo", githubRepository, "--pattern", asset, "--dir", releaseDirectory]);
      const { bytes: downloadedBytes, document: downloaded } = readReleaseDocument(assetPath);
      validateReleaseDocument(downloaded);
      assertReleaseDocumentMatches(plugin, version, imageReference, downloadedBytes);
      reusedAsset = true;
    }
  }
  if (!reusedAsset) {
    writeFileSync(assetPath, serializeReleaseDocument(createReleaseDocument(plugin, version, imageReference)));
  }
  return { image_reference: imageReference, release_document: relative(repositoryRoot, assetPath) };
}

function readImmutableImageDigest(image) {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    if (isConfirmedMissingImageError(image, detail)) return null;
    throw new Error(`docker buildx imagetools inspect ${image} failed: ${detail || "unknown error"}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`docker buildx imagetools inspect ${image} returned invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!isRecord(manifest) || typeof manifest.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(manifest.digest)) {
    throw new Error(`Existing image ${image} did not resolve to an immutable manifest digest`);
  }
  return manifest.digest;
}

function isConfirmedMissingImageError(image, detail) {
  const normalized = detail.trim();
  const requestedReferenceNotFound = new RegExp(`^error:\\s*${escapeRegExp(image)}:\\s*not found$`, "iu").test(normalized);
  return requestedReferenceNotFound || /^(?:error:\s*)?(?:manifest unknown|no such manifest)(?::.*)?$/iu.test(normalized);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readGitHubRelease(repository, tag) {
  const result = spawnSync("gh", ["release", "view", tag, "--repo", repository, "--json", "name,targetCommitish,assets"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    if (/not found|release not found|HTTP 404/iu.test(detail)) return null;
    throw new Error(`gh release view ${tag} failed: ${detail || "unknown error"}`);
  }
  let release;
  try {
    release = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh release view ${tag} returned invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (
    !isRecord(release) ||
    typeof release.name !== "string" ||
    typeof release.targetCommitish !== "string" ||
    !Array.isArray(release.assets) ||
    release.assets.some((asset) => !isRecord(asset) || typeof asset.name !== "string")
  ) {
    throw new Error(`gh release view ${tag} returned an invalid release`);
  }
  return release;
}

function assertReleaseDocumentMatches(plugin, version, image, actualBytes) {
  const expectedBytes = serializeReleaseDocument(createReleaseDocument(plugin, version, image));
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error("Existing GitHub Release document does not match the reviewed plugin metadata and image digest");
  }
}

function serializeReleaseDocument(document) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  assertReleaseDocumentSize(bytes);
  return bytes;
}

function readReleaseDocument(path) {
  const bytes = readFileSync(path);
  assertReleaseDocumentSize(bytes);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${relative(repositoryRoot, path)} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  return { bytes, document };
}

function assertReleaseDocumentSize(bytes) {
  if (bytes.byteLength > releaseDocumentLimit) throw new Error(`Release document exceeds the ${releaseDocumentLimit}-byte limit`);
}

function readRemoteReleaseTag(repository, tag) {
  let object = readGitHubAPI(`repos/${repository}/git/ref/tags/${tag}`);
  if (object === null) return null;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!isRecord(object) || !isRecord(object.object) || typeof object.object.type !== "string" || typeof object.object.sha !== "string") {
      throw new Error(`GitHub returned an invalid object for Plugin release tag ${tag}`);
    }
    if (object.object.type === "commit") {
      if (!/^[0-9a-f]{40}$/u.test(object.object.sha)) throw new Error(`GitHub returned an invalid commit for Plugin release tag ${tag}`);
      return object.object.sha;
    }
    if (object.object.type !== "tag" || !/^[0-9a-f]{40}$/u.test(object.object.sha)) {
      throw new Error(`Plugin release tag ${tag} does not resolve to a commit or annotated tag`);
    }
    object = readGitHubAPI(`repos/${repository}/git/tags/${object.object.sha}`);
    if (object === null) throw new Error(`GitHub could not resolve annotated Plugin release tag ${tag}`);
  }
  throw new Error(`Plugin release tag ${tag} contains too many annotated tag layers`);
}

function readGitHubAPI(path) {
  const result = spawnSync("gh", ["api", path], { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    if (/\b404\b|not found/iu.test(detail)) return null;
    throw new Error(`gh api ${path} failed: ${detail || "unknown error"}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh api ${path} returned invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

async function fetchPublicRelease(url) {
  let expectedHost;
  try {
    expectedHost = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("Public release URL is invalid");
  }
  if (!releaseHosts.has(expectedHost)) throw new Error("Public release URL is not an allowlisted GitHub URL");
  const allowedHosts = releaseHosts;
  let current = checkedReleaseURL(url, allowedHosts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    for (let redirect = 0; redirect <= releaseRedirectLimit; redirect += 1) {
      const response = await fetch(current, { method: "GET", redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        if (redirect === releaseRedirectLimit) {
          throw new Error("Public release download exceeded redirect limit");
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Public release download redirect has no Location header");
        }
        current = checkedReleaseURL(new URL(location, current).toString(), allowedHosts, true);
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`Public release download returned HTTP ${response.status}`);
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > releaseDocumentLimit) {
        await cancelResponseBody(response);
        throw new Error("Public release download exceeds the 1 MiB size limit");
      }
      if (!response.body) throw new Error("Public release download returned an empty body");
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > releaseDocumentLimit) {
            await reader.cancel();
            throw new Error("Public release download exceeds the 1 MiB size limit");
          }
          chunks.push(Buffer.from(next.value));
        }
        return Buffer.concat(chunks);
      } finally {
        reader.releaseLock();
      }
    }
    throw new Error("Public release download failed");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Public release download timed out after 30 seconds");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function cancelResponseBody(response) {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The response is already being discarded; cancellation failures do not change validation.
  }
}

function checkedReleaseURL(value, allowedHosts, allowQuery = false) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Public release URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (!allowQuery && parsed.search) ||
    parsed.hash ||
    !allowedHosts.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error("Public release URL is not an allowlisted HTTPS URL");
  }
  return parsed.toString();
}

function releaseDocumentURL(pluginId, version) {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY ?? "the-Drunken-coder/Atlas-Modernization";
  return `${server}/${repository}/releases/download/atlas-plugin-${pluginId}-v${version}/${pluginId}-${version}.atlas-plugin`;
}

function validateCandidateManifest(plugin, value) {
  if (!isRecord(value)) throw new Error("Candidate /manifest did not return an object");
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !privateManifestKeys.includes(key))) throw new Error("Candidate manifest contains an unknown field");
  if (value.plugin_id !== plugin.id || value.display_name !== plugin.manifest.display_name) {
    throw new Error("Candidate manifest identity does not match atlas-plugin.json");
  }
  if (value.core_to_plugin_protocol_major !== 1) throw new Error("Candidate manifest requires unsupported Core-to-Plugin major");
  if (!Array.isArray(value.operations)) throw new Error("Candidate manifest operations must be an array");
  if (value.operations.length > maxCandidateOperations) throw new Error(`Candidate manifest contains too many operations; maximum is ${maxCandidateOperations}`);
  const interactions = [];
  let previousOperation = "";
  const operationIds = new Set();
  for (const operation of value.operations) {
    if (
      !isRecord(operation) ||
      typeof operation.operation_id !== "string" ||
      !identifierPattern.test(operation.operation_id) ||
      operation.operation_id.length > 64 ||
      typeof operation.display_name !== "string" ||
      operation.display_name.trim() !== operation.display_name ||
      !operation.display_name ||
      operation.display_name.length > 100 ||
      !positiveSafeInteger(operation.timeout_ms) ||
      operation.timeout_ms > 25_000
    ) {
      throw new Error("Candidate manifest contains an invalid Operation descriptor");
    }
    if (operation.operation_id <= previousOperation || operationIds.has(operation.operation_id)) throw new Error("Candidate Operations are not sorted and unique");
    previousOperation = operation.operation_id;
    operationIds.add(operation.operation_id);
    const operationKeys = Object.keys(operation).sort();
    if (operation.interaction !== undefined) {
      if (!isRecord(operation.interaction) || Object.keys(operation.interaction).length !== 1 || operation.interaction.kind !== "map_area") {
        throw new Error("Candidate Operation has an invalid interaction descriptor");
      }
      interactions.push("map_area");
    }
    const permitted = operation.interaction === undefined
      ? ["display_name", "operation_id", "timeout_ms"]
      : ["display_name", "interaction", "operation_id", "timeout_ms"];
    if (operationKeys.some((key) => !permitted.includes(key))) throw new Error("Candidate Operation contains an unknown field");
  }
  const sortedInteractions = [...new Set(interactions)].sort();
  if (JSON.stringify(sortedInteractions) !== JSON.stringify(plugin.manifest.interactions)) {
    throw new Error(`Candidate interactions ${JSON.stringify(sortedInteractions)} do not match authored interactions ${JSON.stringify(plugin.manifest.interactions)}`);
  }
  if ("tool_asset_id" in value) throw new Error("Managed query-only Plugin candidates must not expose tool_asset_id");
  if (!keys.includes("operations") || !keys.includes("core_to_plugin_protocol_major")) throw new Error("Candidate manifest is missing required private fields");
}

function waitForCandidatePort(containerId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("docker", ["port", containerId, "8080/tcp"], { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
    if (result.status === 0) {
      const match = /:(\d+)\s*$/mu.exec(result.stdout.trim());
      if (match) return match[1];
    }
    sleep(500);
  }
  throw new Error("Timed out waiting for Docker to publish the candidate port");
}

function waitForJSON(url, expectedStatus, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("curl", ["--silent", "--show-error", "--max-time", "2", "--write-out", "\n%{content_type}\n%{http_code}", url], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "pipe"
    });
    if (result.status === 0) {
      const lines = result.stdout.trimEnd().split("\n");
      const status = Number(lines.pop());
      if (status === expectedStatus) {
        const contentType = lines.pop() ?? "";
        if (!isJSONContentType(contentType)) {
          throw new Error(`${label} returned ${contentType || "no Content-Type"}; expected application/json`);
        }
        try {
          return JSON.parse(lines.join("\n"));
        } catch {
          throw new Error(`${label} returned invalid JSON`);
        }
      }
    }
    sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isJSONContentType(value) {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(";");
  const mediaType = (separator < 0 ? value : value.slice(0, separator)).trim().toLowerCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(mediaType) || mediaType !== "application/json") return false;
  if (separator < 0) return true;

  const parameterNames = new Set();
  let index = separator + 1;
  while (index < value.length) {
    while (index < value.length && /[ \t]/u.test(value[index])) index += 1;
    if (index === value.length) return true;
    const nameStart = index;
    while (index < value.length && /[!#$%&'*+\-.^_`|~0-9A-Za-z]/u.test(value[index])) index += 1;
    if (nameStart === index) return false;
    const name = value.slice(nameStart, index).toLowerCase();
    if (parameterNames.has(name)) return false;
    parameterNames.add(name);
    while (index < value.length && /[ \t]/u.test(value[index])) index += 1;
    if (value[index] !== "=") return false;
    index += 1;
    while (index < value.length && /[ \t]/u.test(value[index])) index += 1;
    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const character = value[index];
        if (character === "\\") {
          index += 1;
          if (index >= value.length || /[\r\n]/u.test(value[index])) return false;
          index += 1;
        } else if (character === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          if (character !== "\t" && character.charCodeAt(0) < 0x20) return false;
          index += 1;
        }
      }
      if (!closed) return false;
    } else {
      const valueStart = index;
      while (index < value.length && /[!#$%&'*+\-.^_`|~0-9A-Za-z]/u.test(value[index])) index += 1;
      if (valueStart === index) return false;
    }
    while (index < value.length && /[ \t]/u.test(value[index])) index += 1;
    if (index < value.length) {
      if (value[index] !== ";") return false;
      index += 1;
    }
  }
  return true;
}

function readBuiltProtocolRevision(plugin) {
  const candidates = [
    join(plugin.directory, "dist", "packages", "protocol", "generated", "typescript", "revision.js"),
    join(repositoryRoot, "packages", "sdk", "dist", "packages", "protocol", "generated", "typescript", "revision.js"),
    join(repositoryRoot, "packages", "plugin-runtime", "dist", "packages", "protocol", "generated", "typescript", "revision.js")
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const match = /ATLAS_PROTOCOL_REVISION\s*=\s*["'](sha256:[0-9a-f]{64})["']/u.exec(readFileSync(path, "utf8"));
    if (match) return match[1];
  }
  throw new Error(`${plugin.id} uses_core_sdk=true, but no built SDK protocol revision was found; run npm run build:sdk first`);
}

function imageRepository(plugin) {
  const repository = plugin.manifest.release?.image_repository;
  if (typeof repository !== "string" || !/^ghcr\.io\/the-drunken-coder\/[a-z0-9][a-z0-9-]*$/u.test(repository)) {
    throw new Error(`${plugin.manifestPath} release.image_repository is invalid`);
  }
  const expected = `ghcr.io/the-drunken-coder/atlas-${plugin.id.replaceAll("_", "-")}`;
  if (repository !== expected) throw new Error(`${plugin.manifestPath} release.image_repository must be ${expected}`);
  return repository;
}

function validateReleaseVersion(plugin, version) {
  validateVersion(version);
  if (readPackageVersion(plugin) !== version) {
    throw new Error(`${plugin.id} package.json version ${readPackageVersion(plugin)} does not match requested release ${version}`);
  }
}

function readPackageVersion(plugin) {
  return readJSON(join(plugin.directory, "package.json")).version;
}

function validateVersion(value) {
  if (typeof value !== "string" || !semverPattern.test(value)) throw new Error(`Version must be stable SemVer without a leading v: ${value ?? ""}`);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function runCapture(commandName, args, allowFailure = false) {
  const result = spawnSync(commandName, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${commandName} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

function sleep(milliseconds) {
  const result = spawnSync("sleep", [String(milliseconds / 1000)], { cwd: repositoryRoot, stdio: "ignore" });
  if (result.status !== 0) throw new Error("sleep failed while waiting for candidate container");
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${relative(repositoryRoot, path)} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
