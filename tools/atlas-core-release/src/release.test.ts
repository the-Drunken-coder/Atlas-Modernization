import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AmbiguousWriteError,
  candidateIdentity,
  compareVersions,
  createManifest,
  evaluateWorkflow,
  expectedPlatforms,
  type ObservedPublication,
  type PublicationOperation,
  planPublication,
  type ReleaseManifest,
  reconcilePublication,
  requireUnreservedVersion,
  validateManifest,
  validateNotes,
  validateNpmAttestation,
  validateTagRulesets,
  validateVersion,
  type WorkflowJob,
  type WorkflowRun
} from "./release.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
const shaA = "a".repeat(40);
const shaB = "b".repeat(40);

test("accepts stable SemVer and compares numerically", () => {
  assert.equal(validateVersion("1.20.3"), "1.20.3");
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  for (const value of ["v1.2.3", "1.2", "1.2.3-rc.1", "01.2.3", "1.2.3+build"]) {
    assert.throws(() => validateVersion(value));
  }
  assert.throws(() => requireUnreservedVersion("1.2.3", ["1.2.3"]), /not newer/);
  assert.throws(() => requireUnreservedVersion("1.2.2", ["1.2.3"]), /not newer/);
  assert.doesNotThrow(() => requireUnreservedVersion("1.2.4", ["1.2.3"]));
});

test("requires split creation and immutability tag rules", () => {
  const base = {
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/atlas-core-v*"], exclude: [] } }
  };
  const creation = {
    ...base,
    name: "Atlas Core release tag creation",
    rules: [{ type: "creation" }],
    bypass_actors: [{ actor_id: 42, actor_type: "Integration", bypass_mode: "always" }]
  };
  const immutability = {
    ...base,
    name: "Atlas Core release tag immutability",
    rules: [{ type: "update" }, { type: "deletion" }],
    bypass_actors: []
  };
  assert.doesNotThrow(() => validateTagRulesets(creation, immutability, 42));
  assert.throws(() => validateTagRulesets(creation, immutability, 0), /positive integer/);
  assert.throws(
    () => validateTagRulesets({ ...creation, rules: [{ type: "creation" }, { type: "update" }] }, immutability, 42),
    /must not include update/
  );
  assert.throws(() => validateTagRulesets(creation, immutability, 99), /intended release App/);
  assert.throws(
    () => validateTagRulesets(creation, { ...immutability, bypass_actors: creation.bypass_actors }, 42),
    /must not allow bypass actors/
  );
});

test("CI eligibility binds workflow path, push event, SHA, attempt, and exact jobs", () => {
  const requirement = { path: ".github/workflows/ci.yml", jobs: ["core", "docker"] };
  const exact = run({ id: 10, run_attempt: 2 });
  const forged = run({ id: 11, run_attempt: 99, path: ".github/workflows/lookalike.yml" });
  const wrongEvent = run({ id: 12, run_attempt: 99, event: "workflow_dispatch" });
  const wrongSha = run({ id: 13, run_attempt: 99, head_sha: shaB });
  const jobs = new Map<number, readonly WorkflowJob[]>([
    [10, [job("core"), job("docker")]],
    [11, [job("core"), job("docker")]],
    [12, [job("core"), job("docker")]],
    [13, [job("core"), job("docker")]]
  ]);
  const result = evaluateWorkflow(requirement, shaA, [forged, wrongEvent, wrongSha, exact], jobs);
  assert.equal(result.state, "success");
  if (result.state === "success") assert.equal(result.run.id, 10);
});

test("missing, failed, canceled, skipped, and duplicate CI jobs block reservation", () => {
  const requirement = { path: ".github/workflows/ci.yml", jobs: ["core"] };
  assert.equal(evaluateWorkflow(requirement, shaA, [], new Map()).state, "pending");
  for (const conclusion of ["failure", "cancelled", "skipped"] as const) {
    const result = evaluateWorkflow(requirement, shaA, [run({ conclusion })], new Map([[1, [job("core")]]]));
    assert.equal(result.state, "blocked");
  }
  const missing = evaluateWorkflow(requirement, shaA, [run()], new Map([[1, []]]));
  assert.equal(missing.state, "blocked");
  const duplicate = evaluateWorkflow(requirement, shaA, [run()], new Map([[1, [job("core"), job("core")]]]));
  assert.equal(duplicate.state, "blocked");
  const canceledJob = evaluateWorkflow(requirement, shaA, [run()], new Map([[1, [job("core", "cancelled")]]]));
  assert.equal(canceledJob.state, "blocked");
});

