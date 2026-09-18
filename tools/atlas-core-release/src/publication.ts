import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  AmbiguousWriteError,
  compareVersions,
  npmIntegrity,
  objectValue,
  parseReleaseManifest,
  planPublication,
  reconcilePublication,
  stringValue,
  validateManifest,
  validateNpmAttestation,
  type ObservedPublication,
  type PublicationAdapters,
  type PublicationPlan,
  type ReleaseManifest
} from "./release.js";

const DEFAULT_DEADLINE_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_MS = 10_000;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(file: string, args: readonly string[], timeoutMs?: number): CommandResult;
}

export interface PublicationTimings {
  deadlineMs: number;
  retryMs: number;
}

export class ProcessCommandRunner implements CommandRunner {
  run(file: string, args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): CommandResult {
    const result = spawnSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env
    });
    return {
      status: result.status ?? (result.error ? 125 : 124),
      stdout: result.stdout ?? "",
      stderr: result.stderr || result.error?.message || ""
    };
  }
}

export async function reconcileLivePublication(
  manifest: ReleaseManifest,
  bundleRoot: string,
  runner: CommandRunner = new ProcessCommandRunner(),
  timings: PublicationTimings = { deadlineMs: DEFAULT_DEADLINE_MS, retryMs: DEFAULT_RETRY_MS }
): Promise<PublicationPlan> {
  validateManifest(manifest, bundleRoot);
  validateChecksums(manifest, bundleRoot);
  return reconcilePublication(manifest, new LivePublicationAdapters(manifest, bundleRoot, runner, timings));
}

export async function inspectLivePublication(
  manifest: ReleaseManifest,
  bundleRoot: string,
  runner: CommandRunner = new ProcessCommandRunner(),
  timings: PublicationTimings = { deadlineMs: DEFAULT_DEADLINE_MS, retryMs: DEFAULT_RETRY_MS }
): Promise<PublicationPlan> {
  validateManifest(manifest, bundleRoot);
  validateChecksums(manifest, bundleRoot);
  const adapters = new LivePublicationAdapters(manifest, bundleRoot, runner, timings, false);
  return planPublication(manifest, await adapters.inspect());
}

export async function verifyCompletedLivePublication(
  manifest: ReleaseManifest,
  bundleRoot: string,
  runner: CommandRunner = new ProcessCommandRunner(),
  timings: PublicationTimings = { deadlineMs: DEFAULT_DEADLINE_MS, retryMs: DEFAULT_RETRY_MS }
): Promise<PublicationPlan> {
  validateManifest(manifest, bundleRoot);
  validateChecksums(manifest, bundleRoot);
  const adapters = new LivePublicationAdapters(manifest, bundleRoot, runner, timings);
  const plan = planPublication(manifest, await adapters.inspect());
  if (plan.complete) await adapters.process.verify();
  return plan;
}

export class LivePublicationAdapters implements PublicationAdapters {
  readonly #manifest: ReleaseManifest;
  readonly #bundleRoot: string;
  readonly #runner: CommandRunner;
  readonly #timings: PublicationTimings;
  readonly #verifyObservedNpm: boolean;

  constructor(
    manifest: ReleaseManifest,
    bundleRoot: string,
    runner: CommandRunner = new ProcessCommandRunner(),
    timings: PublicationTimings = { deadlineMs: DEFAULT_DEADLINE_MS, retryMs: DEFAULT_RETRY_MS },
    verifyObservedNpm = true
  ) {
    this.#manifest = manifest;
    this.#bundleRoot = bundleRoot;
    this.#runner = runner;
    this.#timings = timings;
    this.#verifyObservedNpm = verifyObservedNpm;
  }

