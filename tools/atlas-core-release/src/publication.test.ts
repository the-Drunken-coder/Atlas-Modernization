import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  inspectImage,
  inspectLivePublication,
  reconcileLivePublication,
  verifyCompletedLivePublication,
  type CommandResult,
  type CommandRunner
} from "./publication.js";
import { createManifest, expectedEvidence, type ReleaseManifest } from "./release.js";

const sha = "a".repeat(40);
const imageDigest = `sha256:${"d".repeat(64)}`;

test("image inspection distinguishes absence from registry and response failures", () => {
  assert.equal(inspectImage(new ImageRunner("missing"), "registry.test/core:1.2.3"), undefined);
  assert.throws(() => inspectImage(new ImageRunner("transport"), "registry.test/core:1.2.3"), /transport/);
  assert.throws(() => inspectImage(new ImageRunner("malformed"), "registry.test/core:1.2.3"), /invalid JSON/);
  assert.equal(inspectImage(new ImageRunner("present"), "registry.test/core:1.2.3"), imageDigest);
});

test("completed live recovery performs verification without external writes", async () => {
  const fixture = publicationFixture();
  try {
    const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, "github-create", "after");
    runner.clearFailure();
    await reconcileLivePublication(fixture.manifest, fixture.root, runner, { deadlineMs: 0, retryMs: 0 });
    const writes = [...runner.trace];
    const result = await reconcileLivePublication(fixture.manifest, fixture.root, runner, {
      deadlineMs: 0,
      retryMs: 0
    });
    assert.equal(result.complete, true);
    assert.deepEqual(runner.trace, writes);
  } finally {
    fixture.remove();
  }
});

test("read-only inspection rejects a final release published before registry state", async () => {
  const fixture = publicationFixture();
  try {
    const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, "github-create", "after");
    runner.clearFailure();
    await reconcileLivePublication(fixture.manifest, fixture.root, runner, { deadlineMs: 0, retryMs: 0 });
    runner.image = undefined;
    const writes = [...runner.trace];
    await assert.rejects(
      inspectLivePublication(fixture.manifest, fixture.root, runner, { deadlineMs: 0, retryMs: 0 }),
      /published before its image and npm package were complete/
    );
    assert.deepEqual(runner.trace, writes);
  } finally {
    fixture.remove();
  }
});

test("completed status verification performs every read without external writes", async () => {
  const fixture = publicationFixture();
  try {
    const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, "github-create", "after");
    runner.clearFailure();
    await reconcileLivePublication(fixture.manifest, fixture.root, runner, { deadlineMs: 0, retryMs: 0 });
    const writes = [...runner.trace];
    const result = await verifyCompletedLivePublication(fixture.manifest, fixture.root, runner, {
      deadlineMs: 0,
      retryMs: 0
    });
    assert.equal(result.complete, true);
    assert.deepEqual(runner.trace, writes);
  } finally {
    fixture.remove();
  }
});

test("completed verification rejects mutable release metadata and incorrect latest disposition", async () => {
  const fixture = publicationFixture();
  try {
    const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, "github-create", "after");
    runner.clearFailure();
    await reconcileLivePublication(fixture.manifest, fixture.root, runner, { deadlineMs: 0, retryMs: 0 });
    runner.releaseTitle = "tampered title";
    await assert.rejects(
      verifyCompletedLivePublication(fixture.manifest, fixture.root, runner, { deadlineMs: 0, retryMs: 0 }),
      /title does not match/
    );
    runner.releaseTitle = undefined;
    runner.isLatest = false;
    const plan = await verifyCompletedLivePublication(fixture.manifest, fixture.root, runner, {
      deadlineMs: 0,
      retryMs: 0
    });
    assert.deepEqual(plan.operations, ["publish-github-release"]);
    assert.equal(plan.complete, false);
  } finally {
    fixture.remove();
  }
});

