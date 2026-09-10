import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ImageReceipt, parseImageReceipt } from "./image-receipts.js";
import { copyRetainedBundle, type RetainedBundleManifest } from "./retained-bundle.js";

const PACKAGE_NAME = "atlas-core";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9./:_-]*$/u;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const REQUIRED_FILES = ["docker-compose.init.yml", "docker-compose.yml", "source_gateway.production.json"] as const;
const REQUIRED_ARCHIVE_FILES = new Set([
  "package/package.json",
  ...REQUIRED_FILES.map((path) => `package/assets/${path}`)
]);

export type LegacyCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type LegacyCommandRunner = (command: string, args: readonly string[]) => Promise<LegacyCommandResult>;

export type LegacyBaseDeployment = {
  bundleSha256: `sha256:${string}`;
  coreImage: string;
  coreLocalImageId: `sha256:${string}`;
  images: readonly ImageReceipt[];
};

export type PreparedLegacyBase = {
  /** The temporary root that owns the extracted archive and prepared base. */
  candidateDirectory: string;
  /** The directory that the parent transaction can copy into its staged base/. */
  baseDirectory: string;
  files: readonly string[];
  manifest: RetainedBundleManifest;
  baseDeployment: LegacyBaseDeployment;
  /** Removes the candidate after the parent transaction has staged it. */
  cleanup: () => void;
};

export type PrepareLegacyBaseOptions = {
  configDir: string;
  packageVersion: string;
  runCommand: LegacyCommandRunner;
  pullImage: (image: string) => Promise<ImageReceipt>;
};

/**
 * Fetches the exact pre-independent-release Core package and prepares its
 * deployment bundle without touching the live state.json or base/. The
 * downloaded npm package is treated as data: only a small vetted asset set is
 * extracted, package code is never installed or executed, and the legacy
 * Compose restart policy is normalized before the candidate is returned.
 */