  inspect = async (): Promise<ObservedPublication> => {
    const release = await this.#inspectRelease();
    const imageDigest = await inspectImageWithRetry(
      this.#runner,
      `${this.#manifest.image.repository}:${this.#manifest.release.version}`,
      this.#timings
    );
    const npmIntegrityValue = await this.#inspectNpmIntegrity();
    if (npmIntegrityValue && npmIntegrityValue !== this.#manifest.package.integrity) {
      throw new Error(
        `atlas-core@${this.#manifest.release.version} exists with integrity ${npmIntegrityValue}, not ${this.#manifest.package.integrity}`
      );
    }
    if (this.#verifyObservedNpm && npmIntegrityValue === this.#manifest.package.integrity) await this.#verifyNpm();
    const highestPublishedVersion = await this.#highestPublishedVersion();
    const githubLatest = release.state === "published" ? await this.#isCurrentGitHubLatest() : false;
    const observed: ObservedPublication = {
      githubRelease: release.state,
      githubLatest,
      ...(release.manifest ? { sealedManifest: release.manifest } : {}),
      ...(imageDigest ? { imageDigest } : {}),
      ...(npmIntegrityValue ? { npmIntegrity: npmIntegrityValue } : {}),
      ...(highestPublishedVersion ? { highestPublishedVersion } : {})
    };
    return observed;
  };

  github = {
    seal: async (): Promise<void> => this.#seal(),
    publish: async (_manifest: ReleaseManifest, latest: boolean): Promise<void> => this.#publish(latest)
  };

  registry = {
    promoteImage: async (): Promise<void> => this.#promoteImage(),
    publishPackage: async (_manifest: ReleaseManifest, tag: "latest" | "recovered"): Promise<void> =>
      this.#publishPackage(tag)
  };

  process = {
    verify: async (): Promise<void> => this.#verify()
  };

  async #inspectRelease(): Promise<{
    state: "absent" | "draft" | "sealed" | "published";
    manifest?: ReleaseManifest;
  }> {
    const response = this.#runner.run("gh", [
      "api",
      `repos/${this.#manifest.release.repository}/releases/tags/${this.#manifest.release.tag_name}`
    ]);
    if (response.status !== 0) {
      if (isGitHubNotFound(response)) return { state: "absent" };
      throw commandError("inspect GitHub Release", response);
    }
    const release = objectValue(parseJson(response.stdout, "GitHub Release"), "GitHub Release");
    const draft = booleanValue(release.draft, "GitHub Release draft state");
    if (draft) return { state: "draft" };
    if (release.immutable !== true) {
      throw new Error(`${this.#manifest.release.tag_name} is published but is not immutable`);
    }
    const expectedTitle = `Atlas Core ${this.#manifest.release.version}`;
    if (stringValue(release.name, "GitHub Release title") !== expectedTitle) {
      throw new Error(`GitHub Release title does not match ${expectedTitle}`);
    }
    const expectedNotes = readFileSync(join(this.#bundleRoot, this.#manifest.notes.filename), "utf8");
    if (normalizeText(stringValue(release.body, "GitHub Release notes")) !== normalizeText(expectedNotes)) {
      throw new Error("GitHub Release notes do not match the immutable release-notes asset");
    }
    const prerelease = booleanValue(release.prerelease, "GitHub Release prerelease state");
    const manifest = this.#downloadAndVerifyRelease();
    await this.#verifyReleaseAttestation();
    return { state: prerelease ? "sealed" : "published", manifest };
  }

  async #seal(): Promise<void> {
    this.#requireImmutableReleases();
    const current = this.#runner.run("gh", [
      "api",
      `repos/${this.#manifest.release.repository}/releases/tags/${this.#manifest.release.tag_name}`
    ]);
    if (current.status === 0) {
      const release = objectValue(parseJson(current.stdout, "GitHub Release"), "GitHub Release");
      if (release.draft !== true) {
        throw new AmbiguousWriteError("The GitHub Release may already have been sealed");
      }
      const id = integerValue(release.id, "GitHub Release ID");
      requireSuccess(
        "delete unsealed draft GitHub Release",
        this.#runner.run("gh", ["api", "--method", "DELETE", `repos/${this.#manifest.release.repository}/releases/${id}`])
      );
      this.#createDraft();
      this.#uploadBundle();
    } else if (isGitHubNotFound(current)) {
      this.#createDraft();
      this.#uploadBundle();
    } else {
      throw commandError("inspect draft GitHub Release", current);
    }
    this.#assertReleaseBytesMatch();
    const publish = this.#runner.run("gh", [
      "release",
      "edit",
      this.#manifest.release.tag_name,
      "--draft=false",
      "--prerelease",
      "--latest=false",
      "--repo",
      this.#manifest.release.repository
    ]);
    if (publish.status !== 0) throw new AmbiguousWriteError(commandError("seal GitHub Release", publish).message);
    const sealed = await waitForValue(
      () => this.#inspectRelease(),
      (release) => release.state === "sealed",
      this.#timings,
      "immutable GitHub Release seal",
      (release) => release.state === "published"
    );
    if (sealed.state !== "sealed") throw new Error("GitHub Release did not become an immutable sealed prerelease");
  }

  #createDraft(): void {
    const result = this.#runner.run("gh", [
      "release",
      "create",
      this.#manifest.release.tag_name,
      "--draft",
      "--verify-tag",
      "--title",
      `Atlas Core ${this.#manifest.release.version}`,
      "--notes-file",
      join(this.#bundleRoot, this.#manifest.notes.filename),
      "--repo",
      this.#manifest.release.repository
    ]);
    if (result.status !== 0) throw new AmbiguousWriteError(commandError("create draft GitHub Release", result).message);
  }

  #uploadBundle(): void {
    const names = this.#bundleNames();
    const ordered = [...names.filter((name) => name !== "release-manifest.json"), "release-manifest.json"];
    for (const name of ordered) {
      const result = this.#runner.run(
        "gh",
        [
          "release",
          "upload",
          this.#manifest.release.tag_name,
          join(this.#bundleRoot, name),
          "--repo",
          this.#manifest.release.repository
        ],
        COMMAND_TIMEOUT_MS
      );
      if (result.status !== 0) {
        throw new AmbiguousWriteError(commandError(`upload GitHub Release asset ${name}`, result).message);
      }
    }
  }

  #assertReleaseBytesMatch(): void {
    const root = mkdtempSync(join(tmpdir(), "atlas-core-release-download-"));
    try {
      requireSuccess(
        "download GitHub Release bundle",
        this.#runner.run(
          "gh",
          [
            "release",
            "download",
            this.#manifest.release.tag_name,
            "--dir",
            root,
            "--repo",
            this.#manifest.release.repository
          ],
          5 * 60 * 1000
        )
      );
      assertSameBundle(this.#bundleRoot, root);
      const manifest = parseReleaseManifest(parseJsonFile(join(root, "release-manifest.json")));
      validateManifest(manifest, root);
      validateChecksums(manifest, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  #downloadAndVerifyRelease(): ReleaseManifest {
    const root = mkdtempSync(join(tmpdir(), "atlas-core-sealed-release-"));
    try {
      requireSuccess(
        "download immutable GitHub Release bundle",
        this.#runner.run(
          "gh",
          [
            "release",
            "download",
            this.#manifest.release.tag_name,
            "--dir",
            root,
            "--repo",
            this.#manifest.release.repository
          ],
          5 * 60 * 1000
        )
      );
      const manifest = parseReleaseManifest(parseJsonFile(join(root, "release-manifest.json")));
      validateManifest(manifest, root);
      validateChecksums(manifest, root);
      assertSameBundle(this.#bundleRoot, root);
      return manifest;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  async #verifyReleaseAttestation(): Promise<void> {
    await retryCommand(
      () =>
        this.#runner.run("gh", [
          "release",
          "verify",
          this.#manifest.release.tag_name,
          "--repo",
          this.#manifest.release.repository
        ]),
      this.#timings,
      "verify immutable GitHub Release attestation",
      /digest mismatch|verification failed|invalid attestation/iu
    );
    for (const name of this.#bundleNames()) {
      await retryCommand(
        () =>
          this.#runner.run("gh", [
            "release",
            "verify-asset",
            this.#manifest.release.tag_name,
            join(this.#bundleRoot, name),
            "--repo",
            this.#manifest.release.repository
          ]),
        this.#timings,
        `verify immutable GitHub Release asset ${name}`,
        /digest mismatch|verification failed|invalid attestation/iu
      );
    }
  }

  #requireImmutableReleases(): void {
    const response = this.#runner.run("gh", [
      "api",
      `repos/${this.#manifest.release.repository}/immutable-releases`
    ]);
    requireSuccess("inspect GitHub immutable releases setting", response);
    const setting = objectValue(parseJson(response.stdout, "GitHub immutable releases setting"), "immutable releases");
    if (setting.enabled !== true) throw new Error("GitHub immutable releases must be enabled before publication");
  }

  async #promoteImage(): Promise<void> {
    const source = `${this.#manifest.image.repository}@${this.#manifest.image.digest}`;
    const target = `${this.#manifest.image.repository}:${this.#manifest.release.version}`;
    await promoteExactImage(this.#runner, source, target, this.#manifest.image.digest, this.#timings);
  }

  async #inspectNpmIntegrity(): Promise<string | undefined> {
    return retryInspection(
      () => {
        const result = this.#runner.run("npm", [
          "view",
          `atlas-core@${this.#manifest.release.version}`,
          "dist.integrity"
        ]);
        if (result.status === 0) return result.stdout.trim() || undefined;
        if (/E404|404 Not Found|No match found/iu.test(result.stderr)) return undefined;
        throw commandError("inspect npm package", result);
      },
      this.#timings,
      "npm package inspection"
    );
  }

  async #publishPackage(tag: "latest" | "recovered"): Promise<void> {
    if (process.env.NODE_AUTH_TOKEN) throw new Error("Atlas Core publication does not support an npm token fallback");
    const result = this.#runner.run(
      "npm",
      [
        "publish",
        join(this.#bundleRoot, this.#manifest.package.filename),
        "--access",
        "public",
        "--provenance",
        "--tag",
        tag
      ],
      this.#timings.deadlineMs
    );
    if (result.status !== 0) throw new AmbiguousWriteError(commandError("publish npm package", result).message);
    const integrity = await waitForValue(
      () => this.#inspectNpmIntegrity(),
      (value) => value === this.#manifest.package.integrity,
      this.#timings,
      `npm package atlas-core@${this.#manifest.release.version}`,
      (value) => value !== undefined && value !== this.#manifest.package.integrity
    );
    if (integrity !== this.#manifest.package.integrity) throw new Error("npm package integrity did not converge");
  }

  async #highestPublishedVersion(): Promise<string | undefined> {
    const npm = await retryInspection(
      () => {
        const result = this.#runner.run("npm", ["view", "atlas-core", "versions", "--json"]);
        requireSuccess("inspect npm version history", result);
        return result.stdout;
      },
      this.#timings,
      "npm version history"
    );
    const npmValue = parseJson(npm, "npm version history");
    const npmVersions = typeof npmValue === "string" ? [npmValue] : stringArray(npmValue, "npm version history");
    const github = await retryInspection(
      () => {
        const result = this.#runner.run("gh", [
          "release",
          "list",
          "--exclude-drafts",
          "--exclude-pre-releases",
          "--limit",
          "100",
          "--json",
          "tagName",
          "--repo",
          this.#manifest.release.repository
        ]);
        requireSuccess("inspect GitHub Release history", result);
        return result.stdout;
      },
      this.#timings,
      "GitHub Release history"
    );
    const githubVersions = arrayValue(parseJson(github, "GitHub Release history"), "GitHub Release history")
      .map((value, index) => objectValue(value, `GitHub Release ${index}`))
      .map((release) => stringValue(release.tagName, "GitHub Release tag"))
      .filter((tag) => /^atlas-core-v\d+\.\d+\.\d+$/u.test(tag))
      .map((tag) => tag.slice("atlas-core-v".length));
    return [...npmVersions, ...githubVersions]
      .filter((version) => /^\d+\.\d+\.\d+$/u.test(version))
      .sort(compareVersions)
      .at(-1);
  }

  async #isCurrentGitHubLatest(): Promise<boolean> {
    return retryInspection(
      () => {
        const result = this.#runner.run("gh", [
          "api",
          `repos/${this.#manifest.release.repository}/releases/latest`
        ]);
        if (isGitHubNotFound(result)) return false;
        requireSuccess("inspect latest GitHub Release", result);
        const release = objectValue(parseJson(result.stdout, "latest GitHub Release"), "latest GitHub Release");
        return stringValue(release.tag_name, "latest GitHub Release tag") === this.#manifest.release.tag_name;
      },
      this.#timings,
      "latest GitHub Release inspection"
    );
  }

  async #publish(latest: boolean): Promise<void> {
    const result = this.#runner.run("gh", [
      "release",
      "edit",
      this.#manifest.release.tag_name,
      "--prerelease=false",
      latest ? "--latest" : "--latest=false",
      "--repo",
      this.#manifest.release.repository
    ]);
    if (result.status !== 0) throw new AmbiguousWriteError(commandError("publish final GitHub Release", result).message);
    await waitForValue(
      () => this.#inspectRelease(),
      (release) => release.state === "published",
      this.#timings,
      "final GitHub Release publication"
    );
  }

  async #verify(): Promise<void> {
    const release = await this.#inspectRelease();
    if (release.state !== "published") throw new Error("GitHub Release is not in its final published state");
    const highestPublishedVersion = await this.#highestPublishedVersion();
    const shouldBeLatest =
      !highestPublishedVersion || compareVersions(this.#manifest.release.version, highestPublishedVersion) >= 0;
    if ((await this.#isCurrentGitHubLatest()) !== shouldBeLatest) {
      throw new Error("GitHub latest release does not match the version ordering policy");
    }
    const imageDigest = await inspectImageWithRetry(
      this.#runner,
      `${this.#manifest.image.repository}:${this.#manifest.release.version}`,
      this.#timings
    );
    if (imageDigest !== this.#manifest.image.digest) throw new Error("Published image digest does not match manifest");
    const anonymousDockerConfig = mkdtempSync(join(tmpdir(), "atlas-core-anonymous-docker-"));
    try {
      await waitForValue(
        () => {
          const result = this.#runner.run("docker", [
            "--config",
            anonymousDockerConfig,
            "manifest",
            "inspect",
            `${this.#manifest.image.repository}@${this.#manifest.image.digest}`
          ]);
          return result.status === 0 ? true : undefined;
        },
        (visible) => visible === true,
        this.#timings,
        "anonymous image visibility"
      );
    } finally {
      rmSync(anonymousDockerConfig, { recursive: true, force: true });
    }
    await this.#verifyNpm();
  }

  async #verifyNpm(): Promise<void> {
    const integrity = await waitForValue(
      () => this.#inspectNpmIntegrity(),
      (value) => value === this.#manifest.package.integrity,
      this.#timings,
      `npm integrity for ${this.#manifest.release.version}`,
      (value) => value !== undefined && value !== this.#manifest.package.integrity
    );
    if (integrity !== this.#manifest.package.integrity) throw new Error("npm integrity does not match manifest");
    const attestationUrl = await waitForValue(
      () => {
        const result = this.#runner.run("npm", [
          "view",
          `atlas-core@${this.#manifest.release.version}`,
          "dist.attestations.url"
        ]);
        return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
      },
      (value) => typeof value === "string" && value.length > 0,
      this.#timings,
      "npm provenance URL"
    );
    if (!attestationUrl) throw new Error("npm provenance URL did not become visible");
    const attestation = await waitForValue(
      async () => {
        const response = await fetch(attestationUrl, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`npm provenance returned HTTP ${response.status}`);
        const value: unknown = await response.json();
        return value;
      },
      (value) => value !== undefined,
      this.#timings,
      "npm provenance document"
    );
    validateNpmAttestation(attestation, {
      version: this.#manifest.release.version,
      integrity: this.#manifest.package.integrity,
      repository: this.#manifest.release.repository,
      ref: `refs/tags/${this.#manifest.release.tag_name}`,
      commit: this.#manifest.release.source_sha
    });
    const consumer = mkdtempSync(join(tmpdir(), "atlas-core-signature-audit-"));
    try {
      writeFileSync(join(consumer, "package.json"), '{"name":"atlas-core-signature-audit","private":true}\n');
      // npm must run in the isolated consumer, so use --prefix rather than changing global process state.
      await retryCommand(
        () =>
          this.#runner.run("npm", [
            "--prefix",
            consumer,
            "install",
            "--ignore-scripts",
            `atlas-core@${this.#manifest.release.version}`
          ]),
        this.#timings,
        "install exact Atlas Core package for signature audit"
      );
      await retryCommand(
        () => this.#runner.run("npm", ["--prefix", consumer, "audit", "signatures"]),
        this.#timings,
        "audit npm signatures",
        /invalid|mismatch|integrity|signature verification failed|provenance[^\n]*(?:invalid|failed)/iu
      );
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  }

  #bundleNames(): string[] {
    return readdirSync(this.#bundleRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }
}

