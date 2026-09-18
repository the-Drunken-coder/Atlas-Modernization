import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  type CommandResult,
  type CommandRunner,
  fetchNpmAttestation,
  inspectImage,
  inspectLivePublication as inspectLivePublicationImpl,
  MAX_NPM_ATTESTATION_BYTES,
  reconcileLivePublication as reconcileLivePublicationImpl,
  validateNpmAttestationUrl,
  verifyCompletedLivePublication as verifyCompletedLivePublicationImpl
} from "./publication.js";
import { createManifest, expectedEvidence, type PublicationPlan, type ReleaseManifest } from "./release.js";

const sha = "a".repeat(40);
const imageDigest = `sha256:${"d".repeat(64)}`;
const timings = { deadlineMs: 0, retryMs: 0 };

function reconcileLivePublication(
  manifest: ReleaseManifest,
  root: string,
  runner: ControlledPublicationRunner,
  publicationTimings = timings
) {
  return reconcileLivePublicationImpl(manifest, root, runner, publicationTimings, async () => runner.attestation());
}

function inspectLivePublication(
  manifest: ReleaseManifest,
  root: string,
  runner: ControlledPublicationRunner,
  publicationTimings = timings
) {
  return inspectLivePublicationImpl(manifest, root, runner, publicationTimings, async () => runner.attestation());
}

function verifyCompletedLivePublication(
  manifest: ReleaseManifest,
  root: string,
  runner: ControlledPublicationRunner,
  publicationTimings = timings
) {
  return verifyCompletedLivePublicationImpl(manifest, root, runner, publicationTimings, async () =>
    runner.attestation()
  );
}

test("image inspection distinguishes absence from registry and response failures", () => {
  assert.equal(inspectImage(new ImageRunner("missing"), "registry.test/core:1.2.3"), undefined);
  assert.equal(inspectImage(new ImageRunner("buildx-missing"), "registry.test/core:1.2.3"), undefined);
  assert.throws(() => inspectImage(new ImageRunner("transport"), "registry.test/core:1.2.3"), /transport/);
  assert.throws(() => inspectImage(new ImageRunner("malformed"), "registry.test/core:1.2.3"), /invalid JSON/);
  assert.equal(inspectImage(new ImageRunner("present"), "registry.test/core:1.2.3"), imageDigest);
});

test("npm provenance downloads are restricted to the exact registry endpoint", () => {
  assert.equal(
    validateNpmAttestationUrl("https://registry.npmjs.org/-/npm/v1/attestations/atlas-core@1.2.3", "1.2.3").href,
    "https://registry.npmjs.org/-/npm/v1/attestations/atlas-core@1.2.3"
  );
  for (const value of [
    "https://example.invalid/-/npm/v1/attestations/atlas-core@1.2.3",
    "https://registry.npmjs.org/-/npm/v1/attestations/atlas-core@9.9.9",
    "https://registry.npmjs.org/-/npm/v1/attestations/atlas-core@1.2.3?redirect=https://example.invalid"
  ]) {
    assert.throws(() => validateNpmAttestationUrl(value, "1.2.3"), /unexpected origin or path/);
  }
});

test("npm provenance fetch rejects redirects and oversized responses without retrying", async () => {
  const fixture = publicationFixture();
  const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, "github-create", "after");
  let fetches = 0;
  try {
    runner.clearFailure();
    await assert.rejects(
      reconcileLivePublicationImpl(
        fixture.manifest,
        fixture.root,
        runner,
        { deadlineMs: 1_000, retryMs: 0 },
        async (url) => {
          fetches += 1;
          return await fetchNpmAttestation(url, async (_input, init) => {
            assert.equal(init?.redirect, "manual");
            return new Response(null, {
              status: 302,
              headers: { location: "https://example.invalid/provenance" }
            });
          });
        }
      ),
      /refused an HTTP redirect/
    );
    assert.equal(fetches, 1);

    await assert.rejects(
      fetchNpmAttestation(
        "https://registry.npmjs.org/-/npm/v1/attestations/atlas-core@1.2.3",
        async () =>
          new Response("{}", {
            headers: { "content-length": String(MAX_NPM_ATTESTATION_BYTES + 1) }
          })
      ),
      /exceeds the size limit/
    );

    await assert.rejects(
      fetchNpmAttestation(
        "https://registry.npmjs.org/-/npm/v1/attestations/atlas-core@1.2.3",
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(MAX_NPM_ATTESTATION_BYTES + 1));
                controller.close();
              }
            })
          )
      ),
      /exceeds the size limit/
    );
  } finally {
    fixture.remove();
  }
});