test("release notes are standalone, factual-looking content with no placeholders", () => {
  assert.doesNotThrow(() => validateNotes("# Atlas Core 1.2.3\n\n- Adds a bounded release path.\n"));
  assert.throws(() => validateNotes("# Atlas Core 1.2.3\n\nTODO\n"), /bullet|placeholder/);
  assert.throws(() => validateNotes("# Changelog\n\n- Release.\n"), /version heading/);
});

test("npm provenance binds package bytes, tagged source, workflow, and repository", () => {
  const integrity = `sha512-${Buffer.from("package bytes").toString("base64")}`;
  const statement = {
    subject: [
      {
        name: "pkg:npm/atlas-core@1.2.3",
        digest: { sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex") }
      }
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/the-Drunken-coder/Atlas-Modernization",
            path: ".github/workflows/release-atlas-core.yml",
            ref: "refs/tags/atlas-core-v1.2.3"
          }
        },
        resolvedDependencies: [{ digest: { gitCommit: shaA } }]
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } }
    }
  };
  const bundle = {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } }
      }
    ]
  };
  const expected = {
    version: "1.2.3",
    integrity,
    repository: "the-Drunken-coder/Atlas-Modernization",
    ref: "refs/tags/atlas-core-v1.2.3",
    commit: shaA
  };
  assert.doesNotThrow(() => validateNpmAttestation(bundle, expected));
  assert.throws(
    () => validateNpmAttestation(bundle, { ...expected, repository: "somewhere/else" }),
    /unexpected repository/
  );
});

