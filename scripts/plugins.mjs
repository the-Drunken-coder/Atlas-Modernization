import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAuthoredManifest } from "./plugin-manifest-validation.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginsRoot = join(repositoryRoot, "plugins");
const pluginImageToken = "@atlas/plugin-image@";
const sharedProductionRoots = [
  "packages/plugin-runtime/src",
  "packages/sdk/src",
  "services/core/cmd",
  "services/core/internal",
  "surfaces/command-interface/src",
  "surfaces/core-cli/src"
];

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
  case "check-seepage":
    verifyPlugins(plugins);
    checkSeepage(plugins);
    break;
  default:
    throw new Error(
      "Usage: node scripts/plugins.mjs <verify|build|test|check|docker-build|check-seepage>"
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
  validateAuthoredManifest(manifest, manifestPath);
  if (basename(directory) !== manifest.plugin_id) {
    throw new Error(`${manifestPath} plugin_id must match its folder name`);
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
      ...(plugin.manifest.source_connector ? [plugin.manifest.source_connector] : [])
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
    if (plugin.manifest.source_connector) {
      const connector = readJSON(join(plugin.directory, plugin.manifest.source_connector));
      assertRecord(connector, `${plugin.id} Source connector fragment`);
      if (connector.id !== plugin.id) {
        throw new Error(`${plugin.id} Source connector fragment must use its plugin_id`);
      }
    }
    if (plugin.manifest.release.channel === "independent") {
      const compose = readFileSync(join(plugin.directory, plugin.manifest.compose), "utf8");
      if (compose.split(pluginImageToken).length !== 2) {
        throw new Error(`${plugin.id} published Compose overlay must contain exactly one ${pluginImageToken} token`);
      }
    }
  }
  if (!quiet) process.stdout.write(`Verified ${entries.length} plugin folder${entries.length === 1 ? "" : "s"}.\n`);
}

function checkSeepage(entries) {
  const forbiddenTerms = entries.flatMap((plugin) => plugin.manifest.shared_code_forbidden_terms);
  const pluginIdLiterals = entries.flatMap((plugin) => [
    JSON.stringify(plugin.id),
    `'${plugin.id}'`,
    `\`${plugin.id}\``
  ]);
  const packageNames = entries.map((plugin) => plugin.packageName);
  const violations = [];
  for (const root of sharedProductionRoots) {
    const absoluteRoot = join(repositoryRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    for (const file of walkFiles(absoluteRoot)) {
      const repositoryPath = relative(repositoryRoot, file).split(sep).join("/");
      if (/(?:^|\/)(?:test|tests)(?:\/|$)|_test\.go$|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(repositoryPath)) continue;
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
      for (const literal of pluginIdLiterals) {
        if (contents.includes(literal)) {
          violations.push(`${repositoryPath}: contains hard-coded plugin ID ${literal}`);
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
