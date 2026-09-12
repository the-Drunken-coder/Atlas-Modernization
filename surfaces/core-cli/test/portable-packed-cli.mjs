import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "atlas-core-portable-package-"));
const npmCache = join(temporaryDirectory, "npm-cache");
const startedAt = new Date().toISOString();
const startedAtMilliseconds = Date.now();
const configuredEvidencePath = process.env.ATLAS_CORE_PACKED_CLI_EVIDENCE;
const evidencePath =
  configuredEvidencePath ?? join(mkdtempSync(join(tmpdir(), "atlas-core-portable-package-evidence-")), "result.json");
const scenarios = [];
let packedArtifact;
let packedPackagePath;

const evidence = {
  scenario: "portable-packed-cli",
  startedAt,
  revision: revision(),
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    hostMachine: hostMachine(),
    execution: executionMode()
  },
  executionMode: ["packed-npm-consumer", "fake-linux-daemon-validation"],
  dockerAcceptance: "not-established-by-portable-fake"
};

function revision() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function hostMachine() {
  const result = spawnSync("uname", ["-m"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function executionMode() {
  if (process.platform === "darwin") {
    const translation = darwinTranslationState();
    if (translation !== "native") return translation;
  }
  const machine = hostMachine();
  if (machine === "unavailable") return "unknown";
  const normalized = machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : machine;
  return normalized === process.arch ? "native" : "emulated";
}

function darwinTranslationState() {
  const result = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" });
  const value = result.stdout?.trim();
  if (result.status === 0 && value === "1") return "translated";
  if (result.status === 0 && value === "0") return "native";
  // Intel macOS reports the Rosetta-only OID as absent for native processes.
  if (result.stderr?.includes("unknown oid")) return "native";
  return "unknown";
}

function assertExpectedRuntime() {
  const expectedPlatform = process.env.ATLAS_CORE_EXPECTED_PLATFORM;
  if (expectedPlatform && process.platform !== expectedPlatform) {
    throw new Error(`expected ${expectedPlatform} runtime, received ${process.platform}`);
  }
  const expectedArchitecture = process.env.ATLAS_CORE_EXPECTED_ARCHITECTURE;
  if (expectedArchitecture && process.arch !== expectedArchitecture) {
    throw new Error(`expected ${expectedArchitecture} runtime, received ${process.arch}`);
  }
  if (process.env.ATLAS_CORE_EXPECTED_EXECUTION === "native" && executionMode() !== "native") {
    throw new Error(`expected native execution, received ${executionMode()}`);
  }
}

function run(command, args, cwd, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache, ...environment },
    stdio: "pipe",
    timeout: 180_000
  });
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}: ${output.trim()}`);
  }
  return result.stdout;
}

function runExpectingFailure(command, args, cwd, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache, ...environment },
    stdio: "pipe",
    timeout: 60_000
  });
  if (result.error) throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status === 0) throw new Error(`${command} ${args.join(" ")} unexpectedly succeeded`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function writeEvidence(extra) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        ...evidence,
        evidencePath,
        scenarios,
        artifact: packedArtifact,
        ...extra,
        durationMs: Date.now() - startedAtMilliseconds
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  chmodSync(evidencePath, 0o600);
}

try {
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error(`portable CLI acceptance supports macOS and Linux hosts, not ${process.platform}`);
  }
  if (!["arm64", "x64"].includes(process.arch)) {
    throw new Error(`portable CLI acceptance supports arm64 and x64 hosts, not ${process.arch}`);
  }
  assertExpectedRuntime();
  scenarios.push("supported-host-runtime");

  run(npmCommand, ["run", "build"], packageRoot);
  scenarios.push("current-cli-build");
  const packOutput = run(
    npmCommand,
    ["pack", packageRoot, "--ignore-scripts", "--pack-destination", temporaryDirectory, "--json", "--silent"],
    packageRoot
  );
  const packed = JSON.parse(packOutput).find((entry) => typeof entry?.filename === "string");
  if (!packed?.filename || typeof packed.version !== "string")
    throw new Error("npm pack did not report a package tarball");
  if (typeof packed.shasum !== "string" || typeof packed.integrity !== "string") {
    throw new Error("npm pack did not report tarball integrity");
  }
  packedArtifact = { filename: packed.filename, shasum: packed.shasum, integrity: packed.integrity };
  packedPackagePath = join(temporaryDirectory, packed.filename);
  scenarios.push("packed-current-cli-artifact");

  const consumer = join(temporaryDirectory, "consumer");
  const fakeBin = join(temporaryDirectory, "fake-bin");
  const fakeCoreHome = join(temporaryDirectory, "fake-core-home");
  mkdirSync(consumer);
  mkdirSync(fakeBin);
  const fakeDocker = join(fakeBin, "docker");
  writeFileSync(
    fakeDocker,
    `#!/bin/sh
