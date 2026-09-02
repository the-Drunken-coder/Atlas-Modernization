import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const script = join(dirname(fileURLToPath(import.meta.url)), "atlas-core-release.mjs");
const phaseScript = join(dirname(fileURLToPath(import.meta.url)), "select-atlas-core-release-phase.sh");
const releaseFilesScript = join(dirname(fileURLToPath(import.meta.url)), "atlas-core-release-files.sh");
const tagRulesetScript = join(dirname(fileURLToPath(import.meta.url)), "require-atlas-core-tag-rulesets.sh");
const releaseTagScript = join(dirname(fileURLToPath(import.meta.url)), "verify-atlas-core-release-tag.sh");
const pluginsScript = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/plugins.mjs");
const workflow = join(dirname(fileURLToPath(import.meta.url)), "../workflows/release-atlas-core.yml");
const releaseGuide = join(dirname(fileURLToPath(import.meta.url)), "../../docs/atlas-core/RELEASING.md");
const dockerfile = join(dirname(fileURLToPath(import.meta.url)), "../../services/core/docker/Dockerfile");
const coreCLIPackage = join(dirname(fileURLToPath(import.meta.url)), "../../surfaces/core-cli/package.json");

function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function workflowRunScript(stepName) {
  const source = readFileSync(workflow, "utf8");
  const stepStart = source.indexOf(`      - name: ${stepName}\n`);
  assert.ok(stepStart >= 0, `Workflow step not found: ${stepName}`);
  const runMarker = "        run: |\n";
  const scriptStart = source.indexOf(runMarker, stepStart);
  assert.ok(scriptStart >= 0, `Workflow run block not found: ${stepName}`);
  const bodyStart = scriptStart + runMarker.length;
  const nextStep = source.indexOf("\n      - name:", bodyStart);
  const body = source.slice(bodyStart, nextStep >= 0 ? nextStep : source.length);
  return body
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

function runWorkflowStep(stepName, cwd, environment) {
  return spawnSync("bash", ["-c", `set -euo pipefail\n${workflowRunScript(stepName)}`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: "pipe"
  });
}

test("validates Atlas Core versions", () => {
  assert.equal(run(["validate-version", "1.2.3"], process.cwd()).status, 0);
  const invalid = run(["validate-version", "v1.2.3"], process.cwd());
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /without a leading v/);
  assert.notEqual(run(["validate-version", "1.2.3-01"], process.cwd()).status, 0);
  assert.notEqual(run(["validate-version", "1.2.3-beta.1"], process.cwd()).status, 0);
});

