import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

export const releaseWorkflow = ".github/workflows/release-atlas-core.yml";
export const expectedPlatforms = ["linux/amd64", "linux/arm64"] as const;
export const expectedEvidence = [
  "docker-amd64.tgz",
  "docker-arm64.tgz",
  "portable-linux-arm64.json",
  "portable-linux-x64.json",
  "portable-macos-arm64.json",
  "portable-macos-x64.json"
] as const;

export interface RequiredWorkflow {
  path: string;
  jobs: readonly string[];
}

export const requiredWorkflows: readonly RequiredWorkflow[] = [
  {
    path: ".github/workflows/ci.yml",
    jobs: [
      "workflow-validation",
      "go-quality",
      "atlas-protocol",
      "atlas-sdk",
      "atlas-core-package (linux/amd64)",
      "atlas-core-package (linux/arm64)",
      "docker-build"
    ]
  },
  { path: ".github/workflows/integration.yml", jobs: ["integration", "production-persistence"] },
  { path: ".github/workflows/core-live-transactions.yml", jobs: ["core-live-transactions"] },
  { path: ".github/workflows/core-storage-recovery.yml", jobs: ["core-storage-recovery"] },
  { path: ".github/workflows/core-migration-restore.yml", jobs: ["core-migration-restore"] }
] as const;

export interface WorkflowRun {
  id: number;
  run_attempt: number;
  event: string;
  head_sha: string;
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string | null;
}

export type Eligibility =
  | { state: "success"; run: WorkflowRun; jobs: readonly WorkflowJob[] }
  | { state: "pending"; reason: string }
  | { state: "blocked"; reason: string };

export interface ReleaseManifest {
  schema_version: 1;
  release: {
    version: string;
    repository: string;
    source_sha: string;
    tag_name: string;
    tag_object: string;
  };
  image: {
    repository: string;
    digest: string;
    platforms: string[];
  };
  package: {
    filename: string;
    sha256: string;
    integrity: string;
  };
  notes: {
    filename: string;
    sha256: string;
  };
  acceptance: Record<string, string>;
  preparation: {
    run_id: number;
    run_attempt: number;
  };
}

export interface ManifestInput {
  version: string;
  repository: string;
  sourceSha: string;
  tagName: string;
  tagObject: string;
  imageRepository: string;
  imageDigest: string;
  platforms: string[];
  packagePath: string;
  notesPath: string;
  evidencePaths: string[];
  runId: number;
  runAttempt: number;
}

export interface ObservedPublication {
  sealedManifest?: ReleaseManifest;
  imageDigest?: string;
  npmIntegrity?: string;
  npmTags?: { latest?: string; recovered?: string };
  githubRelease?: "absent" | "draft" | "sealed" | "published";
  highestPublishedVersion?: string;
}

export interface RulesetBypassActor {
  actor_id?: number;
  actor_type?: string;
  bypass_mode?: string;
}

export interface Ruleset {
  name?: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: Array<{ type?: string }>;
  bypass_actors?: RulesetBypassActor[];
}

export type PublicationOperation =
  | "seal-github-release"
  | "promote-image"
  | "publish-npm"
  | "set-npm-tag"
  | "publish-github-release";

export interface PublicationPlan {
  operations: PublicationOperation[];
  npmTag: "latest" | "recovered";
  complete: boolean;
}

export function validateVersion(value: string): string {
  if (!SEMVER.test(value)) {
    throw new Error(`Atlas Core release version must be stable SemVer without a leading v: ${value}`);
  }
  return value;
}

export function versionFromTag(tag: string): string {
  if (!tag.startsWith("atlas-core-v")) throw new Error(`Invalid Atlas Core release tag: ${tag}`);
  return validateVersion(tag.slice("atlas-core-v".length));
}