test("publication rejects checksum tampering and files outside the manifest contract", async () => {
  const checksumFixture = publicationFixture();
  try {
    writeFileSync(join(checksumFixture.root, "SHA256SUMS"), `${"0".repeat(64)}  release-manifest.json\n`);
    const runner = new ControlledPublicationRunner(checksumFixture.manifest, checksumFixture.root, "github-create", "after");
    await assert.rejects(
      reconcileLivePublication(checksumFixture.manifest, checksumFixture.root, runner, { deadlineMs: 0, retryMs: 0 }),
      /does not describe the exact release bundle/
    );
  } finally {
    checksumFixture.remove();
  }

  const extraFixture = publicationFixture();
  try {
    writeFileSync(join(extraFixture.root, "unexpected.txt"), "not part of this candidate\n");
    writeChecksums(extraFixture.root);
    const runner = new ControlledPublicationRunner(extraFixture.manifest, extraFixture.root, "github-create", "after");
    await assert.rejects(
      reconcileLivePublication(extraFixture.manifest, extraFixture.root, runner, { deadlineMs: 0, retryMs: 0 }),
      /outside the manifest contract/
    );
  } finally {
    extraFixture.remove();
  }
});

for (const failure of [
  "github-delete",
  "github-create",
  "github-asset",
  "github-seal",
  "image",
  "npm",
  "github-final"
] as const) {
  test(`live adapters stop after a failure before ${failure} and recover without replacing state`, async () => {
    const fixture = publicationFixture();
    try {
      const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, failure, "before");
      await assert.rejects(
        reconcileLivePublication(fixture.manifest, fixture.root, runner, { deadlineMs: 0, retryMs: 0 })
      );
      assert.equal(runner.trace.some((entry) => entry === failure), true);
      assert.equal(runner.trace.some((entry) => laterWrite(failure, entry)), false);
      runner.clearFailure();
      const recovered = await reconcileLivePublication(fixture.manifest, fixture.root, runner, {
        deadlineMs: 0,
        retryMs: 0
      });
      assert.equal(recovered.complete, true);
      assert.equal(runner.releaseState, "published");
      assert.equal(runner.image, imageDigest);
      assert.equal(runner.npm, fixture.manifest.package.integrity);
    } finally {
      fixture.remove();
    }
  });

  test(`live adapters reconcile a lost response after ${failure}`, async () => {
    const fixture = publicationFixture();
    try {
      const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, failure, "after");
      let result;
      try {
        result = await reconcileLivePublication(fixture.manifest, fixture.root, runner, {
          deadlineMs: 0,
          retryMs: 0
        });
      } catch {
        // A response lost before the draft is immutable requires a fresh approved recovery.
        runner.clearFailure();
        result = await reconcileLivePublication(fixture.manifest, fixture.root, runner, {
          deadlineMs: 0,
          retryMs: 0
        });
      }
      assert.equal(result.complete, true);
      if (failure !== "github-create" && failure !== "github-asset") {
        assert.equal(runner.writeCounts.get(failure), 1);
      }
      assert.equal(runner.releaseState, "published");
      assert.equal(runner.image, imageDigest);
      assert.equal(runner.npm, fixture.manifest.package.integrity);
    } finally {
      fixture.remove();
    }
  });
}

type WriteName =
  | "github-delete"
  | "github-create"
  | "github-asset"
  | "github-seal"
  | "image"
  | "npm"
  | "github-final";

class ImageRunner implements CommandRunner {
  constructor(readonly mode: "missing" | "transport" | "malformed" | "present") {}

  run(): CommandResult {
    if (this.mode === "missing") return failure("manifest unknown");
    if (this.mode === "transport") return failure("registry transport connection reset");
    if (this.mode === "malformed") return success("not-json");
    return success(JSON.stringify({ digest: imageDigest }));
  }
}

class ControlledPublicationRunner implements CommandRunner {
  releaseState: "absent" | "draft" | "sealed" | "published" = "absent";
  image: string | undefined = undefined;
  npm: string | undefined = undefined;
  isLatest = false;
  releaseTitle: string | undefined = undefined;
  readonly trace: string[] = [];
  readonly writeCounts = new Map<WriteName, number>();
  readonly #manifest: ReleaseManifest;
  readonly #assetRoot: string;
  #failure: WriteName | undefined;
  readonly #failureTiming: "before" | "after";

