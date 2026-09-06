import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Fingerprint the actual Link and SDK trees, including local uncommitted source. */
export async function experimentSourceIdentity() {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const packagesRoot = join(packageRoot, "..");
  const files: { path: string; sha256: string }[] = [];
  async function collect(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await collect(child);
      else if (entry.isFile())
        files.push({
          path: relative(packagesRoot, child),
          sha256: createHash("sha256")
            .update(await readFile(child))
            .digest("hex")
        });
    }
  }
  // src for tsx, dist for the built CLI. Both include the executable modules.
  const codeRoot = fileURLToPath(new URL("../", import.meta.url));
  await collect(codeRoot);
  await collect(join(packagesRoot, "sdk", "dist"));
  for (const path of [join(packageRoot, "package.json"), join(packagesRoot, "..", "package-lock.json")]) {
    files.push({
      path: relative(packagesRoot, path),
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
    });
  }
  let revision: string | null = null;
  try {
    revision = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: packageRoot })).stdout.trim();
  } catch {
    /* Content fingerprints remain available outside Git. */
  }
  return {
    revision,
    node_version: process.version,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files
  };
}
