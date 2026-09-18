#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { GitHubClient } from "./github.js";
import {
  inspectImage,
  inspectLivePublication,
  ProcessCommandRunner,
  promoteExactImage,
  reconcileLivePublication,
  verifyCompletedLivePublication
} from "./publication.js";
import {
  createManifest,
  objectValue,
  parseManifestInput,
  parseObservedPublication,
  parseReleaseManifest,
  parseRuleset,
  planPublication,
  previousReleaseTag,
  requireUnreservedVersion,
  stringValue,
  validateManifest,
  validateNotes,
  validateNpmAttestation,
  validateTagRulesets,
  validateVersion,
  versionFromTag
} from "./release.js";

const [command, ...rawArgs] = process.argv.slice(2);
const options = parseOptions(rawArgs);

switch (command) {
  case "validate-version":
    process.stdout.write(`${validateVersion(required(options, "version"))}\n`);
    break;
  case "version-from-tag":
    process.stdout.write(`${versionFromTag(required(options, "tag"))}\n`);
    break;
  case "previous-release-tag":
    previousReleaseTagCommand();
    break;
  case "verify-ci":
    await verifyCI();
    break;
  case "validate-reservation":
    validateReservation();
    break;
  case "reserve-tag":
    reserveTag();
    break;
  case "validate-release-tag":
    validateReleaseTag();
    break;
  case "prepare-package":
    preparePackage();
    break;
  case "validate-notes":
    validateNotes(readFileSync(required(options, "path"), "utf8"), options.get("version"));
    break;
  case "create-manifest":
    createManifestCommand();
    break;
  case "verify-bundle":
    verifyBundle();
    break;
  case "plan-publication":
    planPublicationCommand();
    break;
  case "reconcile-publication":
    await reconcilePublicationCommand();
    break;
  case "verify-completed-publication":
    await verifyCompletedPublicationCommand();
    break;
  case "inspect-publication":
    await inspectPublicationCommand();
    break;
  case "inspect-image":
    inspectImageCommand();
    break;
  case "promote-image":
    await promoteImageCommand();
    break;
  case "validate-npm-attestation":
    validateAttestationCommand();
    break;
  case "validate-tag-rulesets":
    validateTagRulesets(
      parseRuleset(readJSON(required(options, "creation"))),
      parseRuleset(readJSON(required(options, "immutability"))),
      Number(required(options, "release-app-id"))
    );
    break;
  case "require-immutable-releases":
    await requireImmutableReleases();
    break;
  case "status":
    await status();
    break;
  default:
    throw new Error(
      "usage: atlas-core-release <validate-version|version-from-tag|previous-release-tag|verify-ci|validate-reservation|reserve-tag|validate-release-tag|prepare-package|validate-notes|create-manifest|verify-bundle|plan-publication|inspect-publication|reconcile-publication|verify-completed-publication|inspect-image|promote-image|validate-npm-attestation|validate-tag-rulesets|require-immutable-releases|status> [--name value]"
    );
}

function previousReleaseTagCommand(): void {
  const releases = readJSON(required(options, "releases"));
  if (!Array.isArray(releases)) throw new Error("GitHub Releases must be an array");
  const tags = releases.map((release, index) =>
    stringValue(objectValue(release, `GitHub Release ${index}`).tagName, `GitHub Release ${index} tag`)
  );
  const previous = previousReleaseTag(required(options, "version"), tags);
  if (previous) process.stdout.write(`${previous}\n`);
}

