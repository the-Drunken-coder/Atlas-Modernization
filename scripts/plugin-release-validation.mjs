const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const imagePattern = /^ghcr\.io\/the-drunken-coder\/[a-z0-9][a-z0-9-]*@sha256:[0-9a-f]{64}$/u;
const protocolRevisionPattern = /^sha256:[0-9a-f]{64}$/u;
const maxStringBytes = 2048;

/**
 * Validate the release document contract shared by the publisher and catalog.
 * Keeping this at the scripts boundary prevents a catalog from signing a
 * document that the release publisher or host would reject.
 */
export function validateReleaseDocument(document) {
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
  if (!boundedString(document.plugin_id) || !identifierPattern.test(document.plugin_id) || document.plugin_id.length > 50) {
    throw new Error(`${label} has an invalid plugin_id`);
  }
  if (!boundedString(document.version) || !semverPattern.test(document.version)) {
    throw new Error(`${label} has an invalid version`);
  }
  if (!boundedString(document.display_name) || document.display_name.trim() !== document.display_name || !document.display_name || document.display_name.length > 100) {
    throw new Error(`${label} has an invalid display_name`);
  }
  if (document.lifecycle !== "query_only") throw new Error(`${label} lifecycle must be query_only`);
  const expectedImage = `ghcr.io/the-drunken-coder/atlas-${document.plugin_id.replaceAll("_", "-")}@`;
  if (!boundedString(document.image) || !document.image.startsWith(expectedImage) || !imagePattern.test(document.image)) throw new Error(`${label} image must be the expected immutable first-party digest reference`);
  if (!positiveSafeInteger(document.core_to_plugin_protocol_major) || !positiveSafeInteger(document.plugin_to_source_gateway_protocol_major)) {
    throw new Error(`${label} protocol majors must be positive safe integers`);
  }
  if (document.atlas_protocol_revision !== null && (!boundedString(document.atlas_protocol_revision) || !protocolRevisionPattern.test(document.atlas_protocol_revision))) {
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

export function validateSourceConnector(value, pluginId) {
  assertExactKeys(value, ["id", "origin", "routes", "secret_headers", "egress", "limits", "rate", "circuit_breaker"], `${pluginId} source connector`);
  if (!boundedString(value.id) || value.id !== pluginId || !identifierPattern.test(value.id) || value.id.length > 50) {
    throw new Error(`${pluginId} source connector must use its plugin_id`);
  }
  if (!boundedString(value.origin)) throw new Error(`${pluginId} source connector origin must be a string`);
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
  if (!boundedString(value.method)) throw new Error(`${label} method must be a string`);
  const method = value.method.trim().toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`${label} method is unsupported`);
  if (!boundedString(value.path_prefix) || !value.path_prefix.startsWith("/") || value.path_prefix.startsWith("//") || /[\\?#\u0000]/u.test(value.path_prefix) || value.path_prefix.split("/").some((part) => part === "." || part === "..")) {
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
  if (value.read_only !== true) throw new Error(`${label} query_only releases require read_only: true`);
  assertExactKeys(value.cache, ["ttl_ms"], `${label} cache`);
  boundedInteger(value.cache.ttl_ms, 0, 3_600_000, `${label} cache.ttl_ms`);
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
    if (!boundedString(failure) || !["upstream_timeout", "upstream_unreachable"].includes(failure.trim())) {
      throw new Error(`${label} retry.failures contain an unsupported failure`);
    }
    return failure.trim();
  });
  if (new Set(failures).size !== failures.length) throw new Error(`${label} retry.failures contain duplicates`);
  if (!boundedString(value.retry.idempotency_header) || value.retry.idempotency_header.trim() !== value.retry.idempotency_header || (value.retry.idempotency_header && !headerName(value.retry.idempotency_header.toLowerCase()))) {
    throw new Error(`${label} retry.idempotency_header is invalid`);
  }

}

function validateNames(value, headers, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const names = value.map((entry) => {
    if (!boundedString(entry) || !entry.trim()) throw new Error(`${label} contains an invalid name`);
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

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxStringBytes;
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}
