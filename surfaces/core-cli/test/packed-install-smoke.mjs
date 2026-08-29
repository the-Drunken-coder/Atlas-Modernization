import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "atlas-core-package-"));
const npmCache = join(temporaryDirectory, "npm-cache");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
    stdio: "pipe",
    timeout: 60_000
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout;
}

try {
  const packOutput = run(npmCommand, [
    "pack",
    packageRoot,
    "--pack-destination",
    temporaryDirectory,
    "--json",
    "--silent"
  ]);
  const entries = JSON.parse(packOutput);
  const filename = entries.find((entry) => typeof entry?.filename === "string")?.filename;
  if (!filename) throw new Error("npm pack did not report a tarball");

  const project = join(temporaryDirectory, "consumer");
  mkdirSync(project);
  run(npmCommand, ["init", "-y", "--silent"], project);
  run(npmCommand, ["install", join(temporaryDirectory, filename), "--silent"], project);

  const installed = join(project, "node_modules", "atlas-core");
  for (const path of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "assets/docker-compose.init.yml",
    "assets/docker-compose.yml",
    "assets/postgres/init.sql"
  ]) {
    if (!existsSync(join(installed, path))) throw new Error(`installed package is missing ${path}`);
  }

  const packageJSON = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (typeof packageJSON.bin?.["atlas-core"] !== "string") throw new Error("installed package is missing its bin");
  const installedBin = join(
    project,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "atlas-core.cmd" : "atlas-core"
  );
  if (!existsSync(installedBin)) throw new Error("npm did not install the atlas-core command");
  const output = run(installedBin, ["help"], project);
  if (!output.includes("atlas-core start")) throw new Error("installed atlas-core binary did not print help");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