test("requires split release-tag creation and immutability rulesets", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-ruleset-"));
  const creationPath = join(directory, "creation.json");
  const immutabilityPath = join(directory, "immutability.json");
  const base = {
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/atlas-core-v*"], exclude: [] } }
  };
  const creation = {
    ...base,
    name: "Atlas Core release tag creation",
    rules: [{ type: "creation" }]
  };
  const immutability = {
    ...base,
    name: "Atlas Core release tag immutability",
    rules: [{ type: "update" }, { type: "deletion" }]
  };
  try {
    writeFileSync(creationPath, JSON.stringify(creation));
    writeFileSync(immutabilityPath, JSON.stringify(immutability));
    assert.equal(run(["validate-tag-rulesets", creationPath, immutabilityPath], directory).status, 0);

    writeFileSync(creationPath, JSON.stringify({ ...creation, rules: [{ type: "creation" }, { type: "update" }] }));
    const mutableCreation = run(["validate-tag-rulesets", creationPath, immutabilityPath], directory);
    assert.notEqual(mutableCreation.status, 0);
    assert.match(mutableCreation.stderr, /creation must not include update/);

    writeFileSync(creationPath, JSON.stringify(creation));
    writeFileSync(immutabilityPath, JSON.stringify({ ...immutability, rules: [...immutability.rules, { type: "creation" }] }));
    const blockedCreation = run(["validate-tag-rulesets", creationPath, immutabilityPath], directory);
    assert.notEqual(blockedCreation.status, 0);
    assert.match(blockedCreation.stderr, /immutability must not include creation/);

    writeFileSync(immutabilityPath, JSON.stringify({ ...immutability, rules: [{ type: "update" }] }));
    const missingDeletion = run(["validate-tag-rulesets", creationPath, immutabilityPath], directory);
    assert.notEqual(missingDeletion.status, 0);
    assert.match(missingDeletion.stderr, /immutability must restrict deletion/);

    writeFileSync(immutabilityPath, JSON.stringify({ ...immutability, enforcement: "evaluate" }));
    const inactive = run(["validate-tag-rulesets", creationPath, immutabilityPath], directory);
    assert.notEqual(inactive.status, 0);
    assert.match(inactive.stderr, /immutability must be an active tag ruleset/);

    writeFileSync(
      immutabilityPath,
      JSON.stringify({ ...immutability, conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } } })
    );
    const wideTarget = run(["validate-tag-rulesets", creationPath, immutabilityPath], directory);
    assert.notEqual(wideTarget.status, 0);
    assert.match(wideTarget.stderr, /immutability must target only refs\/tags\/atlas-core-v\*/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publishes the npm archive as a local filesystem path", () => {
  const source = readFileSync(workflow, "utf8");
  assert.equal(source.match(/npm publish "\.\/release-artifacts\/atlas-core-\$VERSION\.tgz"/g)?.length, 2);
  assert.equal(source.match(/--tag "\$PUBLISH_TAG"/g)?.length, 2);
  assert.match(source, /publish_tag=recovered/);
  assert.match(source, /gh release edit "\$tag" --draft=false --latest=false/);
});

test("installs the npm package before auditing its signatures", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(
    source,
    /npm init --yes --silent >\/dev\/null\n\s+npm install --ignore-scripts "atlas-core@\$VERSION" >\/dev\/null\n\s+npm audit signatures/
  );
  assert.doesNotMatch(source, /npm install[^\n]*--package-lock-only(?:=true)?/);
});

test("does not regenerate the Plugin catalog before release image digests are selected", () => {
  const packageJSON = JSON.parse(readFileSync(coreCLIPackage, "utf8"));
  assert.doesNotMatch(packageJSON.scripts.prebuild, /plugins\.mjs generate-catalog/);
  assert.match(packageJSON.scripts.prebuild, /generate-package-metadata/);
});