export function inspectImage(runner: CommandRunner, reference: string): string | undefined {
  const result = runner.run("docker", [
    "buildx",
    "imagetools",
    "inspect",
    reference,
    "--format",
    "{{json .Manifest}}"
  ]);
  if (result.status === 0) {
    const manifest = objectValue(parseJson(result.stdout, `image manifest ${reference}`), `image manifest ${reference}`);
    const digest = stringValue(manifest.digest, `image manifest digest for ${reference}`);
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new Error(`Image ${reference} returned an invalid digest`);
    return digest;
  }
  if (/manifest unknown|no such manifest|MANIFEST_UNKNOWN|unexpected status[^\n]*404 Not Found/iu.test(result.stderr)) {
    return undefined;
  }
  throw commandError(`inspect image ${reference}`, result);
}

export async function promoteExactImage(
  runner: CommandRunner,
  source: string,
  target: string,
  expectedDigest: string,
  timings: PublicationTimings = { deadlineMs: DEFAULT_DEADLINE_MS, retryMs: DEFAULT_RETRY_MS }
): Promise<void> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedDigest)) throw new Error(`Invalid expected image digest: ${expectedDigest}`);
  const existing = await inspectImageWithRetry(runner, target, timings);
  if (existing && existing !== expectedDigest) throw new Error(`${target} already resolves to conflicting digest ${existing}`);
  if (existing === expectedDigest) return;
  const result = runner.run("docker", ["buildx", "imagetools", "create", "--tag", target, source], timings.deadlineMs);
  if (result.status !== 0) throw new AmbiguousWriteError(commandError("promote image", result).message);
  const actual = await waitForValue(
    () => inspectImage(runner, target),
    (value) => value === expectedDigest,
    timings,
    `image ${target}`,
    (value) => value !== undefined && value !== expectedDigest
  );
  if (actual !== expectedDigest) throw new Error(`${target} did not converge to the candidate digest`);
}