export async function prepareLegacyBase(options: PrepareLegacyBaseOptions): Promise<PreparedLegacyBase> {
  assertVersion(options.packageVersion);
  const candidateDirectory = mkdtempSync(join(options.configDir, `.legacy-base-${randomUUID()}-`));
  const packDirectory = join(candidateDirectory, "pack");
  const unpackDirectory = join(candidateDirectory, "unpacked");
  const baseDirectory = join(candidateDirectory, "base");
  mkdirSync(packDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(unpackDirectory, { recursive: true, mode: 0o700 });

  try {
    const archivePath = await packExactCorePackage(options, packDirectory);
    const archiveEntries = await inspectArchive(options.runCommand, archivePath);
    for (const entry of REQUIRED_ARCHIVE_FILES) {
      if (!archiveEntries.includes(entry))
        throw new Error(`Legacy Core package is missing vetted archive entry: ${entry}`);
    }
    await extractArchive(options.runCommand, archivePath, unpackDirectory, [...REQUIRED_ARCHIVE_FILES]);

    const packageRoot = join(unpackDirectory, "package");
    const packageJson = readPackageJson(join(packageRoot, "package.json"));
    if (packageJson.name !== PACKAGE_NAME || packageJson.version !== options.packageVersion) {
      throw new Error(
        `Downloaded ${PACKAGE_NAME}@${options.packageVersion} package metadata does not match the requested version.`
      );
    }
    const coreImage = packageJson.atlasCoreImage;
    assertImage(coreImage, "atlasCoreImage");

    const normalizedRoot = join(candidateDirectory, "normalized-assets");
    mkdirSync(normalizedRoot, { recursive: true, mode: 0o700 });
    const composeContents = new Map<string, string>();
    for (const file of REQUIRED_FILES) {
      const source = join(packageRoot, "assets", file);
      assertRegularFile(source, `package/assets/${file}`);
      let contents = readFileSync(source, "utf8");
      if (file === "docker-compose.yml" || file === "docker-compose.init.yml") {
        contents = normalizeRestartPolicies(contents, file);
        composeContents.set(file, contents);
      }
      const destination = join(normalizedRoot, file);
      mkdirSync(join(destination, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(destination, contents, { mode: lstatSync(source).mode & 0o777 });
    }

    const manifest = copyRetainedBundle({
      sourceRoot: normalizedRoot,
      targetRoot: baseDirectory,
      files: [...REQUIRED_FILES],
      requiredFiles: [...REQUIRED_FILES],
      composeFiles: ["docker-compose.yml", "docker-compose.init.yml"]
    });
    const images = await pullLegacyImages(options.pullImage, coreImage, [...composeContents.values()]);
    const coreReceipt = images.find((receipt) => receipt.image_index === coreImage);
    if (!coreReceipt) throw new Error(`No image receipt was returned for legacy Core image ${coreImage}.`);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      rmSync(candidateDirectory, { recursive: true, force: true });
    };
    return {
      candidateDirectory,
      baseDirectory,
      files: manifest.files.map((file) => file.path),
      manifest,
      baseDeployment: {
        bundleSha256: manifest.bundleSha256,
        coreImage,
        coreLocalImageId: coreReceipt.local_image_id as `sha256:${string}`,
        images
      },
      cleanup
    };
  } catch (error) {
    rmSync(candidateDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function packExactCorePackage(options: PrepareLegacyBaseOptions, packDirectory: string): Promise<string> {
  const result = await options.runCommand("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--silent",
    "--pack-destination",
    packDirectory,
    `${PACKAGE_NAME}@${options.packageVersion}`
  ]);
  assertCommandSuccess("npm pack", result);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("npm pack returned invalid JSON metadata.");
  }
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error("npm pack did not return exactly one package result.");
  }
  const record = value[0];
  if (
    record.name !== PACKAGE_NAME ||
    record.version !== options.packageVersion ||
    typeof record.filename !== "string"
  ) {
    throw new Error("npm pack returned metadata for a different atlas-core package.");
  }
  if (
    !record.filename ||
    record.filename !== `${PACKAGE_NAME}-${options.packageVersion}.tgz` ||
    record.filename.includes("/") ||
    record.filename.includes("\\") ||
    record.filename.includes("\0")
  ) {
    throw new Error("npm pack returned an unsafe archive filename.");
  }
  const archivePath = join(packDirectory, record.filename);
  assertRegularFile(archivePath, "npm package archive");
  return archivePath;
}

async function inspectArchive(runCommand: LegacyCommandRunner, archivePath: string): Promise<readonly string[]> {
  const list = await runCommand("tar", ["-tf", archivePath]);
  assertCommandSuccess("tar list", list);
  const entries = list.stdout.split(/\r?\n/u).filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error("Legacy Core package archive is empty.");
  if (new Set(entries).size !== entries.length)
    throw new Error("Legacy Core package archive contains duplicate entries.");

  const verbose = await runCommand("tar", ["-tvf", archivePath]);
  assertCommandSuccess("tar metadata list", verbose);
  const lines = verbose.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== entries.length) throw new Error("Legacy Core package archive metadata is inconsistent.");
  for (const [index, line] of lines.entries()) {
    const mode = line[0];
    if (mode === "l" || mode === "h")
      throw new Error(`Legacy Core package contains a symbolic or hard link: ${entries[index]}`);
    if (mode !== "-" && mode !== "d")
      throw new Error(`Legacy Core package contains a special archive entry: ${entries[index]}`);
  }
  for (const entry of entries) assertArchiveEntry(entry);
  return entries;
}

async function extractArchive(
  runCommand: LegacyCommandRunner,
  archivePath: string,
  destination: string,
  entries: readonly string[]
): Promise<void> {
  const result = await runCommand("tar", [
    "--no-same-owner",
    "--no-same-permissions",
    "-xf",
    archivePath,
    "-C",
    destination,
    ...entries
  ]);
  assertCommandSuccess("tar extract", result);
  for (const entry of entries) assertRegularFile(join(destination, entry), entry);
}

function readPackageJson(path: string): { name: string; version: string; atlasCoreImage: string } {
  assertRegularFile(path, "package/package.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Downloaded atlas-core package.json is invalid JSON.");
  }
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.atlasCoreImage !== "string"
  ) {
    throw new Error("Downloaded atlas-core package.json is missing required release metadata.");
  }
  return { name: value.name, version: value.version, atlasCoreImage: value.atlasCoreImage };
}

