import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

const BUNDLE_SCHEMA = 1 as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type RetainedBundleFile = {
  path: string;
  sha256: `sha256:${string}`;
  size: number;
  mode: number;
};

export type RetainedBundleManifest = {
  schema: typeof BUNDLE_SCHEMA;
  files: readonly RetainedBundleFile[];
  bundleSha256: `sha256:${string}`;
};

export type RetainedBundleOptions = {
  sourceRoot: string;
  targetRoot: string;
  files: readonly string[];
  requiredFiles?: readonly string[];
  composeFiles?: readonly string[];
};

/**
 * Copies a Core package's immutable deployment files into a private base
 * directory. A candidate is completely validated and hashed before it can
 * replace the existing bundle.
 */
export function copyRetainedBundle(options: RetainedBundleOptions): RetainedBundleManifest {
  const sourceRoot = normalizeAbsoluteDirectory(options.sourceRoot, "bundle source root");
  const targetRoot = normalizeAbsolutePath(options.targetRoot, "bundle target root");
  assertDistinctBundleRoots(sourceRoot, targetRoot);
  const paths = normalizedUniquePaths(options.files);
  const requiredFiles = normalizedUniquePaths(options.requiredFiles ?? []);
  for (const path of requiredFiles) {
    if (!paths.includes(path)) throw new Error(`Retained bundle is missing required file ${path}.`);
  }
  assertComposeReferences(sourceRoot, paths, normalizedUniquePaths(options.composeFiles ?? []));

  const parent = dirname(targetRoot);
  ensureDirectory(parent, "bundle target parent");
  if (existsSync(targetRoot)) assertRealDirectory(targetRoot, "existing retained bundle");

  const candidate = `${targetRoot}.candidate-${randomUUID()}`;
  ensureDirectory(candidate, "retained bundle candidate");
  try {
    for (const path of paths) {
      const source = containedPath(sourceRoot, path);
      assertNoSymlinkAncestors(sourceRoot, path, `bundle source ${path}`);
      const sourceStats = assertRegularFile(source, `bundle source ${path}`);
      const destination = containedPath(candidate, path);
      assertNoSymlinkAncestors(candidate, path, `bundle candidate ${path}`);
      ensureDirectory(dirname(destination), "retained bundle candidate directory");
      // npm installations can be group-writable; retained deployment files must not be.
      copyFileDurably(source, destination, sourceStats.mode & 0o755);
    }
    const manifest = createRetainedBundleManifest(candidate);
    if (manifest.files.length !== paths.length || manifest.files.some((file, index) => file.path !== paths[index])) {
      throw new Error("Retained bundle candidate contains an unexpected file set.");
    }
    verifyRetainedBundle(candidate, manifest);
    replaceDirectory(targetRoot, candidate);
    return manifest;
  } finally {
    if (existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
  }
}

export const retainBundle = copyRetainedBundle;

export function createRetainedBundleManifest(root: string): RetainedBundleManifest {
  const normalizedRoot = normalizeAbsoluteDirectory(root, "retained bundle root");
  const paths = listFiles(normalizedRoot);
  const files = paths.map((path) => {
    const absolute = containedPath(normalizedRoot, path);
    const stats = assertRegularFile(absolute, `retained bundle file ${path}`);
    return {
      path,
      sha256: hashBytes(readFileSync(absolute)),
      size: stats.size,
      mode: stats.mode & 0o777
    } satisfies RetainedBundleFile;
  });
  return {
    schema: BUNDLE_SCHEMA,
    files,
    bundleSha256: hashBundleFiles(normalizedRoot, files)
  };
}

export function hashRetainedBundle(root: string): `sha256:${string}` {
  return createRetainedBundleManifest(root).bundleSha256;
}

export function verifyRetainedBundle(root: string, manifest: RetainedBundleManifest): void {
  if (manifest.schema !== BUNDLE_SCHEMA) throw new Error("Retained bundle has an unsupported schema.");
  if (!SHA256_PATTERN.test(manifest.bundleSha256)) throw new Error("Retained bundle has an invalid bundle hash.");
  const normalizedRoot = normalizeAbsoluteDirectory(root, "retained bundle root");
  const expected = [...manifest.files].map((file) => {
    const path = validateRelativePath(file.path);
    if (!SHA256_PATTERN.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0) {
      throw new Error(`Retained bundle has invalid metadata for ${path}.`);
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw new Error(`Retained bundle has invalid mode metadata for ${path}.`);
    }
    return { ...file, path };
  });
  expected.sort((left, right) => comparePaths(left.path, right.path));
  if (new Set(expected.map((file) => file.path)).size !== expected.length) {
    throw new Error("Retained bundle manifest contains duplicate paths.");
  }
  const actualPaths = listFiles(normalizedRoot);
  if (actualPaths.length !== expected.length || actualPaths.some((path, index) => path !== expected[index]?.path)) {
    throw new Error("Retained bundle file set does not match its manifest.");
  }
  const actualFiles = expected.map((file) => {
    const absolute = containedPath(normalizedRoot, file.path);
    assertNoSymlinkAncestors(normalizedRoot, file.path, `retained bundle ${file.path}`);
    const stats = assertRegularFile(absolute, `retained bundle ${file.path}`);
    const bytes = readFileSync(absolute);
    const digest = hashBytes(bytes);
    if (digest !== file.sha256 || bytes.byteLength !== file.size) {
      throw new Error(`Retained bundle file ${file.path} failed its hash check.`);
    }
    if ((stats.mode & 0o777) !== file.mode)
      throw new Error(`Retained bundle file ${file.path} has an unexpected mode.`);
    return {
      path: file.path,
      sha256: digest,
      size: bytes.byteLength,
      mode: stats.mode & 0o777
    } satisfies RetainedBundleFile;
  });
  if (hashBundleFiles(normalizedRoot, actualFiles) !== manifest.bundleSha256) {
    throw new Error("Retained bundle failed its deterministic bundle hash check.");
  }
}

function assertComposeReferences(sourceRoot: string, paths: readonly string[], composeFiles: readonly string[]): void {
  const pathSet = new Set(paths);
  for (const composePath of composeFiles) {
    if (!pathSet.has(composePath)) throw new Error(`Retained bundle does not include Compose file ${composePath}.`);
    const composeFile = containedPath(sourceRoot, composePath);
    assertNoSymlinkAncestors(sourceRoot, composePath, `bundle Compose file ${composePath}`);
    assertRegularFile(composeFile, `bundle Compose file ${composePath}`);
    const contents = readFileSync(composeFile, "utf8");
    const references = [
      ...contents
        .split(/\r?\n/)
        .filter((line) => /\b(volumes|env_file|configs|secrets|build)\b/u.test(line))
        .flatMap((line) => [...line.matchAll(/(?:^|[\s"'])(\.\.?\/[^"'\s:]+)/g)]),
      ...contents.matchAll(/\bfile:\s*["']?([^"'\s},]+)/g)
    ];
    for (const match of references) {
      const reference = match[1];
      if (!reference) continue;
      const normalized = validateRelativePath(join(dirname(composePath), reference));
      if (!pathSet.has(normalized)) {
        throw new Error(`Retained bundle Compose file ${composePath} references missing file ${normalized}.`);
      }
    }
  }
}

function normalizedUniquePaths(paths: readonly string[]): string[] {
  const result = paths.map(validateRelativePath).sort(comparePaths);
  if (new Set(result).size !== result.length) throw new Error("Retained bundle contains duplicate paths.");
  return result;
}

function validateRelativePath(path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || isAbsolute(path)) {
    throw new Error(`Invalid retained bundle path ${JSON.stringify(path)}.`);
  }
  if (
    path === "." ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    path.includes(`${sep}..${sep}`) ||
    path.endsWith(`${sep}..`)
  ) {
    throw new Error(`Retained bundle path escapes its root: ${path}`);
  }
  const normalized = normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Retained bundle path escapes its root: ${path}`);
  }
  return normalized;
}

function normalizeAbsolutePath(path: string, description: string): string {
  if (!isAbsolute(path)) throw new Error(`${description} must be absolute.`);
  return normalize(path);
}

function normalizeAbsoluteDirectory(path: string, description: string): string {
  const normalized = normalizeAbsolutePath(path, description);
  assertRealDirectory(normalized, description);
  return normalized;
}

function containedPath(root: string, path: string): string {
  const target = join(root, path);
  const escape = relative(root, target);
  if (escape === ".." || escape.startsWith(`..${sep}`) || isAbsolute(escape)) {
    throw new Error(`Retained bundle path escapes its root: ${path}`);
  }
  return target;
}

function assertNoSymlinkAncestors(root: string, path: string, description: string): void {
  let current = root;
  if (path.length === 0 && existsSync(current) && lstatSync(current).isSymbolicLink()) {
    throw new Error(`${description} must not contain a symbolic link.`);
  }
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${description} contains a symbolic link.`);
  }
}

function assertDistinctBundleRoots(sourceRoot: string, targetRoot: string): void {
  const sourceToTarget = relative(sourceRoot, targetRoot);
  const targetToSource = relative(targetRoot, sourceRoot);
  const targetInsideSource =
    sourceToTarget === "" ||
    (!sourceToTarget.startsWith(`..${sep}`) && sourceToTarget !== ".." && !isAbsolute(sourceToTarget));
  const sourceInsideTarget =
    targetToSource === "" ||
    (!targetToSource.startsWith(`..${sep}`) && targetToSource !== ".." && !isAbsolute(targetToSource));
  if (targetInsideSource || sourceInsideTarget) {
    throw new Error("Retained bundle source and target roots must be separate directories.");
  }
}

function assertRegularFile(path: string, description: string): Stats {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${description} must not be a symbolic link.`);
  if (!stats.isFile()) throw new Error(`${description} must be a regular file.`);
  return stats;
}

function assertRealDirectory(path: string, description: string): void {
  if (!existsSync(path)) throw new Error(`Missing ${description} at ${path}.`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${description} must be a real directory.`);
}

function ensureDirectory(path: string, description: string): void {
  if (existsSync(path)) {
    assertRealDirectory(path, description);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertRealDirectory(path, description);
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix.length > 0 ? `${prefix}${sep}${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Retained bundle contains a symbolic link at ${path}.`);
      if (entry.isDirectory()) {
        walk(absolute, path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new Error(`Retained bundle contains a non-regular entry at ${path}.`);
      }
    }
  };
  walk(root, "");
  return files.sort(comparePaths);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function replaceDirectory(target: string, candidate: string): void {
  const parent = dirname(target);
  const retired = `${target}.retired-${randomUUID()}`;
  let movedExisting = false;
  try {
    if (existsSync(target)) {
      assertRealDirectory(target, "existing retained bundle");
      renameSync(target, retired);
      movedExisting = true;
    }
    renameSync(candidate, target);
    syncDirectory(parent);
    if (movedExisting) rmSync(retired, { recursive: true, force: false });
    syncDirectory(parent);
  } catch (error) {
    if (existsSync(target) && movedExisting) rmSync(target, { recursive: true, force: true });
    if (movedExisting && existsSync(retired) && !existsSync(target)) renameSync(retired, target);
    throw error;
  }
}

function copyFileDurably(source: string, destination: string, mode: number): void {
  const bytes = readFileSync(source);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    chmodSync(temporary, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    syncDirectory(dirname(destination));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashBundleFiles(root: string, files: readonly RetainedBundleFile[]): `sha256:${string}` {
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = readFileSync(containedPath(root, file.path));
    const pathBytes = Buffer.from(file.path, "utf8");
    const lengthBytes = Buffer.from(String(bytes.byteLength), "ascii");
    hash.update(pathBytes);
    hash.update(Buffer.from([0]));
    hash.update(lengthBytes);
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([10]));
  }
  return `sha256:${hash.digest("hex")}`;
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Windows and some virtual filesystems do not permit directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
