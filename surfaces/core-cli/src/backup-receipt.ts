import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

const BACKUP_FILE_NAMES = [
  "app-revision.txt",
  "minio.complete",
  "minio.contents.txt",
  "postgres.contents.txt",
  "postgres.dump",
  "schema-migrations.txt"
] as const;
const BACKUP_ENTRY_LIMIT = 100_000;
const BACKUP_PATH_LIMIT = 4096;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;

export type PairedBackupIdentity = `sha256:${string}`;

/**
 * Validate one runbook backup directory and derive its content identity.
 * The identity covers the complete PostgreSQL dump, the complete MinIO
 * mirror, and the runbook's companion metadata. It deliberately excludes
 * credentials and the directory name, which are not part of the backup set.
 */
export async function readPairedBackupIdentity(directory: string): Promise<PairedBackupIdentity> {
  const root = normalizeBackupDirectory(directory);
  await assertDirectory(root, "paired backup directory");
  await assertExpectedRootEntries(root);

  const completionPath = join(root, "minio.complete");
  const bucket = await readBucketName(completionPath);
  const minioRoot = join(root, "minio");
  await assertDirectory(minioRoot, "paired backup MinIO directory");
  await assertExpectedBucketEntry(minioRoot, bucket);

  for (const name of BACKUP_FILE_NAMES) {
    const path = join(root, name);
    const stats = await assertRegularFile(path, `paired backup ${name}`);
    if (stats.size === 0 && name !== "minio.contents.txt") {
      throw new Error(`Paired backup ${name} must not be empty.`);
    }
  }
  await assertPostgresDump(join(root, "postgres.dump"));

  const paths = [...BACKUP_FILE_NAMES].map((name) => name);
  await collectFiles(join(minioRoot, bucket), `minio/${bucket}`, paths, { count: 0 });
  paths.sort(comparePaths);
  return await hashFiles(root, paths);
}

function normalizeBackupDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("Paired backup directory must be an absolute path.");
  return normalize(directory);
}

async function assertExpectedRootEntries(root: string): Promise<void> {
  const expected = new Set<string>([...BACKUP_FILE_NAMES, "minio"]);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Paired backup entry ${entry.name} must not be a symbolic link.`);
    if (!expected.has(entry.name)) throw new Error(`Paired backup contains unexpected entry ${entry.name}.`);
  }
  for (const name of BACKUP_FILE_NAMES) {
    if (!entries.some((entry) => entry.name === name)) throw new Error(`Paired backup is missing ${name}.`);
  }
  if (!entries.some((entry) => entry.name === "minio")) throw new Error("Paired backup is missing the MinIO mirror.");
}

async function assertExpectedBucketEntry(minioRoot: string, bucket: string): Promise<void> {
  const entries = await readdir(minioRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Paired backup MinIO entry ${entry.name} must not be a symbolic link.`);
    if (entry.name !== bucket) throw new Error(`Paired backup contains unexpected MinIO entry ${entry.name}.`);
  }
  const entry = entries.find((candidate) => candidate.name === bucket);
  if (!entry) throw new Error(`Paired backup is missing the MinIO bucket ${bucket}.`);
  await assertDirectory(join(minioRoot, bucket), `paired backup MinIO bucket ${bucket}`);
}

async function readBucketName(path: string): Promise<string> {
  const encoded = await readFile(path, "utf8");
  const bucket = encoded.replace(/\r\n?/gu, "\n");
  if (!bucket.endsWith("\n")) throw new Error("Paired backup minio.complete must contain one bucket name.");
  const name = bucket.slice(0, -1);
  if (!BUCKET_PATTERN.test(name)) throw new Error("Paired backup minio.complete contains an invalid bucket name.");
  return name;
}

async function assertPostgresDump(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(5);
    const result = await handle.read(header, 0, header.byteLength, 0);
    if (result.bytesRead !== header.byteLength || header.toString("ascii") !== "PGDMP") {
      throw new Error("Paired backup postgres.dump is not a PostgreSQL custom archive.");
    }
  } finally {
    await handle.close();
  }
}

async function collectFiles(
  directory: string,
  prefix: string,
  paths: string[],
  entryCount: { count: number }
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    if (relativePath.length > BACKUP_PATH_LIMIT) throw new Error("Paired backup contains an excessively long path.");
    entryCount.count += 1;
    if (entryCount.count > BACKUP_ENTRY_LIMIT) throw new Error("Paired backup contains too many entries.");
    if (entry.isSymbolicLink()) throw new Error(`Paired backup entry ${relativePath} must not be a symbolic link.`);
    if (entry.isDirectory()) {
      await collectFiles(path, relativePath, paths, entryCount);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Paired backup entry ${relativePath} must be a regular file.`);
    await assertRegularFile(path, `paired backup ${relativePath}`);
    paths.push(relativePath);
  }
}

async function hashFiles(root: string, paths: readonly string[]): Promise<PairedBackupIdentity> {
  const hash = createHash("sha256");
  for (const relativePath of paths) {
    const absolutePath = join(root, ...relativePath.split("/"));
    const before = await assertRegularFile(absolutePath, `paired backup ${relativePath}`);
    hash.update(Buffer.from(relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(before.size), "ascii"));
    hash.update(Buffer.from([0]));
    let bytesRead = 0;
    for await (const chunk of createReadStream(absolutePath)) {
      hash.update(chunk);
      bytesRead += chunk.length;
    }
    if (bytesRead !== before.size) throw new Error(`Paired backup ${relativePath} changed while being hashed.`);
    const after = await assertRegularFile(absolutePath, `paired backup ${relativePath}`);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`Paired backup ${relativePath} changed while being hashed.`);
    }
    hash.update(Buffer.from([10]));
  }
  return `sha256:${hash.digest("hex")}`;
}

async function assertRegularFile(path: string, description: string) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`${description} must not be a symbolic link.`);
  if (!stats.isFile()) throw new Error(`${description} must be a regular file.`);
  return stats;
}

async function assertDirectory(path: string, description: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${description} must be a real directory.`);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