case "$1:$2" in
  --version:*) printf '%s\\n' 'Docker version 29.4.0' ;;
  compose:version) printf '%s\\n' '2.17.0' ;;
  context:show) printf '%s\\n' 'portable-test' ;;
  context:inspect) printf '%s\\n' 'unix:///tmp/atlas-core-portable-test.sock' ;;
  info:*) printf '%s\\n' '{"ID":"portable-test-engine","OSType":"windows","Architecture":"amd64"}' ;;
  *) printf 'unexpected fake Docker command: %s\\n' "$*" >&2; exit 2 ;;
esac
`
  );
  run("chmod", ["755", fakeDocker], temporaryDirectory);

  run(npmCommand, ["init", "--yes", "--silent"], consumer);
  run(
    npmCommand,
    ["install", join(temporaryDirectory, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund", "--silent"],
    consumer
  );
  scenarios.push("installed-packed-cli-consumer");

  const installed = join(consumer, "node_modules", "atlas-core");
  for (const path of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "dist/application.js",
    "assets/docker-compose.init.yml",
    "assets/docker-compose.yml",
    "assets/source_gateway.production.json"
  ]) {
    if (!existsSync(join(installed, path))) throw new Error(`installed package is missing ${path}`);
  }
  if (existsSync(join(installed, "src"))) throw new Error("installed package unexpectedly includes TypeScript source");
  scenarios.push("verified-packed-artifact-contents");

  const installedPackage = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const installedBin = join(consumer, "node_modules", ".bin", "atlas-core");
  if (!existsSync(installedBin)) throw new Error("npm did not install the packed atlas-core executable");

  const version = run(installedBin, ["version"], consumer).trim();
  if (version !== `atlas-core ${installedPackage.version}`) {
    throw new Error(`packed atlas-core version was ${version}, expected atlas-core ${installedPackage.version}`);
  }
  const help = run(installedBin, ["help"], consumer);
  for (const command of ["atlas-core init", "atlas-core doctor", "atlas-core update [cli|all]"]) {
    if (!help.includes(command)) throw new Error(`packed atlas-core help is missing ${command}`);
  }
  scenarios.push("executed-installed-help-and-version");

  const validationOutput = runExpectingFailure(installedBin, ["init"], consumer, {
    ATLAS_CORE_HOME: fakeCoreHome,
    DOCKER_CONTEXT: "",
    DOCKER_HOST: "",
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`
  });
  if (!validationOutput.includes("Atlas Core requires a Linux Docker daemon. Detected windows.")) {
    throw new Error(`packed atlas-core did not reject the non-Linux Docker daemon: ${validationOutput.trim()}`);
  }
  if (existsSync(fakeCoreHome))
    throw new Error("packed atlas-core wrote configuration before rejecting the Docker daemon");
  scenarios.push("rejected-non-linux-daemon-before-configuration");

  writeEvidence({
    package: { name: installedPackage.name, version: installedPackage.version },
    result: "passed"
  });
} catch (error) {
  let preservedArtifact;
  if (packedPackagePath && existsSync(packedPackagePath)) {
    preservedArtifact = `${evidencePath}.tgz`;
    mkdirSync(dirname(preservedArtifact), { recursive: true });
    copyFileSync(packedPackagePath, preservedArtifact);
  }
  writeEvidence({
    result: "failed",
    error: error instanceof Error ? error.message : String(error),
    ...(preservedArtifact ? { preservedArtifact } : {})
  });
  throw error;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