test("formats immutable Plugin digests in the generated catalog", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-plugin-catalog-"));
  const packageRoot = join(directory, "package");
  try {
    const releasePlan = spawnSync(process.execPath, [pluginsScript, "release-plan"], {
      encoding: "utf8",
      stdio: "pipe"
    });
    assert.equal(releasePlan.status, 0, releasePlan.stderr);
    const publishedPlugins = JSON.parse(releasePlan.stdout);
    assert.ok(publishedPlugins.length > 0);
    const images = Object.fromEntries(
      publishedPlugins.map((plugin, index) => [
        plugin.plugin_id,
        `${plugin.image_repository}@sha256:${(index + 1).toString(16).padStart(64, "0")}`
      ])
    );
    mkdirSync(join(packageRoot, "src"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ atlasPluginImages: {} })}\n`);
    const result = spawnSync(process.execPath, [pluginsScript, "record-release-images", "--package-root", packageRoot], {
      encoding: "utf8",
      env: { ...process.env, ATLAS_PLUGIN_IMAGES_JSON: JSON.stringify(images) },
      stdio: "pipe"
    });
    assert.equal(result.status, 0, result.stderr);
    const generated = readFileSync(join(packageRoot, "src", "plugin-catalog.generated.ts"), "utf8");
    for (const image of Object.values(images)) {
      const inline = `    image: "${image}",`;
      const expected = inline.length > 120 ? `    image:\n      "${image}",` : inline;
      assert.ok(generated.includes(expected));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not publish a missing npm version from main recovery", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(
    source,
    /if: needs\.changelog\.outputs\.recovery == 'true' && steps\.npm\.outputs\.version_exists != 'true'/
  );
  assert.equal(source.match(/needs\.changelog\.outputs\.recovery != 'true'/g)?.length, 2);
  const guard = source.indexOf("      - name: Require an existing npm version for main recovery");
  assert.ok(guard > 0);
  for (const mutation of [
    "      - name: Sign in to GitHub Container Registry",
    "      - name: Promote the reviewed digest to the version tag",
    "      - name: Create or verify draft GitHub Release"
  ]) {
    assert.ok(guard < source.indexOf(mutation), `${mutation.trim()} must follow the recovery guard`);
  }
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
  assert.match(source, /no-cache-filters: production/);
  assert.match(source, /mode: \$\{\{ steps\.phase\.outputs\.mode \}\}/);
  assert.match(source, /name: Upload isolated changelog\n\s+if: steps\.phase\.outputs\.mode == 'prepare'/);
  assert.match(source, /name: Set up Go\n\s+if: needs\.changelog\.outputs\.mode == 'prepare'/);
  assert.match(source, /name: Install Atlas Core dependencies\n\s+if: needs\.changelog\.outputs\.mode == 'prepare'/);
  assert.equal(source.match(/npm ci --workspace atlas-core --ignore-scripts/g)?.length, 2);
  assert.match(source, /permissions:\n\s+actions: write\n\s+contents: write/);
  assert.match(source, /return_run_details: true/);
  assert.match(source, /actions\/workflows\/release-atlas-core\.yml\/dispatches/);
  assert.doesNotMatch(source, /Require a run from the immutable release tag/);
  assert.equal(source.match(/resolved to \$promoted_digest after promotion/g)?.length, 2);
});

test("lets the coordinator wait without blocking the tag publisher", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(
    source,
    /concurrency:\n\s+group: release-atlas-core-\$\{\{ github\.ref_type == 'tag' && github\.ref_name \|\| 'coordinator' \}\}\n\s+cancel-in-progress: false\n\s+queue: max/
  );
  assert.match(source, /group: release-atlas-core-mutator\n\s+cancel-in-progress: false\n\s+queue: max/);
});

test("reuses the exact release commit after an authorization upload failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-release-retry-"));
  const remote = join(directory, "remote.git");
  const checkout = join(directory, "checkout");
  const output = join(directory, "github-output");
  const changelog = join(checkout, "CHANGELOG.md");
  const version = "1.2.3";
  try {
    git(["init", "--bare", remote], directory);
    mkdirSync(checkout);
    git(["init"], checkout);
    git(["config", "user.name", "Atlas Core release test"], checkout);
    git(["config", "user.email", "atlas-core@example.invalid"], checkout);
    git(["branch", "-M", "main"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    writeFileSync(changelog, "# Changelog\n");
    git(["add", "CHANGELOG.md"], checkout);
    git(["commit", "-m", "feat: add Atlas Core package"], checkout);
    const sourceSha = git(["rev-parse", "HEAD"], checkout);
    git(["push", "--set-upstream", "origin", "main"], checkout);

    const approvedChangelog = "# Changelog\n\n## 1.2.3 - 2026-09-02\n\n- Release.\n";
    writeFileSync(changelog, approvedChangelog);
    git(["add", "CHANGELOG.md"], checkout);
    writeFileSync(output, "");
    const initial = runWorkflowStep("Select release commit state", checkout, {
      GITHUB_OUTPUT: output,
      SOURCE_SHA: sourceSha,
      VERSION: version
    });
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(readFileSync(output, "utf8"), "release_sha=\n");

    git(["commit", "-m", `chore(release): atlas-core v${version}`], checkout);
    const releaseSha = git(["rev-parse", "HEAD"], checkout);
    git(["tag", "--annotate", `atlas-core-v${version}`, "--message", `Atlas Core ${version}`], checkout);
    git(["push", "--atomic", "origin", "HEAD:main", `refs/tags/atlas-core-v${version}`], checkout);

    // The authorization upload fails here. A failed-job rerun starts again from the approved source.
    git(["checkout", "--detach", sourceSha], checkout);
    writeFileSync(changelog, approvedChangelog);
    git(["add", "CHANGELOG.md"], checkout);
    writeFileSync(output, "");
    const retry = runWorkflowStep("Select release commit state", checkout, {
      GITHUB_OUTPUT: output,
      SOURCE_SHA: sourceSha,
      VERSION: version
    });
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, new RegExp(`Reusing exact release commit ${releaseSha}`));
    assert.equal(readFileSync(output, "utf8"), `release_sha=${releaseSha}\n`);
    assert.equal(git(["rev-parse", "HEAD"], checkout), sourceSha);

    writeFileSync(changelog, `${approvedChangelog}\n- Different bytes.\n`);
    git(["add", "CHANGELOG.md"], checkout);
    writeFileSync(output, "");
    const mismatchedRetry = runWorkflowStep("Select release commit state", checkout, {
      GITHUB_OUTPUT: output,
      SOURCE_SHA: sourceSha,
      VERSION: version
    });
    assert.notEqual(mismatchedRetry.status, 0);
    assert.match(mismatchedRetry.stderr, /approved release artifact does not match/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applies the monotonic version gate only before creating a missing tag", () => {
  const source = readFileSync(workflow, "utf8");
  assert.match(
    source,
    /tag="atlas-core-v\$VERSION"\n\s+if ! git rev-parse --verify --quiet "refs\/tags\/\$tag"[^\n]*; then[\s\S]*?validate-next-version "\$current_version" "\$VERSION"[\s\S]*?validate-next-version "\$\{latest_tag#atlas-core-v\}" "\$VERSION"[\s\S]*?\n\s+fi\n\s+bash \.github\/scripts\/select-atlas-core-release-phase\.sh/
  );
});

test("coordinates automatic tag publication after one approval", () => {
  const source = readFileSync(workflow, "utf8");
    assert.match(
      source,
      /run-name: Atlas Core \$\{\{ inputs\.version \}\} from \$\{\{ github\.ref_name \}\} \[coordinator \$\{\{ inputs\.coordinator_run_id \|\| github\.run_id \}\}\/\$\{\{ inputs\.coordinator_run_attempt \|\| github\.run_attempt \}\}\]/
  );
  assert.match(
    source,
    /name: \$\{\{ github\.ref_type == 'tag' && 'release-publish' \|\| 'release' \}\}/
  );
  assert.match(source, /approve-manual-tag-recovery:\n\s+name: Approve manual tag recovery/);
  assert.match(source, /if: github\.ref_type == 'tag' && inputs\.coordinator_run_id == ''/);
  assert.match(source, /name: Summarize release gate/);
  assert.match(source, /Approval permits candidate image publication/);
  assert.doesNotMatch(source, /Approval 2/);
  assert.match(source, /Leave the internal coordinator run ID empty when dispatching from main/);
  assert.match(source, /name: Require protected Atlas Core release tags/);
  assert.equal(source.match(/bash \.github\/scripts\/require-atlas-core-tag-rulesets\.sh/g)?.length, 2);
    assert.match(source, /name: Mint protected release credential/);
  assert.match(source, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(source, /permission-contents: write/);
  assert.doesNotMatch(source, /permission-administration/);
    assert.match(source, /GH_TOKEN: \$\{\{ steps\.release-token\.outputs\.token \}\}/);
    const publishJob = source.slice(source.indexOf("  publish:"), source.indexOf("  commit-release:"));
    const commitJob = source.slice(source.indexOf("  commit-release:"), source.indexOf("  await-publication:"));
    assert.doesNotMatch(publishJob, /ATLAS_CORE_RELEASE_APP_PRIVATE_KEY|actions\/create-github-app-token/);
    assert.match(commitJob, /environment: release-commit/);
    assert.doesNotMatch(commitJob, /npm ci|npm pack|test-atlas-core-package|node \.github|bash \.github/);
    assert.match(commitJob, /git diff --cached --name-only/);
    assert.match(commitJob, /git diff --cached --check/);
    assert.match(commitJob, /cmp "\$artifact_root\/release-artifacts\/release\.diff" "\$actual_release_diff"/);
    assert.match(commitJob, /git ls-files --others --exclude-standard/);
    assert.match(commitJob, /name: Select release commit state/);
    assert.match(
      commitJob,
      /name: Mint protected release credential\n\s+id: release-token\n\s+if: steps\.release-state\.outputs\.release_sha == ''/
    );
    assert.match(
      commitJob,
      /name: Commit and atomically tag release\n\s+id: commit\n\s+if: steps\.release-state\.outputs\.release_sha == ''/
    );
    assert.match(
      commitJob,
      /release_sha: \$\{\{ steps\.release-state\.outputs\.release_sha \|\| steps\.commit\.outputs\.release_sha \}\}/
    );
    assert.equal(commitJob.match(/core\.hooksPath=\/dev\/null/g)?.length, 3);
    assert.match(source, /name: Upload approved publication/);
    assert.match(
      source,
      /atlas-core-publication-authorization-\$\{\{ inputs\.version \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
    );
  const authorizationJob = source.slice(
    source.indexOf("  authorize-tag-publication:"),
    source.indexOf("  approve-manual-tag-recovery:")
  );
  assert.match(authorizationJob, /permissions:\n\s+actions: read\n\s+contents: read/);
  assert.doesNotMatch(authorizationJob, /environment:|actions: write|contents: write|id-token:|packages:/);
  assert.match(source, /name: Verify coordinator authorization/);
  assert.match(
    source,
    /name: Verify coordinator authorization[\s\S]*?COORDINATOR_RUN_ID: \$\{\{ inputs\.coordinator_run_id \}\}\n\s+GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/
  );
  assert.match(source, /run-id: \$\{\{ inputs\.coordinator_run_id \}\}/);
  assert.match(source, /child_run_id: \$child_run_id/);
  assert.match(source, /--arg child_run_id "\$CHILD_RUN_ID"/);
  assert.match(source, /actions\/runs\/\$COORDINATOR_RUN_ID/);
  assert.match(source, /\.head_branch == "main"/);
  assert.match(source, /\.path == "\.github\/workflows\/release-atlas-core\.yml"/);
    assert.match(source, /child_run_id=\$child_run_id/);
    assert.match(source, /coordinator_run_attempt: \$coordinator_run_attempt/);
    assert.match(source, /coordinator_run_attempt: \$coordinator_run_attempt\n\s+}/);
    assert.match(source, /EXPECTED_COORDINATOR_RUN_ATTEMPT: \$\{\{ inputs\.coordinator_run_attempt \}\}/);
    assert.match(source, /release_artifact_id: \$release_artifact_id/);
    assert.match(source, /release_artifact_name: \$release_artifact_name/);
    assert.match(source, /release_artifact_digest: \$release_artifact_digest/);
    assert.match(source, /package_integrity: \$package_integrity/);
    assert.match(
      source,
      /release_artifact_digest: sha256:\$\{\{ steps\.final-artifact\.outputs\.artifact-digest \}\}/
    );
    assert.match(source, /\.status == "in_progress"/);
    assert.equal(source.match(/\.status == "in_progress"/g)?.length, 3);
    assert.match(source, /name: Verify exact coordinator package artifact/);
    assert.match(source, /name: Download coordinator-approved release/);
    assert.match(source, /Downloaded package integrity does not match the coordinator authorization/);
    assert.doesNotMatch(source, /retention-days: 7/);
  assert.doesNotMatch(source, /expected_title=/);
  assert.match(source, /needs: \[changelog, prepare, authorize-tag-publication, approve-manual-tag-recovery\]/);
  assert.equal(source.match(/bash \.github\/scripts\/verify-atlas-core-release-tag\.sh/g)?.length, 2);
    assert.match(source, /name: Await immutable tag publication/);
  assert.match(source, /actions: read\n\s+checks: read\n\s+contents: read/);
    assert.match(
      source,
      /gh run watch "\$CHILD_RUN_ID" --repo "\$GITHUB_REPOSITORY" --exit-status --interval 10/
    );
    assert.doesNotMatch(source, /timeout-minutes: 90/);
    assert.match(source, /name: Stop publication after coordinator failure/);
    assert.match(source, /gh run cancel "\$CHILD_RUN_ID"/);
    assert.match(source, /actions\/runs\/\$CHILD_RUN_ID\/force-cancel/);
    assert.match(
      publishJob,
      /name: Run approved release phase\n\s+if: >-\n\s+!cancelled\(\)/
    );
    assert.match(source, /GHCR, npm, provenance, and the GitHub Release passed final verification/);
  });

test("keeps the tag-ruleset gate shell valid", () => {
  assert.equal(spawnSync("bash", ["-n", tagRulesetScript]).status, 0);
  assert.equal(spawnSync("bash", ["-n", releaseTagScript]).status, 0);
});

test("verifies the remote release tag still peels to the reviewed commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-release-tag-"));
  const remote = join(directory, "remote.git");
  const checkout = join(directory, "checkout");
  try {
    mkdirSync(checkout);
    git(["init", "--bare", remote], directory);
    git(["init"], checkout);
    git(["config", "user.name", "Atlas Core release test"], checkout);
    git(["config", "user.email", "atlas-core@example.invalid"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    writeFileSync(join(checkout, "release.txt"), "reviewed\n");
    git(["add", "release.txt"], checkout);
    git(["commit", "-m", "chore(release): atlas-core v1.2.3"], checkout);
    const releaseSha = git(["rev-parse", "HEAD"], checkout);
    git(["tag", "--annotate", "atlas-core-v1.2.3", "--message", "Atlas Core 1.2.3"], checkout);
    git(["push", "origin", "refs/tags/atlas-core-v1.2.3"], checkout);

    const valid = spawnSync("bash", [releaseTagScript, "1.2.3", releaseSha], {
      cwd: checkout,
      encoding: "utf8",
      stdio: "pipe"
    });
    assert.equal(valid.status, 0, valid.stderr);

    const mismatched = spawnSync("bash", [releaseTagScript, "1.2.3", "f".repeat(40)], {
      cwd: checkout,
      encoding: "utf8",
      stdio: "pipe"
    });
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /not f{40}/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("documents non-bypassable release environments and legacy recovery", () => {
  const source = readFileSync(releaseGuide, "utf8");
  assert.match(source, /Disable administrator bypass for all three environments/i);
  assert.match(source, /`release-commit` environment secret `ATLAS_CORE_RELEASE_APP_PRIVATE_KEY`/);
  assert.match(source, /pre-migration tag whose npm version is missing/i);
  assert.match(source, /temporarily restore the npm trusted\npublisher's environment to `release`/i);
});

test("keeps the release-owned file contract narrow", () => {
  const validate = (paths) =>
    spawnSync(
      "bash",
      ["-c", 'source "$1"; validate_atlas_core_release_paths "Unexpected release change"', "bash", releaseFilesScript],
      { encoding: "utf8", input: `${paths.join("\n")}\n`, stdio: ["pipe", "pipe", "pipe"] }
    );

  const allowed = validate([
    "CHANGELOG.md",
    "package-lock.json",
    "surfaces/core-cli/package.json",
    "surfaces/core-cli/src/package-metadata.ts",
    "surfaces/core-cli/src/plugin-catalog.generated.ts",
    "surfaces/core-cli/assets/plugin-catalog.json",
    "surfaces/core-cli/assets/plugins/building_scan/compose.yml"
  ]);
  assert.equal(allowed.status, 0, allowed.stderr);

  const unexpected = validate(["README.md"]);
  assert.notEqual(unexpected.status, 0);
  assert.match(unexpected.stderr, /Unexpected release change: README\.md/);
});

test("recovers an existing immutable release and validates every release-owned file", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-phase-"));
  const output = join(directory, "github-output");
  const packagePath = join(directory, "surfaces/core-cli/package.json");
  const pluginCatalogPath = join(directory, "surfaces/core-cli/assets/plugin-catalog.json");
  const pluginComposePath = join(directory, "surfaces/core-cli/assets/plugins/building_scan/compose.yml");
  const generatedPluginCatalogPath = join(directory, "surfaces/core-cli/src/plugin-catalog.generated.ts");
  try {
    mkdirSync(join(directory, "surfaces/core-cli/src"), { recursive: true });
    mkdirSync(dirname(pluginComposePath), { recursive: true });
    writeFileSync(join(directory, "CHANGELOG.md"), "# Changelog\n");
    writeFileSync(join(directory, "package-lock.json"), "{}\n");
    writeFileSync(packagePath, '{"version":"0.1.0","atlasCoreImage":null}\n');
    writeFileSync(join(directory, "surfaces/core-cli/src/package-metadata.ts"), "export const image = undefined;\n");
    writeFileSync(pluginCatalogPath, '{"plugins":[]}\n');
    writeFileSync(pluginComposePath, "image: @atlas/plugin-image@\n");
    writeFileSync(generatedPluginCatalogPath, "export const PACKAGE_PLUGIN_CATALOG = [] as const;\n");
    git(["init"], directory);
    git(["config", "user.name", "Atlas Core release test"], directory);
    git(["config", "user.email", "atlas-core@example.invalid"], directory);
    git(["add", "."], directory);
    git(["commit", "-m", "feat: add Atlas Core package"], directory);
    const sourceSha = git(["rev-parse", "HEAD"], directory);

    writeFileSync(packagePath, '{"version":"0.1.0","atlasCoreImage":"ghcr.io/example/core@sha256:abc"}\n');
    writeFileSync(pluginCatalogPath, '{"plugins":[{"plugin_id":"building_scan"}]}\n');
    writeFileSync(pluginComposePath, "image: ghcr.io/example/building-scan@sha256:abc\n");
    writeFileSync(
      generatedPluginCatalogPath,
      'export const PACKAGE_PLUGIN_CATALOG = [{ pluginId: "building_scan" }] as const;\n'
    );
    git(["add", packagePath, pluginCatalogPath, pluginComposePath, generatedPluginCatalogPath], directory);
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

    writeFileSync(pluginComposePath, "image: ghcr.io/example/building-scan@sha256:different\n");
    writeFileSync(output, "");
    const mismatchedPluginRecovery = spawnSync("bash", [phaseScript], {
      cwd: directory,
      encoding: "utf8",
      env: { ...environment, RECOVER_EXISTING_RELEASE: "true" },
      stdio: "pipe"
    });
    assert.notEqual(mismatchedPluginRecovery.status, 0);
    assert.match(mismatchedPluginRecovery.stderr, /does not match/);

    writeFileSync(pluginComposePath, "image: ghcr.io/example/building-scan@sha256:abc\n");
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
    writeFileSync(
      packagePath,
      `${JSON.stringify({ version: "1.2.3", atlasCoreImage: "old-image", atlasPluginImages: { fixture: "old" } })}\n`
    );
    assert.equal(run(["prepare-package", "1.2.4", packagePath], directory).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(packagePath, "utf8")), {
      version: "1.2.3",
      atlasCoreImage: null,
      atlasPluginImages: {}
    });

    writeFileSync(
      packagePath,
      `${JSON.stringify({ version: "1.2.4", atlasCoreImage: "reviewed-image", atlasPluginImages: { fixture: "reviewed" } })}\n`
    );
    assert.equal(run(["prepare-package", "1.2.4", packagePath], directory).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(packagePath, "utf8")), {
      version: "1.2.4",
      atlasCoreImage: "reviewed-image",
      atlasPluginImages: { fixture: "reviewed" }
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
