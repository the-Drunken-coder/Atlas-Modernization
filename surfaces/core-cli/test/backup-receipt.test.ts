import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPairedBackupIdentity } from "../src/backup-receipt.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "atlas-backup-receipt-test-"));
}

function createBackup(): string {
  const root = temporaryDirectory();
  const bucket = join(root, "minio", "atlas-media");
  mkdirSync(bucket, { recursive: true });
  writeFileSync(join(root, "app-revision.txt"), "revision-1\n");
  writeFileSync(join(root, "minio.complete"), "atlas-media\n");
  writeFileSync(join(root, "minio.contents.txt"), "atlas-media/object.bin\n");
  writeFileSync(join(root, "postgres.contents.txt"), "; Archive created at 2026-09-10\n");
  writeFileSync(join(root, "postgres.dump"), "PGDMP\x01custom archive bytes\n");
  writeFileSync(join(root, "schema-migrations.txt"), "1 baseline sha256:abc 1\n");
  writeFileSync(join(bucket, "object.bin"), "paired object bytes\n");
  return root;
}

describe("readPairedBackupIdentity", () => {
  it("validates and hashes the complete paired backup deterministically", async () => {
    const root = createBackup();
    const identity = await readPairedBackupIdentity(root);
    expect(identity).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await readPairedBackupIdentity(root)).toBe(identity);

    writeFileSync(join(root, "minio", "atlas-media", "object.bin"), "changed object bytes\n");
    expect(await readPairedBackupIdentity(root)).not.toBe(identity);
  });

  it("requires the runbook files and a PostgreSQL custom archive", async () => {
    const root = createBackup();
    writeFileSync(join(root, "postgres.dump"), "plain SQL\n");
    await expect(readPairedBackupIdentity(root)).rejects.toThrow(/custom archive/);
  });

  it("rejects symlinks and unexpected entries", async () => {
    const root = createBackup();
    symlinkSync(join(root, "app-revision.txt"), join(root, "revision-link.txt"));
    await expect(readPairedBackupIdentity(root)).rejects.toThrow(/unexpected entry|symbolic link/);
  });
});
