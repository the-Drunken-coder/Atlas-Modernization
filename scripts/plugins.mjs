import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsRoot = join(repositoryRoot, "plugins");
const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const imageRepositoryPattern = /^ghcr\.io\/the-drunken-coder\/[a-z0-9][a-z0-9-]*$/u;
const packageImagePattern = /^ghcr\.io\/the-drunken-coder\/[a-z0-9][a-z0-9-]*@sha256:[0-9a-f]{64}$/u;
const pluginImageToken = "@atlas/plugin-image@";
const sharedProductionRoots = [
  "packages/plugin-runtime/src",
  "packages/sdk/src",
  "services/core/cmd",
  "services/core/internal",
  "surfaces/command-interface/src",
  "surfaces/core-cli/src"
];
const generatedSharedFiles = new Set(["surfaces/core-cli/src/plugin-catalog.generated.ts"]);

const [command, ...args] = process.argv.slice(2);
const plugins = discoverPlugins();

switch (command) {
  case "verify":
    verifyPlugins(plugins);
    break;
  case "build":
    verifyPlugins(plugins);
    for (const plugin of plugins) run("npm", ["run", "build", "--workspace", plugin.packageName]);
    break;
  case "test":
    verifyPlugins(plugins);
    for (const plugin of plugins) run("npm", ["test", "--workspace", plugin.packageName]);
    break;
  case "check":
    verifyPlugins(plugins);
    for (const plugin of plugins) {
      const packageJSON = readJSON(join(plugin.directory, "package.json"));
      for (const script of ["format:check", "lint", "test", "build"]) {
        if (packageJSON.scripts?.[script]) run("npm", ["run", script, "--workspace", plugin.packageName]);
      }
    }
    break;
  case "docker-build":
    verifyPlugins(plugins);
    for (const plugin of plugins) {
      run("docker", [
        "build",
        ".",
        "--file",
        relative(repositoryRoot, join(plugin.directory, "Dockerfile")),
        "--target",
        plugin.manifest.docker_target,
        "--tag",
        `atlas-plugin-${plugin.id}:verify`
      ]);
    }
    break;
  case "generate-catalog": {
    const packageRootFlag = args.indexOf("--package-root");
    if (packageRootFlag === -1 || !args[packageRootFlag + 1]) {
      throw new Error("generate-catalog requires --package-root <directory>");
    }
    verifyPlugins(plugins, true);
    generateCatalog(plugins, resolve(repositoryRoot, args[packageRootFlag + 1]), false, true);
    break;
  }
  case "check-seepage":
    verifyPlugins(plugins);
    checkSeepage(plugins);
    break;
  case "release-plan":
    verifyPlugins(plugins, true);
    process.stdout.write(
      `${JSON.stringify(
        publishedPlugins(plugins).map((plugin) => ({
          plugin_id: plugin.id,
          image_repository: plugin.manifest.release.image_repository,
          dockerfile: relative(repositoryRoot, join(plugin.directory, "Dockerfile")),
          docker_target: plugin.manifest.docker_target
        }))
      )}\n`
    );
    break;
  case "record-release-images": {
    const packageRoot = packageRootArgument(args, "record-release-images");
    const images = JSON.parse(process.env.ATLAS_PLUGIN_IMAGES_JSON ?? "");
    validatePackageImages(plugins, images, `${packageRoot}/package.json atlasPluginImages`, true);
    const packageJSONPath = join(packageRoot, "package.json");
    const packageJSON = readJSON(packageJSONPath);
    packageJSON.atlasPluginImages = images;
    writeFileSync(packageJSONPath, `${JSON.stringify(packageJSON, null, 2)}\n`);
    generateCatalog(plugins, packageRoot, true, true);
    break;
  }
  case "verify-release-images": {
    const packageRoot = packageRootArgument(args, "verify-release-images");
    const packageJSON = readJSON(join(packageRoot, "package.json"));
    validatePackageImages(plugins, packageJSON.atlasPluginImages, `${packageRoot}/package.json atlasPluginImages`, true);
    break;
  }
  default:
    throw new Error(
      "Usage: node scripts/plugins.mjs <verify|build|test|check|docker-build|generate-catalog|check-seepage|release-plan|record-release-images|verify-release-images>"
    );
}