function normalizeRestartPolicies(contents: string, file: string): string {
  const normalized = contents.replace(/^(\s*)restart:\s*[^\r\n]*$/gmu, '$1restart: "no"');
  for (const line of normalized.split(/\r?\n/u)) {
    const match = /^\s*restart:\s*(\S.*)$/u.exec(line);
    if (match && match[1] !== '"no"' && match[1] !== "'no'") {
      throw new Error(`Legacy ${file} contains an unsupported restart policy.`);
    }
  }
  return normalized;
}

async function pullLegacyImages(
  pullImage: (image: string) => Promise<ImageReceipt>,
  coreImage: string,
  composeContents: readonly string[]
): Promise<readonly ImageReceipt[]> {
  const images = new Set<string>([coreImage]);
  let sawCoreImageReference = false;
  for (const contents of composeContents) {
    for (const line of contents.split(/\r?\n/u)) {
      const match = /^\s*image:\s*(.*)$/u.exec(line);
      if (!match) continue;
      const image = parseImageScalar(match[1] ?? "");
      if (image.startsWith("${")) {
        if (!/^\$\{ATLAS_CORE_IMAGE(?::[^}\r\n]*)?\}$/u.test(image)) {
          throw new Error("Legacy Compose contains an unapproved dynamic image reference.");
        }
        sawCoreImageReference = true;
        continue;
      }
      assertImage(image, "legacy Compose image");
      images.add(image);
    }
  }
  if (!sawCoreImageReference) throw new Error("Legacy Compose does not reference the package Core image variable.");
  const receipts: ImageReceipt[] = [];
  for (const image of [...images].sort()) {
    const receipt = parseImageReceipt(await pullImage(image));
    if (receipt.image_index !== image)
      throw new Error(`Image pull returned a receipt for a different image than ${image}.`);
    receipts.push(receipt);
  }
  return receipts;
}

function parseImageScalar(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) throw new Error("Legacy Compose contains an empty image reference.");
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closing = value.lastIndexOf(quote);
    if (
      closing <= 0 ||
      value
        .slice(closing + 1)
        .trim()
        .replace(/^#.*/u, "") !== ""
    ) {
      throw new Error("Legacy Compose contains a malformed quoted image reference.");
    }
    return value.slice(1, closing);
  }
  return stripPlainScalarComment(value);
}

function stripPlainScalarComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trim();
    }
  }
  return value;
}

function assertArchiveEntry(entry: string): void {
  const pathWithoutTrailingSlash = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  const segments = pathWithoutTrailingSlash.split("/");
  if (
    entry.includes("\0") ||
    entry.includes("\\") ||
    entry.startsWith("/") ||
    entry.startsWith("./") ||
    segments.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Legacy Core package contains an unsafe archive path: ${entry}`);
  }
  if (!entry.startsWith("package/") || entry === "package") {
    throw new Error(`Legacy Core package contains an archive entry outside package/: ${entry}`);
  }
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version))
    throw new Error(`Legacy Core package version is not an exact stable version: ${version}`);
}

function assertImage(image: string, source: string): void {
  if (!isImageReference(image)) throw new Error(`${source} must be an immutable digest-pinned image.`);
}

function isImageReference(image: string): boolean {
  const at = image.lastIndexOf("@");
  if (at <= 0 || image.indexOf("@") !== at) return false;
  const reference = image.slice(0, at);
  const lastSlash = reference.lastIndexOf("/");
  const lastColon = reference.lastIndexOf(":");
  const repository = lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
  const tag = lastColon > lastSlash ? reference.slice(lastColon + 1) : undefined;
  return (
    REPOSITORY_PATTERN.test(repository) &&
    (tag === undefined || TAG_PATTERN.test(tag)) &&
    /^sha256:[a-f0-9]{64}$/u.test(image.slice(at + 1))
  );
}

function assertRegularFile(path: string, description: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile())
    throw new Error(`${description} is missing or is not a regular file.`);
}

function assertCommandSuccess(command: string, result: LegacyCommandResult): void {
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim() || "no diagnostic"}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