async function verifyCI(): Promise<void> {
  const repository = required(options, "repository");
  const sourceSha = required(options, "source-sha");
  const token = process.env[options.get("token-env") ?? "GH_TOKEN"];
  const timeoutSeconds = Number(options.get("timeout-seconds") ?? "2700");
  if (!token) throw new Error("The configured GitHub token environment variable is empty");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error("Invalid CI timeout");
  const results = await new GitHubClient(repository, token).waitForRequiredCI(sourceSha, timeoutSeconds * 1000);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

function validateReservation(): void {
  const version = validateVersion(required(options, "version"));
  const source = required(options, "source-sha");
  const remote = options.get("remote") ?? "origin";
  runGit(["rev-parse", "--verify", `${source}^{commit}`]);
  runGit(["merge-base", "--is-ancestor", source, `${remote}/main`]);
  const contract = objectValue(
    parseJSON(runGit(["show", `${source}:tools/atlas-core-release/release-contract.json`]), "release contract"),
    "release contract"
  );
  if (contract.schemaVersion !== 1) {
    throw new Error(`${source} does not contain Atlas Core release contract schema 1`);
  }
  runGit(["cat-file", "-e", `${source}:.github/workflows/release-atlas-core.yml`]);
  const tag = `atlas-core-v${version}`;
  const existing = tagState(tag, source);
  if (existing === "matching") {
    process.stdout.write("already-reserved\n");
    return;
  }
  if (existing === "conflict") throw new Error(`${tag} already exists with a different or lightweight target`);
  const tags = runGit(["tag", "--list", "atlas-core-v*"]).split("\n").filter(Boolean).map(versionFromTag);
  requireUnreservedVersion(version, tags);
  process.stdout.write("available\n");
}

function reserveTag(): void {
  const version = validateVersion(required(options, "version"));
  const source = required(options, "source-sha");
  const tag = `atlas-core-v${version}`;
  runGit(["fetch", "origin", "main:refs/remotes/origin/main", "--tags", "--force"]);
  const existing = tagState(tag, source);
  if (existing === "matching") {
    process.stdout.write("already-reserved\n");
    return;
  }
  if (existing === "conflict") throw new Error(`${tag} already exists with a different or lightweight target`);
  runGit(["tag", "--annotate", tag, source, "--message", `Atlas Core ${version}`]);
  try {
    runGit(["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  } catch (error) {
    runGit(["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`, "--force"]);
    if (tagState(tag, source) !== "matching") throw error;
  }
  process.stdout.write("created\n");
}

function validateReleaseTag(): void {
  const version = validateVersion(required(options, "version"));
  const source = required(options, "source-sha");
  const tag = `atlas-core-v${version}`;
  if (tagState(tag, source) !== "matching") throw new Error(`${tag} is not an annotated tag for ${source}`);
  const tagObject = runGit(["rev-parse", `refs/tags/${tag}`]);
  process.stdout.write(`${tagObject}\n`);
}

function preparePackage(): void {
  const root = resolve(required(options, "root"));
  const version = validateVersion(required(options, "version"));
  const image = required(options, "image");
  if (!/^ghcr\.io\/the-drunken-coder\/atlas-core@sha256:[0-9a-f]{64}$/u.test(image)) {
    throw new Error(`Invalid Atlas Core image: ${image}`);
  }
  const packagePath = join(root, "surfaces/core-cli/package.json");
  const lockPath = join(root, "package-lock.json");
  const packageJSON = objectValue(readJSON(packagePath), "Atlas Core package.json");
  packageJSON.version = version;
  packageJSON.atlasCoreImage = image;
  writeFileSync(packagePath, `${JSON.stringify(packageJSON, null, 2)}\n`);
  const lock = objectValue(readJSON(lockPath), "package-lock.json");
  const packages = objectValue(lock.packages, "package-lock packages");
  const workspaceValue = packages["surfaces/core-cli"];
  const workspace = workspaceValue === undefined ? undefined : objectValue(workspaceValue, "Atlas Core lock entry");
  if (!workspace) throw new Error("package-lock.json does not contain the Atlas Core workspace");
  workspace.version = version;
  packages["surfaces/core-cli"] = workspace;
  lock.packages = packages;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function createManifestCommand(): void {
  const specPath = required(options, "spec");
  const output = required(options, "output");
  const input = parseManifestInput(readJSON(specPath));
  const manifest = createManifest(input);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
}

function verifyBundle(): void {
  const path = required(options, "manifest");
  const root = required(options, "root");
  validateManifest(parseReleaseManifest(readJSON(path)), root);
}

function planPublicationCommand(): void {
  const manifest = parseReleaseManifest(readJSON(required(options, "manifest")));
  const observed = parseObservedPublication(readJSON(required(options, "observed")));
  process.stdout.write(`${JSON.stringify(planPublication(manifest, observed), null, 2)}\n`);
}

async function reconcilePublicationCommand(): Promise<void> {
  const manifestPath = required(options, "manifest");
  const root = resolve(required(options, "root"));
  const manifest = parseReleaseManifest(readJSON(manifestPath));
  const plan = await reconcileLivePublication(manifest, root);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

async function verifyCompletedPublicationCommand(): Promise<void> {
  const manifestPath = required(options, "manifest");
  const root = resolve(required(options, "root"));
  const manifest = parseReleaseManifest(readJSON(manifestPath));
  const plan = await verifyCompletedLivePublication(manifest, root);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

async function inspectPublicationCommand(): Promise<void> {
  const manifestPath = required(options, "manifest");
  const root = resolve(required(options, "root"));
  const manifest = parseReleaseManifest(readJSON(manifestPath));
  const plan = await inspectLivePublication(manifest, root);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

function inspectImageCommand(): void {
  const digest = inspectImage(new ProcessCommandRunner(), required(options, "reference"));
  process.stdout.write(`${digest ?? "absent"}\n`);
}

async function promoteImageCommand(): Promise<void> {
  await promoteExactImage(
    new ProcessCommandRunner(),
    required(options, "source"),
    required(options, "target"),
    required(options, "digest")
  );
}

function validateAttestationCommand(): void {
  const manifest = parseReleaseManifest(readJSON(required(options, "manifest")));
  const bundle = readJSON(required(options, "bundle"));
  validateNpmAttestation(bundle, {
    version: manifest.release.version,
    integrity: manifest.package.integrity,
    repository: manifest.release.repository,
    ref: `refs/tags/${manifest.release.tag_name}`,
    commit: manifest.release.source_sha
  });
}

async function requireImmutableReleases(): Promise<void> {
  const repository = required(options, "repository");
  const token = process.env[options.get("token-env") ?? "GH_TOKEN"];
  if (!token) throw new Error("The configured GitHub token environment variable is empty");
  await new GitHubClient(repository, token).requireImmutableReleases();
}

async function status(): Promise<void> {
  const version = validateVersion(required(options, "version"));
  const tag = `atlas-core-v${version}`;
  const sourceSha = runGit(["rev-list", "-n", "1", tag], true);
  const repository = options.get("repository") ?? process.env.GITHUB_REPOSITORY ?? repositoryFromRemote();
  const release = repository
    ? inspectRelease(repository, tag)
    : { ok: false, stdout: "", stderr: "Unable to identify the GitHub repository" };
  const npm = tryExec("npm", ["view", `atlas-core@${version}`, "version", "dist.integrity", "--json"]);
  const image = tryExec("docker", [
    "buildx",
    "imagetools",
    "inspect",
    `ghcr.io/the-drunken-coder/atlas-core:${version}`
  ]);
  let requiredCI: unknown = { state: "unavailable", detail: "Set GH_TOKEN to inspect required source CI." };
  if (sourceSha && repository && process.env.GH_TOKEN) {
    try {
      requiredCI = await new GitHubClient(repository, process.env.GH_TOKEN).waitForRequiredCI(sourceSha, 0);
    } catch (error) {
      requiredCI = { state: "blocked", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  let reservedTag: { state: "not-checked" | "reserved" | "missing-or-conflicting" | "unavailable"; detail?: string } = {
    state: "not-checked"
  };
  const githubRecord = release.ok
    ? objectValue(parseJSON(release.stdout, "GitHub Release status"), "GitHub Release status")
    : undefined;
  const github = githubRecord ?? externalFailure(release.stderr, /release not found|HTTP 404/iu);
  const sealed =
    githubRecord !== undefined &&
    Array.isArray(githubRecord.assets) &&
    githubRecord.assets.some((value: unknown, index: number) => {
      const asset = objectValue(value, `GitHub Release status asset ${index}`);
      return asset.name === "release-manifest.json";
    });
  const npmState = npm.ok
    ? parseJSON(npm.stdout, "npm package status")
    : externalFailure(npm.stderr, /E404|404 Not Found|No match found/iu);
  const imageState = image.ok ? "visible" : externalFailure(image.stderr, /manifest unknown|not found|HTTP 404/iu);
  const unavailable = [github, npmState, imageState].some(
    (state) =>
      typeof state === "object" && state !== null && objectValue(state, "external status").state === "unavailable"
  );
  let verification:
    | { state: "not-run"; detail: string }
    | { state: "partial"; operations: string[] }
    | { state: "verified" }
    | { state: "failed"; detail: string } = {
    state: "not-run",
    detail: "A final immutable release with its manifest is not present."
  };
  const finalCandidate =
    githubRecord?.draft === false && githubRecord.prerelease === false && githubRecord.immutable === true && sealed;
  if (finalCandidate && repository) {
    const root = mkdtempSync(join(tmpdir(), "atlas-core-status-"));
    try {
      const download = tryExec("gh", ["release", "download", tag, "--dir", root, "--repo", repository]);
      if (!download.ok) throw new Error(download.stderr || "Unable to download immutable release bundle");
      const manifest = parseReleaseManifest(readJSON(join(root, "release-manifest.json")));
      if (
        manifest.release.version !== version ||
        manifest.release.tag_name !== tag ||
        manifest.release.repository !== repository ||
        (sourceSha && manifest.release.source_sha !== sourceSha)
      ) {
        throw new Error("The immutable release manifest does not match the requested release identity");
      }
      reservedTag = inspectRemoteTag(repository, manifest);
      if (process.env.GH_TOKEN) {
        try {
          requiredCI = await new GitHubClient(repository, process.env.GH_TOKEN).waitForRequiredCI(
            manifest.release.source_sha,
            0
          );
        } catch (error) {
          requiredCI = { state: "blocked", detail: error instanceof Error ? error.message : String(error) };
        }
      }
      const plan = await verifyCompletedLivePublication(manifest, root);
      verification = plan.complete ? { state: "verified" } : { state: "partial", operations: plan.operations };
    } catch (error) {
      verification = { state: "failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const report = {
    version,
    tag,
    sourceSha: sourceSha || null,
    git: sourceSha && tagState(tag, sourceSha) === "matching" ? "reserved" : "missing-or-conflicting",
    reservedTag,
    requiredCI,
    github,
    sealedBundle: sealed ? "present" : "absent",
    npm: npmState,
    image: imageState,
    verification,
    next:
      verification.state === "failed"
        ? "investigate verification failure; recovery will not overwrite conflicting state"
        : reservedTag.state === "missing-or-conflicting"
          ? "investigate the missing or conflicting remote release tag"
          : unavailable || reservedTag.state === "unavailable" || isUnavailableStatus(requiredCI)
            ? "retry status; at least one external state could not be read"
            : !Array.isArray(requiredCI)
              ? "investigate required source CI before treating the release as complete"
              : verification.state === "verified" && reservedTag.state === "reserved"
                ? "complete; verification only"
                : "dispatch the immutable tag for recovery"
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function inspectRelease(repository: string, tag: string): ReturnType<typeof tryExec> {
  const byTag = tryExec("gh", ["api", `repos/${repository}/releases/tags/${tag}`]);
  if (byTag.ok || !/HTTP 404|Not Found/iu.test(byTag.stderr)) return byTag;
  const listed = tryExec("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]);
  if (!listed.ok) return listed;
  const pages = parseJSON(listed.stdout, "GitHub Release list");
  if (!Array.isArray(pages)) return { ok: false, stdout: "", stderr: "GitHub Release list is not paginated JSON" };
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const value of page) {
      const release = objectValue(value, "GitHub Release list item");
      if (release.tag_name === tag) return { ok: true, stdout: JSON.stringify(release), stderr: "" };
    }
  }
  return byTag;
}

function inspectRemoteTag(
  repository: string,
  manifest: ReturnType<typeof parseReleaseManifest>
): { state: "reserved" | "missing-or-conflicting" | "unavailable"; detail?: string } {
  const ref = tryExec("gh", ["api", `repos/${repository}/git/ref/tags/${manifest.release.tag_name}`]);
  if (!ref.ok) {
    return /HTTP 404|Not Found/iu.test(ref.stderr)
      ? { state: "missing-or-conflicting", detail: ref.stderr.trim() }
      : { state: "unavailable", detail: ref.stderr.trim() };
  }
  try {
    const refRecord = objectValue(parseJSON(ref.stdout, "remote release tag ref"), "remote release tag ref");
    const refObject = objectValue(refRecord.object, "remote release tag ref object");
    if (refObject.type !== "tag" || refObject.sha !== manifest.release.tag_object) {
      return { state: "missing-or-conflicting", detail: "Remote ref is not the manifest's annotated tag object." };
    }
    const tag = tryExec("gh", ["api", `repos/${repository}/git/tags/${manifest.release.tag_object}`]);
    if (!tag.ok) {
      return /HTTP 404|Not Found/iu.test(tag.stderr)
        ? { state: "missing-or-conflicting", detail: tag.stderr.trim() }
        : { state: "unavailable", detail: tag.stderr.trim() };
    }
    const tagRecord = objectValue(
      parseJSON(tag.stdout, "remote annotated release tag"),
      "remote annotated release tag"
    );
    const target = objectValue(tagRecord.object, "remote annotated release tag target");
    return target.type === "commit" && target.sha === manifest.release.source_sha
      ? { state: "reserved" }
      : { state: "missing-or-conflicting", detail: "Annotated tag target does not match the manifest source." };
  } catch (error) {
    return { state: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}

function isUnavailableStatus(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    objectValue(value, "status state").state === "unavailable"
  );
}

function externalFailure(stderr: string, absent: RegExp): { state: "absent" | "unavailable"; detail: string } {
  return { state: absent.test(stderr) ? "absent" : "unavailable", detail: stderr.trim() };
}

function repositoryFromRemote(): string | undefined {
  const remote = runGit(["remote", "get-url", "origin"], true);
  const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/u);
  return match?.[1];
}

function tagState(tag: string, source: string): "absent" | "matching" | "conflict" {
  const object = runGit(["rev-parse", "--verify", `refs/tags/${tag}`], true);
  if (!object) return "absent";
  const type = runGit(["cat-file", "-t", `refs/tags/${tag}`]);
  if (type !== "tag") return "conflict";
  const tagObject = runGit(["cat-file", "-p", `refs/tags/${tag}`]);
  const target = tagObject.match(/^object ([0-9a-f]{40})\ntype ([^\n]+)\n/u);
  return target?.[2] === "commit" && target[1] === source ? "matching" : "conflict";
}

function runGit(args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function tryExec(file: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    return {
      ok: true,
      stdout: execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }),
      stderr: ""
    };
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const failure = objectValue(error, `${file} failure`);
      return { ok: false, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? error) };
    }
    return { ok: false, stdout: "", stderr: String(error) };
  }
}

function readJSON(path: string): unknown {
  return parseJSON(readFileSync(path, "utf8"), path);
}

function parseJSON(contents: string, label: string): unknown {
  try {
    const value: unknown = JSON.parse(contents);
    return value;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOptions(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid option list near ${name ?? "end"}`);
    result.set(name.slice(2), value);
  }
  return result;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