function discoverPlugins() {
  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => readPlugin(join(pluginsRoot, entry.name)))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function readPlugin(directory) {
  const manifestPath = join(directory, "atlas-plugin.json");
  if (!existsSync(manifestPath)) throw new Error(`${relative(repositoryRoot, directory)} is missing atlas-plugin.json`);
  const manifest = readJSON(manifestPath);
  assertRecord(manifest, manifestPath);
  assertExactKeys(
    manifest,
    [
      "schema",
      "plugin_id",
      "display_name",
      "lifecycle",
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
  if (manifest.schema !== 1) throw new Error(`${manifestPath} must use schema 1`);
  if (typeof manifest.plugin_id !== "string" || !identifierPattern.test(manifest.plugin_id)) {
    throw new Error(`${manifestPath} has an invalid plugin_id`);
  }
  if (basename(directory) !== manifest.plugin_id) {
    throw new Error(`${manifestPath} plugin_id must match its folder name`);
  }
  if (typeof manifest.display_name !== "string" || manifest.display_name.trim() !== manifest.display_name) {
    throw new Error(`${manifestPath} has an invalid display_name`);
  }
  if (manifest.lifecycle !== "query_only") throw new Error(`${manifestPath} lifecycle must be query_only`);
  if (typeof manifest.package !== "string" || !manifest.package) throw new Error(`${manifestPath} package is invalid`);
  if (typeof manifest.docker_target !== "string" || !identifierPattern.test(manifest.docker_target)) {
    throw new Error(`${manifestPath} docker_target is invalid`);
  }
  if (typeof manifest.service !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(manifest.service)) {
    throw new Error(`${manifestPath} service is invalid`);
  }
  for (const field of ["compose", "core_endpoint", "source_connector"]) {
    if (typeof manifest[field] !== "string" || !manifest[field]) throw new Error(`${manifestPath} ${field} is invalid`);
    assertLocalFileName(manifest[field], `${manifestPath} ${field}`);
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
  } else if (manifest.release.channel === "atlas_core") {
    assertExactKeys(manifest.release, ["channel", "image_repository"], `${manifestPath} release`);
    if (!imageRepositoryPattern.test(manifest.release.image_repository)) {
      throw new Error(`${manifestPath} release.image_repository must be a first-party GHCR repository`);
    }
  } else {
    throw new Error(`${manifestPath} release.channel must be development or atlas_core`);
  }
  return {
    directory,
    id: manifest.plugin_id,
    packageName: manifest.package,
    manifest
  };
}

function verifyPlugins(entries, quiet = false) {
  if (entries.length === 0) throw new Error("plugins/ must contain at least one plugin");
  const ids = new Set();
  const packages = new Set();
  for (const plugin of entries) {
    if (ids.has(plugin.id)) throw new Error(`duplicate plugin_id ${plugin.id}`);
    if (packages.has(plugin.packageName)) throw new Error(`duplicate plugin package ${plugin.packageName}`);
    ids.add(plugin.id);
    packages.add(plugin.packageName);

    for (const required of [
      "package.json",
      "src",
      "test",
      "Dockerfile",
      plugin.manifest.compose,
      plugin.manifest.core_endpoint,
      plugin.manifest.source_connector
    ]) {
      if (!existsSync(join(plugin.directory, required))) {
        throw new Error(`${relative(repositoryRoot, plugin.directory)} is missing ${required}`);
      }
    }

    const packageJSON = readJSON(join(plugin.directory, "package.json"));
    if (packageJSON.name !== plugin.packageName) {
      throw new Error(`${relative(repositoryRoot, plugin.directory)}/package.json name does not match atlas-plugin.json`);
    }
    const endpoint = readJSON(join(plugin.directory, plugin.manifest.core_endpoint));
    assertRecord(endpoint, `${plugin.id} Core endpoint fragment`);
    assertExactKeys(endpoint, ["id", "base_url"], `${plugin.id} Core endpoint fragment`);
    if (endpoint.id !== plugin.id || typeof endpoint.base_url !== "string") {
      throw new Error(`${plugin.id} Core endpoint fragment must contain its plugin_id and base_url`);
    }
    const connector = readJSON(join(plugin.directory, plugin.manifest.source_connector));
    assertRecord(connector, `${plugin.id} Source connector fragment`);
    if (connector.id !== plugin.id) {
      throw new Error(`${plugin.id} Source connector fragment must use its plugin_id`);
    }
    if (plugin.manifest.release.channel === "atlas_core") {
      const compose = readFileSync(join(plugin.directory, plugin.manifest.compose), "utf8");
      if (compose.split(pluginImageToken).length !== 2) {
        throw new Error(`${plugin.id} published Compose overlay must contain exactly one ${pluginImageToken} token`);
      }
    }
  }
  if (!quiet) process.stdout.write(`Verified ${entries.length} plugin folder${entries.length === 1 ? "" : "s"}.\n`);
}

function generateCatalog(entries, packageRoot, requireAllImages = false, quiet = false) {
  const packageJSONPath = join(packageRoot, "package.json");
  const packageJSON = readJSON(packageJSONPath);
  const images = packageJSON.atlasPluginImages ?? {};
  validatePackageImages(entries, images, `${packageJSONPath} atlasPluginImages`, requireAllImages);
  const published = publishedPlugins(entries);

  const catalogDirectory = join(packageRoot, "assets", "plugins");
  rmSync(catalogDirectory, { recursive: true, force: true });
  mkdirSync(catalogDirectory, { recursive: true });
  const catalog = published.map((plugin) => {
    const destination = join(catalogDirectory, plugin.id);
    mkdirSync(destination, { recursive: true });
    const assets = {
      compose: "compose.yml",
      core_endpoint: "core-endpoint.json",
      source_connector: "source-connector.json"
    };
    const composeSource = readFileSync(join(plugin.directory, plugin.manifest.compose), "utf8");
    writeFileSync(
      join(destination, assets.compose),
      images[plugin.id] ? composeSource.replace(pluginImageToken, images[plugin.id]) : composeSource
    );
    cpSync(join(plugin.directory, plugin.manifest.core_endpoint), join(destination, assets.core_endpoint));
    cpSync(join(plugin.directory, plugin.manifest.source_connector), join(destination, assets.source_connector));
    return {
      plugin_id: plugin.id,
      display_name: plugin.manifest.display_name,
      lifecycle: plugin.manifest.lifecycle,
      service: plugin.manifest.service,
      image: images[plugin.id] ?? null,
      assets
    };
  });
  writeFileSync(join(packageRoot, "assets", "plugin-catalog.json"), `${JSON.stringify({ schema: 1, plugins: catalog }, null, 2)}\n`);
  const catalogLiteral = JSON.stringify(
    catalog.map((entry) => ({
      pluginId: entry.plugin_id,
      displayName: entry.display_name,
      lifecycle: entry.lifecycle,
      service: entry.service,
      image: entry.image,
      assets: entry.assets
    })),
    null,
    2
  ).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/gu, "$1:");
  const source = `// Generated by scripts/plugins.mjs. Do not edit.\nexport const PACKAGE_PLUGIN_CATALOG = ${catalogLiteral} as const;\n`;
  writeFileSync(join(packageRoot, "src", "plugin-catalog.generated.ts"), source);
  if (!quiet) process.stdout.write(`Generated a ${catalog.length}-plugin Atlas Core catalog.\n`);
}

function publishedPlugins(entries) {
  return entries.filter((plugin) => plugin.manifest.release.channel === "atlas_core");
}

function validatePackageImages(entries, images, label, requireAll) {
  assertRecord(images, label);
  const published = publishedPlugins(entries);
  const expectedIds = new Set(published.map((plugin) => plugin.id));
  for (const [pluginId, image] of Object.entries(images)) {
    if (!expectedIds.has(pluginId)) throw new Error(`atlasPluginImages contains unknown plugin ${pluginId}`);
    if (typeof image !== "string" || !packageImagePattern.test(image)) {
      throw new Error(`atlasPluginImages.${pluginId} must be an immutable first-party GHCR digest reference`);
    }
    const repository = published.find((plugin) => plugin.id === pluginId)?.manifest.release.image_repository;
    if (!image.startsWith(`${repository}@`)) throw new Error(`atlasPluginImages.${pluginId} uses the wrong repository`);
  }
  if (requireAll) {
    const missing = published.filter((plugin) => !(plugin.id in images)).map((plugin) => plugin.id);
    if (missing.length > 0) throw new Error(`atlasPluginImages is missing published plugins: ${missing.join(", ")}`);
  }
}

function packageRootArgument(commandArgs, commandName) {
  const packageRootFlag = commandArgs.indexOf("--package-root");
  if (packageRootFlag === -1 || !commandArgs[packageRootFlag + 1]) {
    throw new Error(`${commandName} requires --package-root <directory>`);
  }
  return resolve(repositoryRoot, commandArgs[packageRootFlag + 1]);
}

function checkSeepage(entries) {
  const forbiddenTerms = entries.flatMap((plugin) => plugin.manifest.shared_code_forbidden_terms);
  const packageNames = entries.map((plugin) => plugin.packageName);
  const violations = [];
  for (const root of sharedProductionRoots) {
    const absoluteRoot = join(repositoryRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    for (const file of walkFiles(absoluteRoot)) {
      const repositoryPath = relative(repositoryRoot, file).split(sep).join("/");
      if (generatedSharedFiles.has(repositoryPath)) continue;
      if (/(?:^|\/)(?:test|tests)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(repositoryPath)) continue;
      const contents = readFileSync(file, "utf8");
      for (const match of contents.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/gu)) {
        if (entries.some((plugin) => match[1].includes(`plugins/${plugin.id}`))) {
          violations.push(`${repositoryPath}: imports a plugin folder`);
        }
      }
      for (const packageName of packageNames) {
        if (contents.includes(packageName)) violations.push(`${repositoryPath}: imports ${packageName}`);
      }
      for (const term of forbiddenTerms) {
        if (contents.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
          violations.push(`${repositoryPath}: contains plugin-owned term ${JSON.stringify(term)}`);
        }
      }
    }
  }
  if (violations.length > 0) throw new Error(`Plugin seepage check failed:\n${violations.join("\n")}`);
  process.stdout.write("Shared production code contains no plugin-folder imports or plugin-owned terms.\n");
}

function walkFiles(root) {
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(path));
    else if (entry.isFile() && /\.(?:go|mjs|ts|tsx|js|jsx|json|ya?ml)$/u.test(entry.name)) output.push(path);
  }
  return output;
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

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${relative(repositoryRoot, path)} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function run(commandName, commandArgs) {
  const result = spawnSync(commandName, commandArgs, { cwd: repositoryRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${commandName} ${commandArgs.join(" ")} failed with status ${result.status}`);
}
