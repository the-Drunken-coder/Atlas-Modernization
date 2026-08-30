import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const script = join(dirname(fileURLToPath(import.meta.url)), "atlas-core-release.mjs");
const phaseScript = join(dirname(fileURLToPath(import.meta.url)), "select-atlas-core-release-phase.sh");
const workflow = join(dirname(fileURLToPath(import.meta.url)), "../workflows/release-atlas-core.yml");
const dockerfile = join(dirname(fileURLToPath(import.meta.url)), "../../services/core/docker/Dockerfile");

function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("validates Atlas Core versions", () => {
  assert.equal(run(["validate-version", "1.2.3"], process.cwd()).status, 0);
  const invalid = run(["validate-version", "v1.2.3"], process.cwd());
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /without a leading v/);
  assert.notEqual(run(["validate-version", "1.2.3-01"], process.cwd()).status, 0);
  assert.notEqual(run(["validate-version", "1.2.3-beta.1"], process.cwd()).status, 0);
});

test("publishes the npm archive as a local filesystem path", () => {
  const source = readFileSync(workflow, "utf8");
  assert.equal(source.match(/npm publish "\.\/release-artifacts\/atlas-core-\$VERSION\.tgz"/g)?.length, 2);
});

test("installs the npm package before auditing its signatures", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(
    source,
    /npm init --yes --silent >\/dev\/null\n\s+npm install --ignore-scripts "atlas-core@\$VERSION" >\/dev\/null\n\s+npm audit signatures/
  );
  assert.doesNotMatch(source, /npm install[^\n]*--package-lock-only(?:=true)?/);
});

test("does not publish a missing npm version from main recovery", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(
    source,
    /if: needs\.changelog\.outputs\.recovery == 'true' && steps\.npm\.outputs\.version_exists != 'true'/
  );
  assert.equal(source.match(/needs\.changelog\.outputs\.recovery != 'true'/g)?.length, 2);
});

test("cross-compiles release binaries on the native build platform", () => {
  const source = readFileSync(dockerfile, "utf8");
  assert.match(source, /FROM --platform=\$BUILDPLATFORM golang:[^\n]+ AS builder/);
  assert.match(source, /ARG TARGETOS\nARG TARGETARCH/);
  assert.equal(source.match(/GOOS="\$TARGETOS" GOARCH="\$TARGETARCH"/g)?.length, 2);
});

test("uses a cached fast path for immutable-tag publication", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(source, /cache-from: type=gha,scope=atlas-core-release/);
  assert.match(source, /cache-to: type=gha,mode=max,scope=atlas-core-release/);
  assert.match(source, /mode: \$\{\{ steps\.phase\.outputs\.mode \}\}/);
  assert.match(source, /name: Upload isolated changelog\n\s+if: steps\.phase\.outputs\.mode == 'prepare'/);
  assert.match(source, /name: Set up Go\n\s+if: needs\.changelog\.outputs\.mode == 'prepare'/);
  assert.match(source, /name: Install Atlas Core dependencies\n\s+if: needs\.changelog\.outputs\.mode == 'prepare'/);
  assert.equal(source.match(/npm ci --workspace atlas-core --ignore-scripts/g)?.length, 2);
  assert.match(source, /permissions:\n\s+actions: write\n\s+contents: write/);
  assert.match(source, /gh workflow run release-atlas-core\.yml/);
  assert.doesNotMatch(source, /Require a run from the immutable release tag/);
});

