import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const script = join(dirname(fileURLToPath(import.meta.url)), "atlas-core-release.mjs");

function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

test("validates Atlas Core versions", () => {
  assert.equal(run(["validate-version", "1.2.3"], process.cwd()).status, 0);
  const invalid = run(["validate-version", "v1.2.3"], process.cwd());
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /without a leading v/);
  assert.notEqual(run(["validate-version", "1.2.3-01"], process.cwd()).status, 0);
});

test("rejects a release older than the current package version", () => {
  assert.equal(run(["validate-next-version", "1.2.3", "1.2.3"], process.cwd()).status, 0);
  assert.equal(run(["validate-next-version", "1.2.3-beta.2", "1.2.3"], process.cwd()).status, 0);
  assert.equal(run(["validate-next-version", "1.2.3-beta.2", "1.2.3-beta.10"], process.cwd()).status, 0);

  const older = run(["validate-next-version", "1.2.3", "1.2.2"], process.cwd());
  assert.notEqual(older.status, 0);
  assert.match(older.stderr, /older than the current package version/);

  const olderPrerelease = run(["validate-next-version", "1.2.3", "1.2.3-rc.1"], process.cwd());
  assert.notEqual(olderPrerelease.status, 0);
});

test("extracts and validates the newest release section", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-release-"));
  try {
    writeFileSync(
      join(directory, "CHANGELOG.md"),
      "# Changelog\n\nIntro.\n\n## 1.2.3 - 2026-08-28\n\n### Added\n\n- Added `atlas-core start`.\n\n## 1.2.2 - 2026-08-01\n\n- Older.\n"
    );
    assert.equal(run(["existing-date", "1.2.3"], directory).stdout, "2026-08-28");
    const notes = join(directory, "notes.md");
    const validation = run(["validate-changelog", "1.2.3", "2026-08-28", notes], directory);
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(readFileSync(notes, "utf8"), "### Added\n\n- Added `atlas-core start`.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