test("npm provenance fetch retries only transient HTTP failures", async () => {
  const fixture = publicationFixture();
  const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, "github-create", "after");
  let fetches = 0;
  try {
    runner.clearFailure();
    await assert.rejects(
      reconcileLivePublicationImpl(
        fixture.manifest,
        fixture.root,
        runner,
        { deadlineMs: 1_000, retryMs: 0 },
        async (url) => {
          fetches += 1;
          return await fetchNpmAttestation(url, async () => new Response(null, { status: 400 }));
        }
      ),
      /npm provenance returned HTTP 400/
    );
    assert.equal(fetches, 1);

    fetches = 0;
    const plan = await reconcileLivePublicationImpl(
      fixture.manifest,
      fixture.root,
      runner,
      { deadlineMs: 1_000, retryMs: 0 },
      async (url) => {
        fetches += 1;
        return await fetchNpmAttestation(url, async () =>
          fetches === 1 ? new Response(null, { status: 408 }) : new Response(JSON.stringify(runner.attestation()))
        );
      }
    );
    assert.equal(fetches, 2);
    assert.equal(plan.complete, true);
  } finally {
    fixture.remove();
  }
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

test("one reconciliation verifies sealed bytes and npm signatures only once", async () => {
  const fixture = publicationFixture();
  try {
    const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, "github-create", "after");
    runner.clearFailure();
    await reconcileLivePublication(fixture.manifest, fixture.root, runner);

    assert.equal(runner.readCounts.get("release-download"), 2);
    assert.equal(runner.readCounts.get("npm-install"), 1);
    assert.equal(runner.readCounts.get("npm-audit"), 1);
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

test("completed verification rejects mutable release metadata and incorrect npm dist-tags", async () => {
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
    runner.npmTags.latest = "1.2.2";
    const plan = await verifyCompletedLivePublication(fixture.manifest, fixture.root, runner, {
      deadlineMs: 0,
      retryMs: 0
    });
    assert.deepEqual(plan.operations, ["set-npm-tag"]);
    assert.equal(plan.complete, false);
  } finally {
    fixture.remove();
  }
});

test("publication rejects checksum tampering and files outside the manifest contract", async () => {
  const checksumFixture = publicationFixture();
  try {
    writeFileSync(join(checksumFixture.root, "SHA256SUMS"), `${"0".repeat(64)}  release-manifest.json\n`);
    const runner = new ControlledPublicationRunner(
      checksumFixture.manifest,
      checksumFixture.root,
      "github-create",
      "after"
    );
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
  "npm-tag",
  "github-final"
] as const) {
  test(`live adapters stop after a failure before ${failure} and recover without replacing state`, async () => {
    const fixture = publicationFixture();
    try {
      const runner = new ControlledPublicationRunner(fixture.manifest, fixture.root, failure, "before");
      await assert.rejects(
        reconcileLivePublication(fixture.manifest, fixture.root, runner, { deadlineMs: 0, retryMs: 0 })
      );
      assert.equal(
        runner.trace.some((entry) => entry === failure),
        true
      );
      assert.equal(
        runner.trace.some((entry) => laterWrite(failure, entry)),
        false
      );
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
      let result: PublicationPlan;
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
  | "npm-tag"
  | "github-final";

class ImageRunner implements CommandRunner {
  constructor(readonly mode: "missing" | "buildx-missing" | "transport" | "malformed" | "present") {}

  run(): CommandResult {
    if (this.mode === "missing") return failure("manifest unknown");
    if (this.mode === "buildx-missing") return failure("ERROR: registry.test/core:1.2.3: not found");
    if (this.mode === "transport") return failure("registry transport connection reset");
    if (this.mode === "malformed") return success("not-json");
    return success(JSON.stringify({ digest: imageDigest }));
  }
}

class ControlledPublicationRunner implements CommandRunner {
  releaseState: "absent" | "draft" | "sealed" | "published" = "absent";
  image: string | undefined = undefined;
  npm: string | undefined = undefined;
  readonly npmTags: { latest?: string; recovered?: string } = {};
  releaseTitle: string | undefined = undefined;
  readonly trace: string[] = [];
  readonly writeCounts = new Map<WriteName, number>();
  readonly readCounts = new Map<string, number>();
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
    if (args[0] === "api" && args.includes("--paginate") && args.at(-1)?.includes("/releases?")) {
      return success(JSON.stringify(this.releaseState === "absent" ? [[]] : [[this.#releaseDocument()]]));
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
      this.#read("release-download");
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
      if (args.some((arg) => arg.startsWith("--latest") && arg !== "--latest=false")) {
        return failure("Core publication must not claim repository-wide latest");
      }
      return this.#write("github-final", () => {
        this.releaseState = "published";
      });
    }
    if (args[0] === "release" && (args[1] === "verify" || args[1] === "verify-asset")) {
      this.#read(args[1]);
      return success();
    }
    if (args[0] === "release" && args[1] === "list") {
      return success(
        JSON.stringify(this.releaseState === "published" ? [{ tagName: this.#manifest.release.tag_name }] : [])
      );
    }
    return failure(`unexpected gh command: ${args.join(" ")}`);
  }

  #releaseResponse(): CommandResult {
    if (this.releaseState === "absent" || this.releaseState === "draft") return failure("HTTP 404: Not Found");
    return success(JSON.stringify(this.#releaseDocument()));
  }

  #releaseDocument(): Record<string, unknown> {
    const notesPath = join(this.#assetRoot, this.#manifest.notes.filename);
    return {
      id: 7,
      tag_name: this.#manifest.release.tag_name,
      draft: this.releaseState === "draft",
      prerelease: this.releaseState === "sealed",
      immutable: this.releaseState === "sealed" || this.releaseState === "published",
      name: this.releaseTitle ?? `Atlas Core ${this.#manifest.release.version}`,
      body: existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "",
      assets: assetNames(this.#assetRoot).map((name) => ({ name }))
    };
  }

  #docker(args: readonly string[]): CommandResult {
    if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect") {
      return this.image ? success(JSON.stringify({ digest: this.image })) : failure("manifest unknown");
    }
    if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "create") {
      if (!args.includes("--prefer-index=false")) return failure("image promotion did not request a carbon copy");
      return this.#write("image", () => {
        this.image = imageDigest;
      });
    }
    if (args.includes("manifest") && args.includes("inspect")) return success();
    return failure(`unexpected docker command: ${args.join(" ")}`);
  }

  #npm(args: readonly string[]): CommandResult {
    if (args[0] === "view" && args[1] === "atlas-core" && args[2] === "dist-tags") {
      return success(JSON.stringify(this.npmTags));
    }
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
    if (args[0] === "dist-tag" && args[1] === "add") {
      return this.#write("npm-tag", () => {
        const tag = args[3];
        if (tag !== "latest" && tag !== "recovered") throw new Error("missing npm dist-tag");
        this.npmTags[tag] = this.#manifest.release.version;
      });
    }
    if (args.includes("install")) {
      this.#read("npm-install");
      return success();
    }
    if (args.includes("audit")) {
      this.#read("npm-audit");
      return success();
    }
    return failure(`unexpected npm command: ${args.join(" ")}`);
  }

  attestation(): unknown {
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
    return bundle;
  }

  #attestationUrl(): string {
    return `https://registry.npmjs.org/-/npm/v1/attestations/atlas-core@${this.#manifest.release.version}`;
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

  #read(name: string): void {
    this.readCounts.set(name, (this.readCounts.get(name) ?? 0) + 1);
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
    .map(
      (name) =>
        `${createHash("sha256")
          .update(readFileSync(join(root, name)))
          .digest("hex")}  ${name}`
    )
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
    "npm-tag",
    "github-final"
  ];
  return order.findIndex((name) => name === candidate) > order.indexOf(failure);
}