export function compareVersions(left: string, right: string): number {
  const leftParts = validateVersion(left).split(".").map(Number);
  const rightParts = validateVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function requireUnreservedVersion(requested: string, reserved: readonly string[]): void {
  validateVersion(requested);
  const highest = [...reserved].sort(compareVersions).at(-1);
  if (highest && compareVersions(requested, highest) <= 0) {
    throw new Error(`Atlas Core ${requested} is not newer than reserved version ${highest}`);
  }
}

export function evaluateWorkflow(
  requirement: RequiredWorkflow,
  sourceSha: string,
  runs: readonly WorkflowRun[],
  jobsByRun: ReadonlyMap<number, readonly WorkflowJob[]>
): Eligibility {
  assertSha(sourceSha, "source SHA");
  const run = runs
    .filter(
      (candidate) =>
        candidate.path === requirement.path && candidate.event === "push" && candidate.head_sha === sourceSha
    )
    .sort((left, right) => right.run_attempt - left.run_attempt || right.id - left.id)[0];
  if (!run) return { state: "pending", reason: `${requirement.path} has no exact push run for ${sourceSha}` };
  if (run.status !== "completed")
    return { state: "pending", reason: `${requirement.path} run ${run.id} is ${run.status}` };
  if (run.conclusion !== "success") {
    return {
      state: "blocked",
      reason: `${requirement.path} run ${run.id} concluded ${run.conclusion ?? "without a result"}`
    };
  }
  const jobs = jobsByRun.get(run.id) ?? [];
  for (const name of requirement.jobs) {
    const matching = jobs.filter((job) => job.name === name);
    if (matching.length !== 1) {
      return {
        state: "blocked",
        reason: `${requirement.path} run ${run.id} has ${matching.length} jobs named ${name}; expected exactly one`
      };
    }
    const [job] = matching;
    if (job?.status !== "completed" || job.conclusion !== "success") {
      return {
        state: "blocked",
        reason: `${requirement.path} job ${name} concluded ${job?.conclusion ?? job?.status ?? "missing"}`
      };
    }
  }
  return { state: "success", run, jobs };
}

export function validateNotes(contents: string, expectedVersion?: string): void {
  const trimmed = contents.trim();
  if (!trimmed) throw new Error("Release notes are empty");
  const heading = trimmed.split(/\r?\n/u, 1)[0];
  if (!heading || !/^# Atlas Core \d+\.\d+\.\d+$/u.test(heading)) {
    throw new Error("Release notes must start with an Atlas Core version heading");
  }
  if (expectedVersion && heading !== `# Atlas Core ${validateVersion(expectedVersion)}`) {
    throw new Error(`Release notes heading does not identify Atlas Core ${expectedVersion}`);
  }
  if (!/^[-*] /mu.test(trimmed)) throw new Error("Release notes must contain at least one bullet");
  if (/\b(?:TBD|TODO|FIXME|coming soon)\b|<[^>]+>/iu.test(trimmed)) {
    throw new Error("Release notes contain a placeholder");
  }
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function npmIntegrity(path: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

export function createManifest(input: ManifestInput): ReleaseManifest {
  validateVersion(input.version);
  assertSha(input.sourceSha, "source SHA");
  assertSha(input.tagObject, "tag object");
  if (input.tagName !== `atlas-core-v${input.version}`) throw new Error("Tag and release version do not match");
  if (!DIGEST.test(input.imageDigest)) throw new Error(`Invalid image digest: ${input.imageDigest}`);
  const platforms = [...new Set(input.platforms)].sort();
  if (platforms.join(",") !== [...expectedPlatforms].sort().join(",")) {
    throw new Error(`Release image platforms must be exactly ${expectedPlatforms.join(", ")}`);
  }
  if (!Number.isSafeInteger(input.runId) || input.runId < 1) throw new Error("Invalid preparation run ID");
  if (!Number.isSafeInteger(input.runAttempt) || input.runAttempt < 1) throw new Error("Invalid preparation attempt");
  validateNotes(readFileSync(input.notesPath, "utf8"), input.version);
  const acceptance = Object.fromEntries(
    [...input.evidencePaths]
      .sort((left, right) => basename(left).localeCompare(basename(right)))
      .map((path) => [basename(path), sha256File(path)])
  );
  if (Object.keys(acceptance).length !== input.evidencePaths.length) {
    throw new Error("Acceptance evidence filenames must be unique");
  }
  if (Object.keys(acceptance).sort().join(",") !== [...expectedEvidence].sort().join(",")) {
    throw new Error(`Acceptance evidence must be exactly ${expectedEvidence.join(", ")}`);
  }
  return {
    schema_version: 1,
    release: {
      version: input.version,
      repository: input.repository,
      source_sha: input.sourceSha,
      tag_name: input.tagName,
      tag_object: input.tagObject
    },
    image: { repository: input.imageRepository, digest: input.imageDigest, platforms },
    package: {
      filename: basename(input.packagePath),
      sha256: sha256File(input.packagePath),
      integrity: npmIntegrity(input.packagePath)
    },
    notes: { filename: basename(input.notesPath), sha256: sha256File(input.notesPath) },
    acceptance,
    preparation: { run_id: input.runId, run_attempt: input.runAttempt }
  };
}

export function validateManifest(manifest: ReleaseManifest, bundleRoot?: string): void {
  if (manifest.schema_version !== 1) throw new Error(`Unsupported release manifest schema ${manifest.schema_version}`);
  validateVersion(manifest.release.version);
  assertSha(manifest.release.source_sha, "manifest source SHA");
  assertSha(manifest.release.tag_object, "manifest tag object");
  if (manifest.release.tag_name !== `atlas-core-v${manifest.release.version}`) {
    throw new Error("Manifest tag and version do not match");
  }
  if (manifest.image.repository !== "ghcr.io/the-drunken-coder/atlas-core") {
    throw new Error("Manifest image repository is invalid");
  }
  if (!DIGEST.test(manifest.image.digest)) throw new Error("Manifest image digest is invalid");
  if ([...manifest.image.platforms].sort().join(",") !== [...expectedPlatforms].sort().join(",")) {
    throw new Error("Manifest image platform set is invalid");
  }
  if (manifest.package.filename !== `atlas-core-${manifest.release.version}.tgz`) {
    throw new Error("Manifest package filename is invalid");
  }
  if (manifest.notes.filename !== "release-notes.md") throw new Error("Manifest notes filename is invalid");
  if (!SHA256.test(manifest.package.sha256) || !INTEGRITY.test(manifest.package.integrity)) {
    throw new Error("Manifest package hashes are invalid");
  }
  if (!SHA256.test(manifest.notes.sha256)) throw new Error("Manifest notes hash is invalid");
  for (const [name, digest] of Object.entries(manifest.acceptance)) {
    assertSafeFilename(name);
    if (!SHA256.test(digest)) throw new Error(`Manifest evidence hash is invalid: ${name}`);
  }
  if (Object.keys(manifest.acceptance).sort().join(",") !== [...expectedEvidence].sort().join(",")) {
    throw new Error("Manifest acceptance evidence set is invalid");
  }
  if (!Number.isSafeInteger(manifest.preparation.run_id) || manifest.preparation.run_id < 1) {
    throw new Error("Manifest preparation run ID is invalid");
  }
  if (!Number.isSafeInteger(manifest.preparation.run_attempt) || manifest.preparation.run_attempt < 1) {
    throw new Error("Manifest preparation attempt is invalid");
  }
  assertSafeFilename(manifest.package.filename);
  assertSafeFilename(manifest.notes.filename);
  if (!bundleRoot) return;
  assertFileHash(join(bundleRoot, manifest.package.filename), manifest.package.sha256);
  if (npmIntegrity(join(bundleRoot, manifest.package.filename)) !== manifest.package.integrity) {
    throw new Error(`npm integrity mismatch for ${manifest.package.filename}`);
  }
  assertFileHash(join(bundleRoot, manifest.notes.filename), manifest.notes.sha256);
  for (const [name, digest] of Object.entries(manifest.acceptance)) assertFileHash(join(bundleRoot, name), digest);
}

export function parseManifestInput(value: unknown): ManifestInput {
  const input = objectValue(value, "manifest input");
  return {
    version: stringValue(input.version, "manifest input version"),
    repository: stringValue(input.repository, "manifest input repository"),
    sourceSha: stringValue(input.sourceSha, "manifest input source SHA"),
    tagName: stringValue(input.tagName, "manifest input tag name"),
    tagObject: stringValue(input.tagObject, "manifest input tag object"),
    imageRepository: stringValue(input.imageRepository, "manifest input image repository"),
    imageDigest: stringValue(input.imageDigest, "manifest input image digest"),
    platforms: stringArray(input.platforms, "manifest input platforms"),
    packagePath: stringValue(input.packagePath, "manifest input package path"),
    notesPath: stringValue(input.notesPath, "manifest input notes path"),
    evidencePaths: stringArray(input.evidencePaths, "manifest input evidence paths"),
    runId: integerValue(input.runId, "manifest input run ID"),
    runAttempt: integerValue(input.runAttempt, "manifest input run attempt")
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const manifest = objectValue(value, "release manifest");
  const release = objectValue(manifest.release, "release manifest identity");
  const image = objectValue(manifest.image, "release manifest image");
  const packageArtifact = objectValue(manifest.package, "release manifest package");
  const notes = objectValue(manifest.notes, "release manifest notes");
  const preparation = objectValue(manifest.preparation, "release manifest preparation");
  const acceptanceValue = objectValue(manifest.acceptance, "release manifest acceptance evidence");
  const acceptance: Record<string, string> = {};
  for (const [name, digest] of Object.entries(acceptanceValue)) {
    acceptance[name] = stringValue(digest, `release manifest evidence ${name}`);
  }
  if (manifest.schema_version !== 1) throw new Error("Release manifest schema must be 1");
  const parsed: ReleaseManifest = {
    schema_version: 1,
    release: {
      version: stringValue(release.version, "release manifest version"),
      repository: stringValue(release.repository, "release manifest repository"),
      source_sha: stringValue(release.source_sha, "release manifest source SHA"),
      tag_name: stringValue(release.tag_name, "release manifest tag name"),
      tag_object: stringValue(release.tag_object, "release manifest tag object")
    },
    image: {
      repository: stringValue(image.repository, "release manifest image repository"),
      digest: stringValue(image.digest, "release manifest image digest"),
      platforms: stringArray(image.platforms, "release manifest image platforms")
    },
    package: {
      filename: stringValue(packageArtifact.filename, "release manifest package filename"),
      sha256: stringValue(packageArtifact.sha256, "release manifest package SHA-256"),
      integrity: stringValue(packageArtifact.integrity, "release manifest package integrity")
    },
    notes: {
      filename: stringValue(notes.filename, "release manifest notes filename"),
      sha256: stringValue(notes.sha256, "release manifest notes SHA-256")
    },
    acceptance,
    preparation: {
      run_id: integerValue(preparation.run_id, "release manifest preparation run ID"),
      run_attempt: integerValue(preparation.run_attempt, "release manifest preparation attempt")
    }
  };
  validateManifest(parsed);
  return parsed;
}

export function parseObservedPublication(value: unknown): ObservedPublication {
  const observed = objectValue(value, "observed publication");
  const result: ObservedPublication = {};
  if (observed.sealedManifest !== undefined) result.sealedManifest = parseReleaseManifest(observed.sealedManifest);
  if (observed.imageDigest !== undefined)
    result.imageDigest = stringValue(observed.imageDigest, "observed image digest");
  if (observed.npmIntegrity !== undefined) {
    result.npmIntegrity = stringValue(observed.npmIntegrity, "observed npm integrity");
  }
  if (observed.npmTags !== undefined) {
    const tags = objectValue(observed.npmTags, "observed npm dist-tags");
    result.npmTags = {
      ...(tags.latest === undefined ? {} : { latest: validateVersion(stringValue(tags.latest, "npm latest tag")) }),
      ...(tags.recovered === undefined
        ? {}
        : { recovered: validateVersion(stringValue(tags.recovered, "npm recovered tag")) })
    };
  }
  if (observed.githubRelease !== undefined) {
    const state = stringValue(observed.githubRelease, "observed GitHub Release state");
    if (!["absent", "draft", "sealed", "published"].includes(state)) {
      throw new Error(`Invalid observed GitHub Release state: ${state}`);
    }
    result.githubRelease = state === "absent" || state === "draft" || state === "sealed" ? state : "published";
  }
  if (observed.highestPublishedVersion !== undefined) {
    result.highestPublishedVersion = validateVersion(
      stringValue(observed.highestPublishedVersion, "highest published version")
    );
  }
  return result;
}

export function parseRuleset(value: unknown): Ruleset {
  const source = objectValue(value, "tag ruleset");
  const parsed: Ruleset = {};
  if (source.name !== undefined) parsed.name = stringValue(source.name, "tag ruleset name");
  if (source.target !== undefined) parsed.target = stringValue(source.target, "tag ruleset target");
  if (source.enforcement !== undefined) {
    parsed.enforcement = stringValue(source.enforcement, "tag ruleset enforcement");
  }
  if (source.conditions !== undefined) {
    const conditions = objectValue(source.conditions, "tag ruleset conditions");
    if (conditions.ref_name !== undefined) {
      const refName = objectValue(conditions.ref_name, "tag ruleset ref condition");
      parsed.conditions = {
        ref_name: {
          ...(refName.include === undefined ? {} : { include: stringArray(refName.include, "tag ruleset includes") }),
          ...(refName.exclude === undefined ? {} : { exclude: stringArray(refName.exclude, "tag ruleset excludes") })
        }
      };
    }
  }
  if (source.rules !== undefined) {
    if (!Array.isArray(source.rules)) throw new Error("Tag ruleset rules must be an array");
    parsed.rules = source.rules.map((value, index) => {
      const rule = objectValue(value, `tag ruleset rule ${index}`);
      return rule.type === undefined ? {} : { type: stringValue(rule.type, `tag ruleset rule ${index} type`) };
    });
  }
  if (source.bypass_actors !== undefined) {
    if (!Array.isArray(source.bypass_actors)) throw new Error("Tag ruleset bypass actors must be an array");
    parsed.bypass_actors = source.bypass_actors.map((value, index) => {
      const actor = objectValue(value, `tag ruleset bypass actor ${index}`);
      return {
        ...(actor.actor_id === undefined
          ? {}
          : { actor_id: integerValue(actor.actor_id, `tag ruleset bypass actor ${index} ID`) }),
        ...(actor.actor_type === undefined
          ? {}
          : { actor_type: stringValue(actor.actor_type, `tag ruleset bypass actor ${index} type`) }),
        ...(actor.bypass_mode === undefined
          ? {}
          : { bypass_mode: stringValue(actor.bypass_mode, `tag ruleset bypass actor ${index} mode`) })
      };
    });
  }
  return parsed;
}

export function candidateIdentity(manifest: ReleaseManifest): string {
  validateManifest(manifest);
  const canonical = JSON.stringify({
    release: manifest.release,
    image: manifest.image,
    package: manifest.package,
    notes: manifest.notes,
    acceptance: Object.fromEntries(Object.entries(manifest.acceptance).sort(([a], [b]) => a.localeCompare(b)))
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function planPublication(manifest: ReleaseManifest, observed: ObservedPublication): PublicationPlan {
  validateManifest(manifest);
  if ((observed.githubRelease === "sealed" || observed.githubRelease === "published") && !observed.sealedManifest) {
    throw new Error("An immutable GitHub Release is missing its sealed manifest");
  }
  if (observed.sealedManifest && candidateIdentity(observed.sealedManifest) !== candidateIdentity(manifest)) {
    throw new Error("The sealed GitHub Release bundle conflicts with this candidate");
  }
  if (observed.imageDigest && observed.imageDigest !== manifest.image.digest) {
    throw new Error(`The version image tag resolves to ${observed.imageDigest}, not ${manifest.image.digest}`);
  }
  if (observed.npmIntegrity && observed.npmIntegrity !== manifest.package.integrity) {
    throw new Error("The npm version exists with different package bytes");
  }
  if (observed.githubRelease === "published" && (!observed.imageDigest || !observed.npmIntegrity)) {
    throw new Error("The final GitHub Release was published before its image and npm package were complete");
  }
  const isNewest =
    !observed.highestPublishedVersion ||
    compareVersions(manifest.release.version, observed.highestPublishedVersion) >= 0;
  const npmTag = isNewest ? "latest" : "recovered";
  const operations: PublicationOperation[] = [];
  if (
    !observed.sealedManifest ||
    observed.githubRelease === undefined ||
    observed.githubRelease === "absent" ||
    observed.githubRelease === "draft"
  ) {
    operations.push("seal-github-release");
  }
  if (!observed.imageDigest) operations.push("promote-image");
  if (!observed.npmIntegrity) operations.push("publish-npm");
  if (observed.npmIntegrity && observed.npmTags?.[npmTag] !== manifest.release.version) operations.push("set-npm-tag");
  if (observed.githubRelease !== "published") operations.push("publish-github-release");
  return {
    operations,
    npmTag,
    complete: operations.length === 0
  };
}

export interface PublicationAdapters {
  inspect(): Promise<ObservedPublication>;
  github: {
    seal(manifest: ReleaseManifest): Promise<void>;
    publish(manifest: ReleaseManifest): Promise<void>;
  };
  registry: {
    promoteImage(manifest: ReleaseManifest): Promise<void>;
    publishPackage(manifest: ReleaseManifest, tag: "latest" | "recovered"): Promise<void>;
    setPackageTag(manifest: ReleaseManifest, tag: "latest" | "recovered"): Promise<void>;
  };
  process: {
    verify(manifest: ReleaseManifest): Promise<void>;
  };
}

export class AmbiguousWriteError extends Error {}

export async function reconcilePublication(
  manifest: ReleaseManifest,
  adapters: PublicationAdapters
): Promise<PublicationPlan> {
  for (let index = 0; index < 8; index += 1) {
    const plan = planPublication(manifest, await adapters.inspect());
    if (plan.complete) {
      await adapters.process.verify(manifest);
      return plan;
    }
    const operation = plan.operations[0];
    try {
      switch (operation) {
        case "seal-github-release":
          await adapters.github.seal(manifest);
          break;
        case "promote-image":
          await adapters.registry.promoteImage(manifest);
          break;
        case "publish-npm":
          await adapters.registry.publishPackage(manifest, plan.npmTag);
          break;
        case "set-npm-tag":
          await adapters.registry.setPackageTag(manifest, plan.npmTag);
          break;
        case "publish-github-release":
          await adapters.github.publish(manifest);
          break;
        default:
          throw new Error("Publication planner returned no executable operation");
      }
    } catch (error) {
      if (!(error instanceof AmbiguousWriteError)) throw error;
      const afterAmbiguousWrite = planPublication(manifest, await adapters.inspect());
      if (afterAmbiguousWrite.operations[0] === operation) throw error;
    }
  }
  throw new Error("Publication did not converge after every external operation was reconciled");
}

export function validateNpmAttestation(
  bundle: unknown,
  expected: { version: string; integrity: string; repository: string; ref: string; commit: string }
): void {
  validateVersion(expected.version);
  if (!INTEGRITY.test(expected.integrity)) throw new Error(`Invalid npm integrity: ${expected.integrity}`);
  assertSha(expected.commit, "release commit");
  const response = objectValue(bundle, "npm attestation response");
  if (!Array.isArray(response.attestations)) throw new Error("npm did not return attestations");
  let encoded: string | undefined;
  for (const [index, value] of response.attestations.entries()) {
    const attestation = objectValue(value, `npm attestation ${index}`);
    if (attestation.predicateType !== "https://slsa.dev/provenance/v1") continue;
    const attestationBundle = objectValue(attestation.bundle, "npm attestation bundle");
    const envelope = objectValue(attestationBundle.dsseEnvelope, "npm attestation DSSE envelope");
    encoded = stringValue(envelope.payload, "npm attestation payload");
    break;
  }
  if (!encoded) throw new Error("npm did not return a SLSA provenance attestation");
  const statementValue: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const statement = objectValue(statementValue, "npm provenance statement");
  const expectedDigest = Buffer.from(expected.integrity.slice("sha512-".length), "base64").toString("hex");
  if (!Array.isArray(statement.subject)) throw new Error("npm provenance has no subjects");
  const subject = statement.subject
    .map((value, index) => objectValue(value, `npm provenance subject ${index}`))
    .find((candidate) => candidate.name === `pkg:npm/atlas-core@${expected.version}`);
  const subjectDigest = subject && objectValue(subject.digest, "npm provenance subject digest");
  if (subjectDigest?.sha512 !== expectedDigest) throw new Error("npm provenance subject does not match the package");
  const predicate = objectValue(statement.predicate, "npm provenance predicate");
  const buildDefinition = objectValue(predicate.buildDefinition, "npm provenance build definition");
  const externalParameters = objectValue(buildDefinition.externalParameters, "npm provenance external parameters");
  const workflow = objectValue(externalParameters.workflow, "npm provenance workflow");
  const expectedRepository = `https://github.com/${expected.repository}`;
  if (
    workflow?.repository !== expectedRepository ||
    workflow.path !== releaseWorkflow ||
    workflow.ref !== expected.ref
  ) {
    throw new Error("npm provenance identifies an unexpected repository, workflow, or ref");
  }
  const dependencies = buildDefinition.resolvedDependencies;
  if (
    !Array.isArray(dependencies) ||
    !dependencies.some((value, index) => {
      const dependency = objectValue(value, `npm provenance dependency ${index}`);
      const digest = objectValue(dependency.digest, `npm provenance dependency ${index} digest`);
      return digest.gitCommit === expected.commit;
    })
  ) {
    throw new Error("npm provenance does not identify the tagged source commit");
  }
  const runDetails = objectValue(predicate.runDetails, "npm provenance run details");
  const builder = objectValue(runDetails.builder, "npm provenance builder");
  if (builder.id !== "https://github.com/actions/runner/github-hosted") {
    throw new Error("npm provenance does not identify a GitHub-hosted runner");
  }
}

export function validateTagRulesets(creation: Ruleset, immutability: Ruleset, expectedAppId?: number): void {
  if (expectedAppId !== undefined && (!Number.isSafeInteger(expectedAppId) || expectedAppId < 1)) {
    throw new Error("Release App ID must be a positive integer");
  }
  validateTagRuleset(creation, "Atlas Core release tag creation", ["creation"], ["update", "deletion"]);
  validateTagRuleset(immutability, "Atlas Core release tag immutability", ["update", "deletion"], ["creation"]);
  const creationBypasses = creation.bypass_actors ?? [];
  if (
    creationBypasses.length !== 1 ||
    !Number.isSafeInteger(creationBypasses[0]?.actor_id) ||
    (creationBypasses[0]?.actor_id ?? 0) < 1 ||
    creationBypasses[0]?.actor_type !== "Integration" ||
    creationBypasses[0]?.bypass_mode !== "always" ||
    (expectedAppId !== undefined && creationBypasses[0]?.actor_id !== expectedAppId)
  ) {
    throw new Error("Atlas Core release tag creation must allow only the intended release App to bypass creation");
  }
  if ((immutability.bypass_actors ?? []).length !== 0) {
    throw new Error("Atlas Core release tag immutability must not allow bypass actors");
  }
}

function validateTagRuleset(
  ruleset: Ruleset,
  name: string,
  requiredRules: readonly string[],
  forbiddenRules: readonly string[]
): void {
  if (ruleset.name !== name || ruleset.target !== "tag" || ruleset.enforcement !== "active") {
    throw new Error(`${name} must be an active tag ruleset`);
  }
  const include = ruleset.conditions?.ref_name?.include;
  const exclude = ruleset.conditions?.ref_name?.exclude;
  if (include?.length !== 1 || include[0] !== "refs/tags/atlas-core-v*" || exclude?.length !== 0) {
    throw new Error(`${name} must target only refs/tags/atlas-core-v*`);
  }
  const types = new Set(ruleset.rules?.map((rule) => rule.type));
  for (const type of requiredRules) {
    if (!types.has(type)) throw new Error(`${name} must restrict ${type}`);
  }
  for (const type of forbiddenRules) {
    if (types.has(type)) throw new Error(`${name} must not include ${type}`);
  }
}

function assertSha(value: string, label: string): void {
  if (!SHA.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function assertSafeFilename(value: string): void {
  if (!value || basename(value) !== value || value === "." || value === "..") {
    throw new Error(`Manifest contains unsafe filename: ${value}`);
  }
}

function assertFileHash(path: string, expected: string): void {
  const actual = sha256File(path);
  if (actual !== expected) throw new Error(`Bundle file ${basename(path)} has SHA-256 ${actual}, expected ${expected}`);
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return Number(value);
}
