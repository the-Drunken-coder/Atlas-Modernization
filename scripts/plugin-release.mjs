#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsRoot = join(repositoryRoot, "plugins");
const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const imagePattern = /^ghcr\.io\/the-drunken-coder\/[a-z0-9][a-z0-9-]*@sha256:[0-9a-f]{64}$/u;
const protocolRevisionPattern = /^sha256:[0-9a-f]{64}$/u;
const releaseDocumentLimit = 1 << 20;
const releaseRedirectLimit = 5;
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
    const output = rawArgs[3] ? resolve(repositoryRoot, rawArgs[3]) : undefined;
    if (output) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    }
    break;
  }
  case "verify-document":
    verifyReleaseDocument(readJSON(resolve(repositoryRoot, required(rawArgs[0], "document path"))));
    break;
  case "verify-public-release":
    await verifyPublicRelease(required(rawArgs[0], "release URL"), resolve(repositoryRoot, required(rawArgs[1], "local document path")));
    break;
  case "check-candidate": {
    const plugin = readPlugin(required(rawArgs[0], "plugin_id"));
    validatePlugin(plugin);
    checkCandidate(plugin, required(rawArgs[1], "image reference"));
    break;
  }
  default:
    throw new Error(
      "Usage: node scripts/plugin-release.mjs <validate-version|validate-plugin|protocol-revision|release-document|verify-document|verify-public-release|check-candidate> ..."
    );
}

function readPlugin(pluginId) {
  if (!identifierPattern.test(pluginId)) throw new Error(`Invalid plugin_id: ${pluginId}`);
  const directory = join(pluginsRoot, pluginId);
  const manifestPath = join(directory, "atlas-plugin.json");
  if (!existsSync(manifestPath)) throw new Error(`Plugin ${pluginId} has no atlas-plugin.json`);
  const manifest = readJSON(manifestPath);
  if (!isRecord(manifest)) throw new Error(`${relative(repositoryRoot, manifestPath)} must be an object`);
  assertExactKeys(
    manifest,
    [
      "schema",
      "plugin_id",
      "display_name",
      "lifecycle",
      "uses_core_sdk",
      "interactions",
      "package",
      "docker_target",
      "service",
      "compose",
      "core_endpoint",
      "source_connector",
      "release",
      "shared_code_forbidden_terms"
    ],
    manifestPath
  );
  return { directory, id: pluginId, manifest, manifestPath };
}