test("manifest binds exact package, image, notes, and acceptance bytes", () => {
  const fixture = manifestFixture();
  try {
    validateManifest(fixture.manifest, fixture.root);
    const identity = candidateIdentity(fixture.manifest);
    writeFileSync(fixture.packagePath, "tampered");
    assert.throws(() => validateManifest(fixture.manifest, fixture.root), /SHA-256/);
    assert.equal(candidateIdentity(fixture.manifest), identity);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("all acceptance evidence belongs to the exact candidate identity", () => {
  const fixture = manifestFixture();
  try {
    assert.deepEqual(fixture.manifest.image.platforms, [...expectedPlatforms].sort());
    assert.deepEqual(Object.keys(fixture.manifest.acceptance).sort(), [
      "docker-amd64.tgz",
      "docker-arm64.tgz",
      "portable-linux-arm64.json",
      "portable-linux-x64.json",
      "portable-macos-arm64.json",
      "portable-macos-x64.json"
    ]);
    const changed = structuredClone(fixture.manifest);
    changed.package.sha256 = "f".repeat(64);
    assert.notEqual(candidateIdentity(changed), candidateIdentity(fixture.manifest));
    const incomplete = structuredClone(fixture.manifest);
    delete incomplete.acceptance["docker-arm64.tgz"];
    assert.throws(() => validateManifest(incomplete), /evidence set/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("command interface verifies sealed bytes and plans read-only completion", () => {
  const fixture = manifestFixture();
  try {
    const manifestPath = join(fixture.root, "release-manifest.json");
    const observedPath = join(fixture.root, "observed.json");
    writeFileSync(manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
    writeFileSync(
      observedPath,
      `${JSON.stringify({
        sealedManifest: fixture.manifest,
        imageDigest: fixture.manifest.image.digest,
        npmIntegrity: fixture.manifest.package.integrity,
        npmTags: { latest: fixture.manifest.release.version },
        githubRelease: "published",
        highestPublishedVersion: fixture.manifest.release.version
      })}\n`
    );
    assert.equal(runCLI(["verify-bundle", "--manifest", manifestPath, "--root", fixture.root], fixture.root).status, 0);
    const plan = JSON.parse(
      runCLI(["plan-publication", "--manifest", manifestPath, "--observed", observedPath], fixture.root).stdout
    ) as { complete?: unknown; operations?: unknown[] };
    assert.equal(plan.complete, true);
    assert.deepEqual(plan.operations, []);
    writeFileSync(fixture.notesPath, "tampered\n");
    const tampered = runCLI(["verify-bundle", "--manifest", manifestPath, "--root", fixture.root], fixture.root, false);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /SHA-256/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publication reconciliation is idempotent after every external write and lost response", () => {
  const fixture = manifestFixture();
  try {
    const manifest = fixture.manifest;
    let observed: ObservedPublication = { githubRelease: "absent", highestPublishedVersion: "1.2.2" };
    const expected: PublicationOperation[] = [
      "seal-github-release",
      "promote-image",
      "publish-npm",
      "publish-github-release"
    ];
    assert.deepEqual(planPublication(manifest, observed).operations, expected);

    observed = { ...observed, sealedManifest: manifest, githubRelease: "sealed" };
    assert.deepEqual(planPublication(manifest, observed).operations, expected.slice(1));
    observed = { ...observed, imageDigest: manifest.image.digest };
    assert.deepEqual(planPublication(manifest, observed).operations, expected.slice(2));

    // This is the state after npm accepted the package but the publish response was lost.
    observed = { ...observed, npmIntegrity: manifest.package.integrity };
    assert.deepEqual(planPublication(manifest, observed).operations, ["set-npm-tag", "publish-github-release"]);
    observed = { ...observed, npmTags: { latest: manifest.release.version } };
    assert.deepEqual(planPublication(manifest, observed).operations, ["publish-github-release"]);
    observed = { ...observed, githubRelease: "published" };
    assert.deepEqual(planPublication(manifest, observed).operations, []);
    assert.equal(planPublication(manifest, observed).complete, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GitHub, registry, and process adapters converge when successful write responses are lost", async () => {
  const fixture = manifestFixture();
  try {
    const manifest = fixture.manifest;
    const observed: ObservedPublication = { githubRelease: "absent", highestPublishedVersion: "1.2.2" };
    const writes: PublicationOperation[] = [];
    let verifications = 0;
    const write = async (operation: PublicationOperation): Promise<void> => {
      writes.push(operation);
      if (operation === "seal-github-release") {
        observed.sealedManifest = manifest;
        observed.githubRelease = "sealed";
      } else if (operation === "promote-image") {
        observed.imageDigest = manifest.image.digest;
      } else if (operation === "publish-npm") {
        observed.npmIntegrity = manifest.package.integrity;
      } else if (operation === "set-npm-tag") {
        observed.npmTags = { latest: manifest.release.version };
      } else {
        observed.githubRelease = "published";
      }
      throw new AmbiguousWriteError(`${operation} response lost`);
    };
    const result = await reconcilePublication(manifest, {
      inspect: async () => structuredClone(observed),
      github: {
        seal: async () => write("seal-github-release"),
        publish: async () => write("publish-github-release")
      },
      registry: {
        promoteImage: async () => write("promote-image"),
        publishPackage: async () => write("publish-npm"),
        setPackageTag: async () => write("set-npm-tag")
      },
      process: {
        verify: async () => {
          verifications += 1;
        }
      }
    });
    assert.equal(result.complete, true);
    assert.deepEqual(writes, [
      "seal-github-release",
      "promote-image",
      "publish-npm",
      "set-npm-tag",
      "publish-github-release"
    ]);
    assert.equal(verifications, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("registry visibility lag remains a missing operation without replacing existing state", () => {
  const fixture = manifestFixture();
  try {
    const manifest = fixture.manifest;
    const beforeMetadata = planPublication(manifest, {
      sealedManifest: manifest,
      imageDigest: manifest.image.digest,
      githubRelease: "sealed"
    });
    assert.deepEqual(beforeMetadata.operations, ["publish-npm", "publish-github-release"]);
    const beforeAttestation = planPublication(manifest, {
      sealedManifest: manifest,
      imageDigest: manifest.image.digest,
      npmIntegrity: manifest.package.integrity,
      npmTags: { latest: manifest.release.version },
      githubRelease: "sealed"
    });
    assert.deepEqual(beforeAttestation.operations, ["publish-github-release"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("old-version recovery preserves newer npm latest state", () => {
  const fixture = manifestFixture();
  try {
    const plan = planPublication(fixture.manifest, {
      sealedManifest: fixture.manifest,
      githubRelease: "sealed",
      highestPublishedVersion: "9.0.0"
    });
    assert.equal(plan.npmTag, "recovered");
    assert.deepEqual(plan.operations, ["promote-image", "publish-npm", "publish-github-release"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("premature final releases fail closed and GitHub latest state is not owned", () => {
  const fixture = manifestFixture();
  try {
    assert.throws(
      () =>
        planPublication(fixture.manifest, {
          sealedManifest: fixture.manifest,
          githubRelease: "published",
          npmTags: { latest: fixture.manifest.release.version }
        }),
      /published before its image and npm package were complete/
    );
    const completeButNotLatest: ObservedPublication = {
      sealedManifest: fixture.manifest,
      imageDigest: fixture.manifest.image.digest,
      npmIntegrity: fixture.manifest.package.integrity,
      npmTags: { latest: fixture.manifest.release.version },
      githubRelease: "published",
      highestPublishedVersion: fixture.manifest.release.version
    };
    assert.deepEqual(planPublication(fixture.manifest, completeButNotLatest).operations, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("sealed recovery rejects conflicts and missing sealed bytes instead of rebuilding", () => {
  const fixture = manifestFixture();
  try {
    const conflict = structuredClone(fixture.manifest);
    conflict.image.digest = `sha256:${"e".repeat(64)}`;
    assert.throws(
      () => planPublication(fixture.manifest, { sealedManifest: conflict, githubRelease: "sealed" }),
      /sealed GitHub Release bundle conflicts/
    );
    rmSync(fixture.notesPath);
    assert.throws(() => validateManifest(fixture.manifest, fixture.root), /ENOENT/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation after npm reports an accurate partial state and repeated completed recovery is read-only", () => {
  const fixture = manifestFixture();
  try {
    const partial: ObservedPublication = {
      sealedManifest: fixture.manifest,
      imageDigest: fixture.manifest.image.digest,
      npmIntegrity: fixture.manifest.package.integrity,
      npmTags: { latest: fixture.manifest.release.version },
      githubRelease: "sealed"
    };
    assert.deepEqual(planPublication(fixture.manifest, partial).operations, ["publish-github-release"]);
    const complete = { ...partial, githubRelease: "published" as const };
    assert.deepEqual(planPublication(fixture.manifest, complete).operations, []);
    assert.deepEqual(planPublication(fixture.manifest, complete).operations, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source selection remains valid after main advances and matching annotated tags are reusable", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-core-release-git-"));
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  try {
    git(["init", "--bare", remote], root);
    mkdirSync(checkout);
    git(["init", "--initial-branch=main"], checkout);
    git(["config", "user.name", "Release test"], checkout);
    git(["config", "user.email", "release@example.invalid"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    addReleaseContract(checkout);
    writeFileSync(join(checkout, "source.txt"), "candidate\n");
    git(["add", "."], checkout);
    git(["commit", "-m", "candidate"], checkout);
    const candidate = git(["rev-parse", "HEAD"], checkout);
    git(["push", "-u", "origin", "main"], checkout);
    runCLI(["reserve-tag", "--version", "1.2.3", "--source-sha", candidate], checkout);
    writeFileSync(join(checkout, "source.txt"), "main advanced\n");
    git(["commit", "-am", "advance main"], checkout);
    git(["push", "origin", "main"], checkout);
    const result = runCLI(["validate-reservation", "--version", "1.2.3", "--source-sha", candidate], checkout);
    assert.equal(result.stdout.trim(), "already-reserved");
    assert.equal(git(["cat-file", "-t", "refs/tags/atlas-core-v1.2.3"], checkout), "tag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting and lightweight release tags are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-core-release-lightweight-"));
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  try {
    git(["init", "--bare", remote], root);
    mkdirSync(checkout);
    git(["init", "--initial-branch=main"], checkout);
    git(["config", "user.name", "Release test"], checkout);
    git(["config", "user.email", "release@example.invalid"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    addReleaseContract(checkout);
    writeFileSync(join(checkout, "source.txt"), "candidate\n");
    git(["add", "."], checkout);
    git(["commit", "-m", "candidate"], checkout);
    const candidate = git(["rev-parse", "HEAD"], checkout);
    git(["tag", "atlas-core-v1.2.3"], checkout);
    git(["push", "origin", "main", "refs/tags/atlas-core-v1.2.3"], checkout);
    const result = runCLI(["validate-reservation", "--version", "1.2.3", "--source-sha", candidate], checkout, false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lightweight/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested annotated release tags are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-core-release-nested-tag-"));
  try {
    git(["init", "--initial-branch=main"], root);
    git(["config", "user.name", "Release test"], root);
    git(["config", "user.email", "release@example.invalid"], root);
    addReleaseContract(root);
    git(["add", "."], root);
    git(["commit", "-m", "candidate"], root);
    const candidate = git(["rev-parse", "HEAD"], root);
    git(["tag", "--annotate", "inner", candidate, "--message", "inner"], root);
    git(["tag", "--annotate", "atlas-core-v1.2.3", "inner", "--message", "outer"], root);

    const result = runCLI(["validate-release-tag", "--version", "1.2.3", "--source-sha", candidate], root, false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not an annotated tag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package preparation updates both the workspace manifest and lock entry", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-core-package-tree-"));
  const workspace = join(root, "surfaces/core-cli");
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(workspace, "package.json"),
      '{"name":"atlas-core","version":"0.0.0-dev","atlasCoreImage":null}\n'
    );
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify({ packages: { "surfaces/core-cli": { name: "atlas-core", version: "0.0.0-dev" } } })}\n`
    );
    const image = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"d".repeat(64)}`;

    runCLI(["prepare-package", "--root", root, "--version", "1.2.3", "--image", image], root);

    const packageJSON = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as Record<string, unknown>;
    const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    assert.equal(packageJSON.version, "1.2.3");
    assert.equal(packageJSON.atlasCoreImage, image);
    assert.equal(packageLock.packages["surfaces/core-cli"]?.version, "1.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    run_attempt: 1,
    event: "push",
    head_sha: shaA,
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
    html_url: "https://example.invalid/run/1",
    ...overrides
  };
}

function job(name: string, conclusion = "success"): WorkflowJob {
  return { name, status: "completed", conclusion };
}

function manifestFixture(): {
  root: string;
  packagePath: string;
  notesPath: string;
  manifest: ReleaseManifest;
} {
  const root = mkdtempSync(join(tmpdir(), "atlas-core-manifest-"));
  const packagePath = join(root, "atlas-core-1.2.3.tgz");
  const notesPath = join(root, "release-notes.md");
  writeFileSync(packagePath, "package bytes");
  writeFileSync(notesPath, "# Atlas Core 1.2.3\n\n- Release.\n");
  const evidencePaths = [
    "docker-amd64.tgz",
    "docker-arm64.tgz",
    "portable-linux-arm64.json",
    "portable-linux-x64.json",
    "portable-macos-arm64.json",
    "portable-macos-x64.json"
  ].map((name) => join(root, name));
  for (const path of evidencePaths) writeFileSync(path, `evidence:${path}\n`);
  const manifest = createManifest({
    version: "1.2.3",
    repository: "the-Drunken-coder/Atlas-Modernization",
    sourceSha: shaA,
    tagName: "atlas-core-v1.2.3",
    tagObject: shaB,
    imageRepository: "ghcr.io/the-drunken-coder/atlas-core",
    imageDigest: `sha256:${"c".repeat(64)}`,
    platforms: [...expectedPlatforms],
    packagePath,
    notesPath,
    evidencePaths,
    runId: 123,
    runAttempt: 2
  });
  return { root, packagePath, notesPath, manifest };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function addReleaseContract(checkout: string): void {
  const tool = join(checkout, "tools/atlas-core-release");
  const workflows = join(checkout, ".github/workflows");
  mkdirSync(tool, { recursive: true });
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(tool, "release-contract.json"), '{"schemaVersion":1}\n');
  writeFileSync(join(workflows, "release-atlas-core.yml"), "name: Release Atlas Core\n");
}

function runCLI(args: string[], cwd: string, requireSuccess = true) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
  if (requireSuccess) assert.equal(result.status, 0, result.stderr);
  return result;
}