async function inspectImageWithRetry(
  runner: CommandRunner,
  reference: string,
  timings: PublicationTimings
): Promise<string | undefined> {
  return retryInspection(() => inspectImage(runner, reference), timings, `image inspection for ${reference}`);
}

async function retryInspection<T>(
  inspect: () => T,
  timings: PublicationTimings,
  label: string
): Promise<T> {
  const deadline = Date.now() + timings.deadlineMs;
  let lastError: unknown;
  for (;;) {
    try {
      return inspect();
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await delay(timings.retryMs);
    }
  }
  throw new Error(`${label} did not converge: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function retryCommand(
  run: () => CommandResult,
  timings: PublicationTimings,
  label: string,
  permanentFailure?: RegExp
): Promise<void> {
  const deadline = Date.now() + timings.deadlineMs;
  for (;;) {
    const result = run();
    if (result.status === 0) return;
    if (permanentFailure?.test(`${result.stderr}\n${result.stdout}`)) throw commandError(label, result);
    if (Date.now() >= deadline) throw commandError(`${label} did not converge`, result);
    await delay(timings.retryMs);
  }
}

async function waitForValue<T>(
  read: () => T | Promise<T>,
  accepted: (value: T) => boolean,
  timings: PublicationTimings,
  label: string,
  conflicts: (value: T) => boolean = () => false
): Promise<T> {
  const deadline = Date.now() + timings.deadlineMs;
  let lastValue: T | undefined;
  let lastError: unknown;
  for (;;) {
    try {
      lastValue = await read();
      if (conflicts(lastValue)) throw new Error(`${label} returned conflicting state`);
      if (accepted(lastValue)) return lastValue;
    } catch (error) {
      if (error instanceof Error && error.message === `${label} returned conflicting state`) throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new Error(`${label} did not converge before its deadline${detail}`);
    }
    await delay(timings.retryMs);
  }
}

function assertSameBundle(expectedRoot: string, actualRoot: string): void {
  const expected = fileNames(expectedRoot);
  const actual = fileNames(actualRoot);
  if (expected.join("\n") !== actual.join("\n")) throw new Error("GitHub Release asset set does not match candidate bundle");
  for (const name of expected) {
    if (npmIntegrity(join(expectedRoot, name)) !== npmIntegrity(join(actualRoot, name))) {
      throw new Error(`GitHub Release asset ${name} does not match the approved candidate`);
    }
  }
}

function validateChecksums(manifest: ReleaseManifest, root: string): void {
  const checksumPath = join(root, "SHA256SUMS");
  const lines = readFileSync(checksumPath, "utf8").split("\n").filter(Boolean);
  const allowedNames = [
    manifest.package.filename,
    manifest.notes.filename,
    ...Object.keys(manifest.acceptance),
    "release-manifest.json"
  ].sort();
  const actualNames = fileNames(root).filter((name) => name !== "SHA256SUMS");
  if (actualNames.join("\n") !== allowedNames.join("\n")) {
    throw new Error("Release bundle contains files outside the manifest contract");
  }
  const recorded = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) [ *]([^/]+)$/u);
    if (!match?.[1] || !match[2] || basename(match[2]) !== match[2]) {
      throw new Error(`SHA256SUMS contains an invalid entry: ${line}`);
    }
    if (recorded.has(match[2])) throw new Error(`SHA256SUMS contains duplicate entry ${match[2]}`);
    recorded.set(match[2], match[1]);
  }
  if ([...recorded.keys()].sort().join("\n") !== allowedNames.join("\n")) {
    throw new Error("SHA256SUMS does not describe the exact release bundle");
  }
  for (const [name, expected] of recorded) {
    const actual = createHash("sha256").update(readFileSync(join(root, name))).digest("hex");
    if (actual !== expected) throw new Error(`SHA256SUMS mismatch for ${name}`);
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/gu, "\n").trimEnd();
}

function fileNames(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => basename(entry.name))
    .sort();
}

function parseJsonFile(path: string): unknown {
  return parseJson(readFileSync(path, "utf8"), basename(path));
}

function parseJson(value: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return Number(value);
}

function requireSuccess(label: string, result: CommandResult): void {
  if (result.status !== 0) throw commandError(label, result);
}

function commandError(label: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
  return new Error(`${label} failed: ${detail}`);
}

function isGitHubNotFound(result: CommandResult): boolean {
  return result.status !== 0 && /HTTP 404|release not found|Not Found/iu.test(`${result.stderr}\n${result.stdout}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