function validatePlugin(plugin) {
  const { manifest } = plugin;
  if (manifest.schema !== 1) throw new Error(`${plugin.manifestPath} must use schema 1`);
  if (manifest.plugin_id !== plugin.id) throw new Error(`${plugin.manifestPath} plugin_id does not match its folder`);
  if (typeof manifest.display_name !== "string" || manifest.display_name.trim() !== manifest.display_name || !manifest.display_name) {
    throw new Error(`${plugin.manifestPath} display_name must be a trimmed non-empty string`);
  }
  if (manifest.display_name.length > 100) throw new Error(`${plugin.manifestPath} display_name is too long`);
  if (manifest.lifecycle !== "query_only") throw new Error(`${plugin.manifestPath} lifecycle must be query_only`);
  if (typeof manifest.uses_core_sdk !== "boolean") throw new Error(`${plugin.manifestPath} uses_core_sdk must be a boolean`);
  if (!Array.isArray(manifest.interactions) || new Set(manifest.interactions).size !== manifest.interactions.length) {
    throw new Error(`${plugin.manifestPath} interactions must be a duplicate-free array`);
  }
  if (manifest.interactions.some((kind) => kind !== "map_area")) {
    throw new Error(`${plugin.manifestPath} interactions contains an unsupported kind`);
  }
  if ([...manifest.interactions].sort().join("\u0000") !== manifest.interactions.join("\u0000")) {
    throw new Error(`${plugin.manifestPath} interactions must be sorted`);
  }
  if (typeof manifest.package !== "string" || !manifest.package) throw new Error(`${plugin.manifestPath} package is invalid`);
  for (const field of ["compose", "core_endpoint"]) {
    if (typeof manifest[field] !== "string" || !isLocalFileName(manifest[field])) {
      throw new Error(`${plugin.manifestPath} ${field} must name a local file`);
    }
  }
  if (manifest.source_connector !== null && (typeof manifest.source_connector !== "string" || !isLocalFileName(manifest.source_connector))) {
    throw new Error(`${plugin.manifestPath} source_connector must be null or a local file name`);
  }
  if (!isRecord(manifest.release) || manifest.release.channel !== "independent" || !imageRepository(plugin)) {
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

function verifyReleaseDocument(document) {
  const label = "release document";
  if (!isRecord(document)) throw new Error(`${label} must be an object`);
  assertExactKeys(
    document,
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
    label
  );
  if (document.schema !== 1) throw new Error(`${label} schema must be 1`);
  if (typeof document.plugin_id !== "string" || !identifierPattern.test(document.plugin_id) || document.plugin_id.length > 50) {
    throw new Error(`${label} has an invalid plugin_id`);
  }
  validateVersion(document.version);
  if (typeof document.display_name !== "string" || document.display_name.trim() !== document.display_name || !document.display_name || document.display_name.length > 100) {
    throw new Error(`${label} has an invalid display_name`);
  }
  if (document.lifecycle !== "query_only") throw new Error(`${label} lifecycle must be query_only`);
  const expectedImage = `ghcr.io/the-drunken-coder/atlas-${document.plugin_id.replaceAll("_", "-")}@`;
  if (!document.image.startsWith(expectedImage) || !imagePattern.test(document.image)) throw new Error(`${label} image must be the expected immutable first-party digest reference`);
  if (!positiveSafeInteger(document.core_to_plugin_protocol_major) || !positiveSafeInteger(document.plugin_to_source_gateway_protocol_major)) {
    throw new Error(`${label} protocol majors must be positive safe integers`);
  }
  if (document.atlas_protocol_revision !== null && !protocolRevisionPattern.test(document.atlas_protocol_revision)) {
    throw new Error(`${label} has an invalid atlas_protocol_revision`);
  }
  if (!Array.isArray(document.interactions) || new Set(document.interactions).size !== document.interactions.length || document.interactions.some((kind) => kind !== "map_area")) {
    throw new Error(`${label} interactions must be a duplicate-free map_area array`);
  }
  if ([...document.interactions].sort().join("\u0000") !== document.interactions.join("\u0000")) {
    throw new Error(`${label} interactions must be sorted`);
  }
  if (document.source_connector !== null) validateSourceConnector(document.source_connector, document.plugin_id);
  return document;
}

function checkCandidate(plugin, image) {
  if (!imagePattern.test(image)) throw new Error(`Candidate image is not an immutable first-party digest reference: ${image}`);
  const expectedRepository = imageRepository(plugin);
  if (!image.startsWith(`${expectedRepository}@`)) throw new Error(`${plugin.id} candidate image uses the wrong repository`);
  const networkName = `atlas-plugin-release-${process.pid}-${Date.now()}`;
  runCapture("docker", ["network", "create", networkName]);
  let containerId;
  try {
    const container = runCapture("docker", ["run", "--detach", "--rm", "--network", networkName, "--publish", "127.0.0.1::8080", image]);
    containerId = container.trim();
    if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new Error(`Docker returned an invalid candidate container ID: ${containerId}`);
    const port = waitForCandidatePort(containerId);
    const manifest = waitForJSON(`http://127.0.0.1:${port}/manifest`, 200, "candidate manifest");
    validateCandidateManifest(plugin, manifest);
    const health = waitForJSON(`http://127.0.0.1:${port}/health`, 200, "candidate health");
    if (!isRecord(health) || Object.keys(health).length !== 1 || health.status !== "ok") {
      throw new Error("Candidate /health did not return {\"status\":\"ok\"}");
    }
    const routeResponse = runCapture("curl", ["--silent", "--show-error", "--max-time", "2", "--write-out", "\n%{http_code}", `http://127.0.0.1:${port}/__atlas_candidate_missing__`], true).trimEnd();
    const routeLines = routeResponse.split("\n");
    const routeStatus = routeLines.pop();
    if (routeStatus !== "404" || routeLines.join("\n") !== '{"code":"route_not_found"}') {
      throw new Error(`Candidate missing route must return {"code":"route_not_found"} with HTTP 404; got HTTP ${routeStatus}`);
    }
  } finally {
    if (containerId) spawnSync("docker", ["rm", "--force", containerId], { cwd: repositoryRoot, stdio: "ignore" });
    spawnSync("docker", ["network", "rm", networkName], { cwd: repositoryRoot, stdio: "ignore" });
  }
  process.stdout.write(`Candidate ${image} passed the ${plugin.id} runtime contract checks.\n`);
}

async function verifyPublicRelease(url, localPath) {
  const localBytes = readFileSync(localPath);
  const document = verifyReleaseDocument(readJSON(localPath));
  const expectedURL = releaseDocumentURL(document.plugin_id, document.version);
  if (url !== expectedURL) throw new Error(`Release URL must exactly equal ${expectedURL}`);
  const remoteBytes = await fetchPublicRelease(url);
  if (!remoteBytes.equals(localBytes)) throw new Error("Public release document bytes do not match the reviewed release document");
  process.stdout.write(`Verified anonymous public release document at ${url}.\n`);
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
    const result = spawnSync("curl", ["--silent", "--show-error", "--max-time", "2", "--write-out", "\n%{http_code}", url], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: "pipe"
    });
    if (result.status === 0) {
      const lines = result.stdout.trimEnd().split("\n");
      const status = Number(lines.pop());
      if (status === expectedStatus) {
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

function validateSourceConnector(value, pluginId) {
  assertExactKeys(value, ["id", "origin", "routes", "secret_headers", "egress", "limits", "rate", "circuit_breaker"], `${pluginId} source connector`);
  if (typeof value.id !== "string" || value.id !== pluginId || !identifierPattern.test(value.id) || value.id.length > 50) {
    throw new Error(`${pluginId} source connector must use its plugin_id`);
  }
  if (typeof value.origin !== "string") throw new Error(`${pluginId} source connector origin must be a string`);
  let origin;
  try {
    origin = new URL(value.origin);
  } catch {
    throw new Error(`${pluginId} source connector origin must be an HTTP origin`);
  }
  if (
    !origin.hostname ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    (origin.pathname !== "/" && origin.pathname !== "") ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(`${pluginId} source connector origin must be an HTTP origin without credentials or path`);
  }
  assertExactKeys(value.secret_headers, [], `${pluginId} source connector secret_headers`);
  const routes = value.routes;
  if (!Array.isArray(routes) || routes.length === 0) throw new Error(`${pluginId} source connector routes must not be empty`);
  const seenRoutes = new Set();
  routes.forEach((route, index) => validateSourceRoute(route, index, seenRoutes));
  assertExactKeys(value.egress, ["allow_private", "allow_loopback", "allow_link_local"], `${pluginId} source connector egress`);
  for (const field of ["allow_private", "allow_loopback", "allow_link_local"]) {
    if (typeof value.egress[field] !== "boolean") throw new Error(`${pluginId} source connector egress.${field} must be boolean`);
  }
  assertExactKeys(
    value.limits,
    ["timeout_ms", "max_request_bytes", "max_response_bytes", "max_concurrency", "max_header_count", "max_header_bytes"],
    `${pluginId} source connector limits`
  );
  boundedInteger(value.limits.timeout_ms, 1, 30_000, `${pluginId} source connector limits.timeout_ms`);
  boundedInteger(value.limits.max_request_bytes, 1, 4 << 20, `${pluginId} source connector limits.max_request_bytes`);
  boundedInteger(value.limits.max_response_bytes, 1, 16 << 20, `${pluginId} source connector limits.max_response_bytes`);
  boundedInteger(value.limits.max_concurrency, 1, 64, `${pluginId} source connector limits.max_concurrency`);
  boundedInteger(value.limits.max_header_count, 1, 128, `${pluginId} source connector limits.max_header_count`);
  boundedInteger(value.limits.max_header_bytes, 1, 256 << 10, `${pluginId} source connector limits.max_header_bytes`);
  assertExactKeys(value.rate, ["requests_per_second"], `${pluginId} source connector rate`);
  if (typeof value.rate.requests_per_second !== "number" || !Number.isFinite(value.rate.requests_per_second) || value.rate.requests_per_second < 0 || value.rate.requests_per_second > 1000) {
    throw new Error(`${pluginId} source connector rate.requests_per_second is out of range`);
  }
  assertExactKeys(value.circuit_breaker, ["failures", "open_ms"], `${pluginId} source connector circuit_breaker`);
  boundedInteger(value.circuit_breaker.failures, 1, 100, `${pluginId} source connector circuit_breaker.failures`);
  boundedInteger(value.circuit_breaker.open_ms, 1, 3_600_000, `${pluginId} source connector circuit_breaker.open_ms`);
}

function validateSourceRoute(value, index, seenRoutes) {
  const label = `source connector routes[${index}]`;
  assertExactKeys(
    value,
    ["method", "path_prefix", "allowed_query_names", "allowed_request_headers", "allowed_response_headers", "read_only", "cache", "retry"],
    label
  );
  if (typeof value.method !== "string") throw new Error(`${label} method must be a string`);
  const method = value.method.trim().toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`${label} method is unsupported`);
  if (typeof value.path_prefix !== "string" || !value.path_prefix.startsWith("/") || value.path_prefix.startsWith("//") || /[\\?#\u0000]/u.test(value.path_prefix) || value.path_prefix.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${label} path_prefix is invalid`);
  }
  const routeKey = `${method} ${value.path_prefix}`;
  if (seenRoutes.has(routeKey)) throw new Error(`${label} is duplicated`);
  seenRoutes.add(routeKey);
  validateNames(value.allowed_query_names, false, `${label} allowed_query_names`);
  const requestHeaders = validateNames(value.allowed_request_headers, true, `${label} allowed_request_headers`);
  const responseHeaders = validateNames(value.allowed_response_headers, true, `${label} allowed_response_headers`);
  const forbiddenRequest = new Set(["connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "authorization", "cookie"]);
  const forbiddenResponse = new Set(["connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "authorization", "cookie", "set-cookie"]);
  if (requestHeaders.some((header) => forbiddenRequest.has(header))) throw new Error(`${label} has a forbidden request header`);
  if (responseHeaders.some((header) => forbiddenResponse.has(header))) throw new Error(`${label} has a forbidden response header`);
  if (typeof value.read_only !== "boolean") throw new Error(`${label} read_only must be boolean`);
  assertExactKeys(value.cache, ["ttl_ms"], `${label} cache`);
  boundedInteger(value.cache.ttl_ms, 0, 3_600_000, `${label} cache.ttl_ms`);
  if (value.cache.ttl_ms > 0 && !value.read_only) throw new Error(`${label} cached routes must be read_only`);
  assertExactKeys(value.retry, ["max_retries", "statuses", "failures", "idempotency_header"], `${label} retry`);
  boundedInteger(value.retry.max_retries, 0, 3, `${label} retry.max_retries`);
  if (!Array.isArray(value.retry.statuses)) throw new Error(`${label} retry.statuses must be an array`);
  const statuses = value.retry.statuses.map((status, statusIndex) => {
    boundedInteger(status, 100, 599, `${label} retry.statuses[${statusIndex}]`);
    return status;
  });
  if (new Set(statuses).size !== statuses.length) throw new Error(`${label} retry.statuses contain duplicates`);
  if (!Array.isArray(value.retry.failures)) throw new Error(`${label} retry.failures must be an array`);
  const failures = value.retry.failures.map((failure) => {
    if (typeof failure !== "string" || !["upstream_timeout", "upstream_unreachable"].includes(failure.trim())) {
      throw new Error(`${label} retry.failures contain an unsupported failure`);
    }
    return failure.trim();
  });
  if (new Set(failures).size !== failures.length) throw new Error(`${label} retry.failures contain duplicates`);
  if (typeof value.retry.idempotency_header !== "string" || value.retry.idempotency_header.trim() !== value.retry.idempotency_header || (value.retry.idempotency_header && !headerName(value.retry.idempotency_header.toLowerCase()))) {
    throw new Error(`${label} retry.idempotency_header is invalid`);
  }
  if (value.retry.max_retries > 0 && !value.read_only && !value.retry.idempotency_header) throw new Error(`${label} mutating retries require idempotency_header`);
}

function validateNames(value, headers, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const names = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${label} contains an invalid name`);
    const name = headers ? entry.trim().toLowerCase() : entry.trim();
    if (headers && !headerName(name)) throw new Error(`${label} contains an invalid name`);
    return name;
  });
  if (new Set(names).size !== names.length) throw new Error(`${label} contains duplicates`);
  return names;
}

function headerName(value) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value);
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
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

function isLocalFileName(value) {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
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

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}