test("recovers an existing immutable release only when explicitly requested", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-phase-"));
  const output = join(directory, "github-output");
  const packagePath = join(directory, "surfaces/core-cli/package.json");
  try {
    mkdirSync(join(directory, "surfaces/core-cli/src"), { recursive: true });
    writeFileSync(join(directory, "CHANGELOG.md"), "# Changelog\n");
    writeFileSync(join(directory, "package-lock.json"), "{}\n");
    writeFileSync(packagePath, '{"version":"0.1.0","atlasCoreImage":null}\n');
    writeFileSync(join(directory, "surfaces/core-cli/src/package-metadata.ts"), "export const image = undefined;\n");
    git(["init"], directory);
    git(["config", "user.name", "Atlas Core release test"], directory);
    git(["config", "user.email", "atlas-core@example.invalid"], directory);
    git(["add", "."], directory);
    git(["commit", "-m", "feat: add Atlas Core package"], directory);
    const sourceSha = git(["rev-parse", "HEAD"], directory);

    writeFileSync(packagePath, '{"version":"0.1.0","atlasCoreImage":"ghcr.io/example/core@sha256:abc"}\n');
    git(["add", packagePath], directory);
    git(["commit", "-m", "chore(release): atlas-core v0.1.0"], directory);
    const releaseSha = git(["rev-parse", "HEAD"], directory);
    git(["tag", "--annotate", "atlas-core-v0.1.0", "--message", "Atlas Core 0.1.0"], directory);

    writeFileSync(join(directory, "repair.txt"), "updated workflow\n");
    git(["add", "repair.txt"], directory);
    git(["commit", "-m", "fix(release): repair verification"], directory);
    const mainSha = git(["rev-parse", "HEAD"], directory);
    git(["update-ref", "refs/remotes/origin/main", mainSha], directory);

    const environment = {
      ...process.env,
      GITHUB_OUTPUT: output,
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: mainSha,
      VERSION: "0.1.0"
    };
    writeFileSync(output, "");
    const ordinaryRun = spawnSync("bash", [phaseScript], {
      cwd: directory,
      encoding: "utf8",
      env: { ...environment, RECOVER_EXISTING_RELEASE: "false" },
      stdio: "pipe"
    });
    assert.notEqual(ordinaryRun.status, 0);
    assert.match(ordinaryRun.stderr, /already exists/);

    writeFileSync(output, "");
    const recovery = spawnSync("bash", [phaseScript], {
      cwd: directory,
      encoding: "utf8",
      env: { ...environment, RECOVER_EXISTING_RELEASE: "true" },
      stdio: "pipe"
    });
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(
      readFileSync(output, "utf8"),
      `mode=publish\nrecovery=true\nsource_sha=${sourceSha}\nrelease_sha=${releaseSha}\n`
    );

    writeFileSync(packagePath, '{"version":"0.1.0","atlasCoreImage":"different"}\n');
    writeFileSync(output, "");
    const mismatchedRecovery = spawnSync("bash", [phaseScript], {
      cwd: directory,
      encoding: "utf8",
      env: { ...environment, RECOVER_EXISTING_RELEASE: "true" },
      stdio: "pipe"
    });
    assert.notEqual(mismatchedRecovery.status, 0);
    assert.match(mismatchedRecovery.stderr, /does not match/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a release older than the current package version", () => {
  assert.equal(run(["validate-next-version", "1.2.3", "1.2.3"], process.cwd()).status, 0);
  assert.equal(run(["validate-next-version", "1.2.3", "1.2.4"], process.cwd()).status, 0);
  assert.equal(run(["validate-next-version", "1.9.0", "1.10.0"], process.cwd()).status, 0);

  const older = run(["validate-next-version", "1.2.3", "1.2.2"], process.cwd());
  assert.notEqual(older.status, 0);
  assert.match(older.stderr, /older than the current package version/);
});

test("clears an old image pin only when preparing a new version", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-release-"));
  const packagePath = join(directory, "package.json");
  try {
    writeFileSync(packagePath, `${JSON.stringify({ version: "1.2.3", atlasCoreImage: "old-image" })}\n`);
    assert.equal(run(["prepare-package", "1.2.4", packagePath], directory).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(packagePath, "utf8")), { version: "1.2.3", atlasCoreImage: null });

    writeFileSync(packagePath, `${JSON.stringify({ version: "1.2.4", atlasCoreImage: "reviewed-image" })}\n`);
    assert.equal(run(["prepare-package", "1.2.4", packagePath], directory).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(packagePath, "utf8")), {
      version: "1.2.4",
      atlasCoreImage: "reviewed-image"
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validates npm provenance against the immutable release ref and commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-release-"));
  const bundlePath = join(directory, "attestations.json");
  const commit = "a".repeat(40);
  const digest = "b".repeat(128);
  const integrity = `sha512-${Buffer.from(digest, "hex").toString("base64")}`;
  const statement = {
    subject: [{ name: "pkg:npm/atlas-core@1.2.3", digest: { sha512: digest } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: "refs/tags/atlas-core-v1.2.3",
            repository: "https://github.com/the-Drunken-coder/Atlas-Modernization",
            path: ".github/workflows/release-atlas-core.yml"
          }
        },
        resolvedDependencies: [{ digest: { gitCommit: commit } }]
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } }
    }
  };
  try {
    writeFileSync(
      bundlePath,
      JSON.stringify({
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } }
          }
        ]
      })
    );
    const args = [
      "validate-npm-attestation",
      "1.2.3",
      integrity,
      bundlePath,
      "https://github.com/the-Drunken-coder/Atlas-Modernization",
      ".github/workflows/release-atlas-core.yml",
      "refs/tags/atlas-core-v1.2.3",
      commit
    ];
    assert.equal(run(args, directory).status, 0);

    const wrongCommit = run([...args.slice(0, -1), "c".repeat(40)], directory);
    assert.notEqual(wrongCommit.status, 0);
    assert.match(wrongCommit.stderr, /release commit/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("extracts and validates the newest release section", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-release-"));
  try {
    const previous = "# Changelog\n\nIntro that names ## 1.2.3 - 2026-08-28 inline.\n\n## 1.2.2 - 2026-08-01\n\n- Older.\n";
    const previousPath = join(directory, "previous.md");
    writeFileSync(previousPath, previous);
    writeFileSync(
      join(directory, "CHANGELOG.md"),
      previous.replace(
        "## 1.2.2",
        "## 1.2.3 - 2026-08-28\n\n### Added\n\n- Added `atlas-core start`.\n\n## 1.2.2"
      )
    );
    assert.equal(run(["existing-date", "1.2.3"], directory).stdout, "2026-08-28");
    const notes = join(directory, "notes.md");
    const validation = run(["validate-changelog", "1.2.3", "2026-08-28", notes, previousPath], directory);
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(readFileSync(notes, "utf8"), "### Added\n\n- Added `atlas-core start`.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validates the first release after the changelog introduction", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-release-"));
  try {
    const previousPath = join(directory, "previous.md");
    const notes = join(directory, "notes.md");
    for (const previous of [
      "# Changelog\n\nRelease notes are listed newest first.\n",
      "# Changelog\n\nRelease notes are listed newest first."
    ]) {
      const separator = previous.endsWith("\n") ? "\n" : "\n\n";
      writeFileSync(previousPath, previous);
      writeFileSync(
        join(directory, "CHANGELOG.md"),
        `${previous}${separator}## 0.1.0 - 2026-08-29\n\n- First release.\n`
      );

      const validation = run(["validate-changelog", "0.1.0", "2026-08-29", notes, previousPath], directory);
      assert.equal(validation.status, 0, validation.stderr);
      assert.equal(readFileSync(notes, "utf8"), "- First release.\n");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid or destructive changelog edits", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-release-"));
  const changelog = join(directory, "CHANGELOG.md");
  const notes = join(directory, "notes.md");
  try {
    writeFileSync(changelog, "# Changelog\n\n## 1.2.3 - 2026-08-28\n\nNo bullet.\n");
    assert.notEqual(run(["validate-changelog", "1.2.3", "2026-08-28", notes], directory).status, 0);

    writeFileSync(changelog, "# Changelog\n\n## 1.2.3 - 2026-08-28\n\n- TODO.\n");
    assert.notEqual(run(["validate-changelog", "1.2.3", "2026-08-28", notes], directory).status, 0);

    const previous = "# Changelog\n\n## 1.2.2 - 2026-08-01\n\n- Older.\n";
    const previousPath = join(directory, "previous.md");
    writeFileSync(previousPath, previous);
    writeFileSync(
      changelog,
      "# Changelog\n\n## 1.2.3 - 2026-08-28\n\n- New.\n\n## 1.2.2 - 2026-08-01\n\n- Rewritten.\n"
    );
    const rewritten = run(["validate-changelog", "1.2.3", "2026-08-28", notes, previousPath], directory);
    assert.notEqual(rewritten.status, 0);
    assert.match(rewritten.stderr, /without changing the existing changelog/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