  constructor(
    manifest: ReleaseManifest,
    fixtureRoot: string,
    failureName: WriteName,
    failureTiming: "before" | "after"
  ) {
    this.#manifest = manifest;
    this.#assetRoot = join(fixtureRoot, "remote-assets");
    mkdirSync(this.#assetRoot);
    this.#failure = failureName;
    this.#failureTiming = failureTiming;
    if (failureName === "github-delete") this.releaseState = "draft";
  }

  clearFailure(): void {
    this.#failure = undefined;
  }

  run(file: string, args: readonly string[]): CommandResult {
    if (file === "gh") return this.#gh(args);
    if (file === "docker") return this.#docker(args);
    if (file === "npm") return this.#npm(args);
    return failure(`unexpected executable ${file}`);
  }

  #gh(args: readonly string[]): CommandResult {
    if (args[0] === "api" && args.at(-1)?.endsWith("/immutable-releases")) {
      return success(JSON.stringify({ enabled: true }));
    }
    if (args[0] === "api" && args.includes("--method") && args.includes("DELETE")) {
      return this.#write("github-delete", () => {
        this.releaseState = "absent";
        rmSync(this.#assetRoot, { recursive: true, force: true });
        mkdirSync(this.#assetRoot);
      });
    }
    if (args[0] === "api" && args.at(-1)?.endsWith("/releases/latest")) {
      return this.isLatest ? success(JSON.stringify({ tag_name: this.#manifest.release.tag_name })) : failure("HTTP 404");
    }
    if (args[0] === "api" && args.at(-1)?.includes("/releases/tags/")) return this.#releaseResponse();
    if (args[0] === "release" && args[1] === "create") {
      return this.#write("github-create", () => {
        this.releaseState = "draft";
      });
    }
    if (args[0] === "release" && args[1] === "upload") {
      return this.#write("github-asset", () => {
        const source = args[3];
        if (!source) throw new Error("missing upload source");
        cpSync(source, join(this.#assetRoot, basename(source)));
      });
    }
    if (args[0] === "release" && args[1] === "download") {
      const directory = option(args, "--dir");
      mkdirSync(directory, { recursive: true });
      for (const name of assetNames(this.#assetRoot)) cpSync(join(this.#assetRoot, name), join(directory, name));
      return success();
    }
    if (args[0] === "release" && args[1] === "edit" && args.includes("--draft=false")) {
      return this.#write("github-seal", () => {
        this.releaseState = "sealed";
      });
    }
    if (args[0] === "release" && args[1] === "edit" && args.includes("--prerelease=false")) {
      return this.#write("github-final", () => {
        this.releaseState = "published";
        this.isLatest = args.includes("--latest");
      });
    }
    if (args[0] === "release" && (args[1] === "verify" || args[1] === "verify-asset")) return success();
    if (args[0] === "release" && args[1] === "list") {
      return success(
        JSON.stringify(this.releaseState === "published" ? [{ tagName: this.#manifest.release.tag_name }] : [])
      );
    }
    return failure(`unexpected gh command: ${args.join(" ")}`);
  }

  #releaseResponse(): CommandResult {
    if (this.releaseState === "absent") return failure("HTTP 404: Not Found");
    const notesPath = join(this.#assetRoot, this.#manifest.notes.filename);
    return success(
      JSON.stringify({
        id: 7,
        draft: this.releaseState === "draft",
        prerelease: this.releaseState === "sealed",
        immutable: this.releaseState === "sealed" || this.releaseState === "published",
        name: this.releaseTitle ?? `Atlas Core ${this.#manifest.release.version}`,
        body: existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "",
        assets: assetNames(this.#assetRoot).map((name) => ({ name }))
      })
    );
  }

  #docker(args: readonly string[]): CommandResult {
    if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect") {
      return this.image ? success(JSON.stringify({ digest: this.image })) : failure("manifest unknown");
    }
    if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "create") {
      return this.#write("image", () => {
        this.image = imageDigest;
      });
    }
    if (args.includes("manifest") && args.includes("inspect")) return success();
    return failure(`unexpected docker command: ${args.join(" ")}`);
  }

  #npm(args: readonly string[]): CommandResult {
    if (args[0] === "view" && args[1] === "atlas-core" && args[2] === "versions") {
      return success(JSON.stringify(this.npm ? [this.#manifest.release.version] : []));
    }
    if (args[0] === "view" && args[2] === "dist.integrity") {
      return this.npm ? success(this.npm) : failure("npm error E404 No match found");
    }
    if (args[0] === "view" && args[2] === "dist.attestations.url") return success(this.#attestationUrl());
    if (args[0] === "publish") {
      return this.#write("npm", () => {
        this.npm = this.#manifest.package.integrity;
      });
    }
    if (args.includes("init") || args.includes("install") || args.includes("audit")) return success();
    return failure(`unexpected npm command: ${args.join(" ")}`);
  }

  #attestationUrl(): string {
    const statement = {
      subject: [
        {
          name: `pkg:npm/atlas-core@${this.#manifest.release.version}`,
          digest: {
            sha512: Buffer.from(this.#manifest.package.integrity.slice("sha512-".length), "base64").toString("hex")
          }
        }
      ],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: `https://github.com/${this.#manifest.release.repository}`,
              path: ".github/workflows/release-atlas-core.yml",
              ref: `refs/tags/${this.#manifest.release.tag_name}`
            }
          },
          resolvedDependencies: [{ digest: { gitCommit: this.#manifest.release.source_sha } }]
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
    return `data:application/json,${encodeURIComponent(JSON.stringify(bundle))}`;
  }

  #write(name: WriteName, mutate: () => void): CommandResult {
    this.trace.push(name);
    this.writeCounts.set(name, (this.writeCounts.get(name) ?? 0) + 1);
    const fail = this.#failure === name;
    if (fail && this.#failureTiming === "before") return failure(`${name} failed before write`);
    mutate();
    if (fail) {
      this.#failure = undefined;
      return failure(`${name} response lost after write`);
    }
    return success();
  }
}

function publicationFixture(): { root: string; manifest: ReleaseManifest; remove(): void } {
  const root = mkdtempSync(join(tmpdir(), "atlas-core-live-publication-"));
  const packagePath = join(root, "atlas-core-1.2.3.tgz");
  const notesPath = join(root, "release-notes.md");
  writeFileSync(packagePath, "package bytes");
  writeFileSync(notesPath, "# Atlas Core 1.2.3\n\n- Exercises controlled publication adapters.\n");
  const evidencePaths = expectedEvidence.map((name) => {
    const path = join(root, name);
    writeFileSync(path, `evidence ${name}`);
    return path;
  });
  const manifest = createManifest({
    version: "1.2.3",
    repository: "the-Drunken-coder/Atlas-Modernization",
    sourceSha: sha,
    tagName: "atlas-core-v1.2.3",
    tagObject: "b".repeat(40),
    imageRepository: "ghcr.io/the-drunken-coder/atlas-core",
    imageDigest,
    platforms: ["linux/amd64", "linux/arm64"],
    packagePath,
    notesPath,
    evidencePaths,
    runId: 1,
    runAttempt: 1
  });
  writeFileSync(join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeChecksums(root);
  return { root, manifest, remove: () => rmSync(root, { recursive: true, force: true }) };
}

function writeChecksums(root: string): void {
  const lines = assetNames(root)
    .map((name) => `${createHash("sha256").update(readFileSync(join(root, name))).digest("hex")}  ${name}`)
    .join("\n");
  writeFileSync(join(root, "SHA256SUMS"), `${lines}\n`);
}

function assetNames(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value) throw new Error(`missing ${name}`);
  return value;
}

function success(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function failure(stderr: string): CommandResult {
  return { status: 1, stdout: "", stderr };
}

function laterWrite(failure: WriteName, candidate: string): boolean {
  const order: WriteName[] = [
    "github-delete",
    "github-create",
    "github-asset",
    "github-seal",
    "image",
    "npm",
    "github-final"
  ];
  return order.findIndex((name) => name === candidate) > order.indexOf(failure);
}
