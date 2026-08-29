import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const script = join(dirname(fileURLToPath(import.meta.url)), "atlas-core-release.mjs");
const workflow = join(dirname(fileURLToPath(import.meta.url)), "../workflows/release-atlas-core.yml");

function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
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
