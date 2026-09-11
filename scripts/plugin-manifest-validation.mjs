const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const imageRepositoryPattern = /^ghcr\.io\/the-drunken-coder\/[a-z0-9][a-z0-9-]*$/u;
const servicePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const authoredManifestKeys = [
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
];

export function validateAuthoredManifest(manifest, manifestPath) {
  assertRecord(manifest, manifestPath);
  assertExactKeys(manifest, authoredManifestKeys, manifestPath);
  if (manifest.schema !== 1) throw new Error(`${manifestPath} must use schema 1`);
  if (typeof manifest.plugin_id !== "string" || !identifierPattern.test(manifest.plugin_id)) {
    throw new Error(`${manifestPath} has an invalid plugin_id`);
  }
  if (
    typeof manifest.display_name !== "string" ||
    manifest.display_name.trim() !== manifest.display_name ||
    !manifest.display_name ||
    manifest.display_name.length > 100
  ) {
    throw new Error(`${manifestPath} has an invalid display_name`);
  }
  if (manifest.lifecycle !== "query_only") throw new Error(`${manifestPath} lifecycle must be query_only`);
  if (typeof manifest.uses_core_sdk !== "boolean") {
    throw new Error(`${manifestPath} uses_core_sdk must be a boolean`);
  }
  if (!Array.isArray(manifest.interactions) || manifest.interactions.some((kind) => kind !== "map_area")) {
    throw new Error(`${manifestPath} interactions must be a map_area array`);
  }
  if ([...manifest.interactions].sort().join("\u0000") !== manifest.interactions.join("\u0000")) {
    throw new Error(`${manifestPath} interactions must be sorted`);
  }
  if (new Set(manifest.interactions).size !== manifest.interactions.length) {
    throw new Error(`${manifestPath} interactions must not contain duplicates`);
  }
  if (typeof manifest.package !== "string" || !manifest.package) throw new Error(`${manifestPath} package is invalid`);
  if (typeof manifest.docker_target !== "string" || !identifierPattern.test(manifest.docker_target)) {
    throw new Error(`${manifestPath} docker_target is invalid`);
  }
  if (typeof manifest.service !== "string" || !servicePattern.test(manifest.service)) {
    throw new Error(`${manifestPath} service is invalid`);
  }
  for (const field of ["compose", "core_endpoint"]) {
    if (typeof manifest[field] !== "string" || !manifest[field]) throw new Error(`${manifestPath} ${field} is invalid`);
    assertLocalFileName(manifest[field], `${manifestPath} ${field}`);
  }
  if (manifest.source_connector !== null) {
    if (typeof manifest.source_connector !== "string" || !manifest.source_connector) {
      throw new Error(`${manifestPath} source_connector must be null or a local file name`);
    }
    assertLocalFileName(manifest.source_connector, `${manifestPath} source_connector`);
  }
  if (!Array.isArray(manifest.shared_code_forbidden_terms)) {
    throw new Error(`${manifestPath} shared_code_forbidden_terms must be an array`);
  }
  for (const term of manifest.shared_code_forbidden_terms) {
    if (typeof term !== "string" || term.length < 4) {
      throw new Error(`${manifestPath} has an invalid shared_code_forbidden_terms entry`);
    }
  }
  assertRecord(manifest.release, `${manifestPath} release`);
  if (manifest.release.channel === "development") {
    assertExactKeys(manifest.release, ["channel"], `${manifestPath} release`);
  } else if (manifest.release.channel === "independent") {
    assertExactKeys(manifest.release, ["channel", "image_repository"], `${manifestPath} release`);
    if (typeof manifest.release.image_repository !== "string" || !imageRepositoryPattern.test(manifest.release.image_repository)) {
      throw new Error(`${manifestPath} release.image_repository must be a first-party GHCR repository`);
    }
    const expected = `ghcr.io/the-drunken-coder/atlas-${manifest.plugin_id.replaceAll("_", "-")}`;
    if (manifest.release.image_repository !== expected) {
      throw new Error(`${manifestPath} release.image_repository must be ${expected}`);
    }
  } else {
    throw new Error(`${manifestPath} release.channel must be development or independent`);
  }
  return manifest;
}

function assertLocalFileName(value, label) {
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(`${label} must name a file inside the plugin folder`);
  }
}

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}
