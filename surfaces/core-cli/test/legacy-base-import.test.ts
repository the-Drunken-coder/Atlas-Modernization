import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ImageReceipt } from "../src/image-receipts.js";
import { type LegacyCommandResult, prepareLegacyBase, prepareRepairPackage } from "../src/legacy-base-import.js";

const VERSION = "0.1.8";
const CORE_IMAGE = `ghcr.io/the-drunken-coder/atlas-core@sha256:${"a".repeat(64)}`;
const POSTGRES_IMAGE = `postgres:15@sha256:${"b".repeat(64)}`;
const MINIO_IMAGE = `quay.io/minio/minio:legacy@sha256:${"c".repeat(64)}`;
const MINIO_CLIENT_IMAGE = `quay.io/minio/mc:legacy@sha256:${"d".repeat(64)}`;
const PRODUCTION_POSTGRES_IMAGE = "postgres:15@sha256:1b92e7a80c021647bf70f5d3eb66066a998e4f5cf43c07bb9dc9f729782cf88e";
const PRODUCTION_MINIO_IMAGE =
  "quay.io/minio/minio:RELEASE.2024-01-31T20-20-33Z@sha256:4092433a77e510826874b36f369696df43407a763d7f901a61d74e83e6fd95bc";
const PRODUCTION_MINIO_CLIENT_IMAGE =
  "quay.io/minio/mc:RELEASE.2024-01-31T08-59-40Z@sha256:c084c9a67c7a9ed5f37cc7f2a905010861aaa882bec76da10352305c9709b6d2";

describe("exact Core repair package", () => {
  it("fetches recorded assets and templates without extracting package code or changing bytes", async () => {
    const fixture = createPackageFixture({ productionAssets: true, extraFile: true });
    const templates = join(fixture.root, "package", "assets", "plugin-templates");
    mkdirSync(templates);
    writeFileSync(join(templates, "service.json"), '{"recorded":true}\n');
    const calls: string[][] = [];
    const prepared = await prepareRepairPackage({
      configDir: mkdtempSync(join(tmpdir(), "atlas-repair-config-")),
      packageVersion: VERSION,
      packageImage: CORE_IMAGE,
      runCommand: fixture.runCommand(calls)
    });
    expect(calls[0]).toContain(`atlas-core@${VERSION}`);
    expect(calls[0]).toContain("--ignore-scripts");
    expect(readFileSync(join(prepared.packageRoot, "assets", "plugin-templates", "service.json"), "utf8")).toBe(
      '{"recorded":true}\n'
    );
    expect(readFileSync(join(prepared.packageRoot, "assets", "docker-compose.yml"))).toEqual(
      readFileSync(join(fixture.root, "package", "assets", "docker-compose.yml"))
    );
    expect(existsSync(join(prepared.packageRoot, "dist"))).toBe(false);
    prepared.cleanup();
    expect(existsSync(prepared.packageRoot)).toBe(false);
  });

  it("rejects a substituted release or linked archive before supplying repair assets", async () => {
    for (const options of [{ packageVersion: "0.1.7" }, { coreImage: POSTGRES_IMAGE }, { symlink: true }]) {
      const fixture = createPackageFixture(options);
      await expect(
        prepareRepairPackage({
          configDir: mkdtempSync(join(tmpdir(), "atlas-repair-config-")),
          packageVersion: VERSION,
          packageImage: CORE_IMAGE,
          runCommand: fixture.runCommand([])
        })
      ).rejects.toThrow(/does not match|symbolic or hard link/);
      expect(fixture.lastCandidate && existsSync(fixture.lastCandidate)).toBe(false);
    }
  });
});

describe("downloaded Core package bounds", () => {
  it.each(["size", "unpackedSize", "entryCount"])(
    "rejects oversized npm %s metadata before invoking tar",
    async (field) => {
      const fixture = createPackageFixture();
      const calls: string[][] = [];
      const run = fixture.runCommand(calls);
      await expect(
        prepareRepairPackage({
          configDir: mkdtempSync(join(tmpdir(), "atlas-repair-config-")),
          packageVersion: VERSION,
          packageImage: CORE_IMAGE,
          runCommand: async (command, args) => {
            const result = await run(command, args);
            if (command !== "npm") return result;
            const records = JSON.parse(result.stdout);
            records[0][field] = 128 * 1024 * 1024;
            return { ...result, stdout: JSON.stringify(records) };
          }
        })
      ).rejects.toThrow(/exceeds its limit/);
      expect(calls.some(([command]) => command === "tar")).toBe(false);
      expect(fixture.lastCandidate && existsSync(fixture.lastCandidate)).toBe(false);
    }
  );

  it("bounds decompression independently of npm's reported unpacked size", async () => {
    const fixture = createPackageFixture();
    const calls: string[][] = [];
    const run = fixture.runCommand(calls);
    await expect(
      prepareRepairPackage({
        configDir: mkdtempSync(join(tmpdir(), "atlas-repair-config-")),
        packageVersion: VERSION,
        packageImage: CORE_IMAGE,
        runCommand: async (command, args) => {
          const result = await run(command, args);
          if (command === "npm") {
            const destination = args[args.indexOf("--pack-destination") + 1] ?? "";
            writeFileSync(join(destination, `atlas-core-${VERSION}.tgz`), gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)));
          }
          return result;
        }
      })
    ).rejects.toThrow(/larger than|size|output/i);
    expect(calls.some(([command]) => command === "tar")).toBe(false);
  });

  it.each(["oversized-file", "too-many-entries"])("rejects actual tar %s despite small npm metadata", async (kind) => {
    const fixture = createPackageFixture();
    if (kind === "oversized-file") {
      writeFileSync(join(fixture.root, "package", "assets", "oversized.txt"), Buffer.alloc(8 * 1024 * 1024 + 1));
    }
    const calls: string[][] = [];
    const run = fixture.runCommand(calls);
    await expect(
      prepareRepairPackage({
        configDir: mkdtempSync(join(tmpdir(), "atlas-repair-config-")),
        packageVersion: VERSION,
        packageImage: CORE_IMAGE,
        runCommand: async (command, args) => {
          const result = await run(command, args);
          if (command === "npm" && kind === "too-many-entries") {
            const headers = Array.from({ length: 1025 }, (_, index) => {
              const header = Buffer.alloc(512);
              header.write(`package/entry-${index}`);
              header.write("0000644\0", 100);
              header.write("0000000\0", 108);
              header.write("0000000\0", 116);
              header.write("00000000000\0", 124);
              header.write("00000000000\0", 136);
              header.fill(32, 148, 156);
              header.write("0", 156);
              header.write("ustar\0", 257);
              header.write("00", 263);
              const checksum = header.reduce((sum, byte) => sum + byte, 0);
              header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
              return header;
            });
            const destination = args[args.indexOf("--pack-destination") + 1] ?? "";
            writeFileSync(
              join(destination, `atlas-core-${VERSION}.tgz`),
              gzipSync(Buffer.concat([...headers, Buffer.alloc(1024)]))
            );
          }
          return result;
        }
      })
    ).rejects.toThrow(/entry exceeds its size limit|too many entries/);
    expect(calls.some(([command]) => command === "tar")).toBe(false);
    expect(fixture.lastCandidate && existsSync(fixture.lastCandidate)).toBe(false);
  });
});

describe("legacy Core base import", () => {
  it("packs the exact old release, normalizes restart policy, pulls every base image, and leaves live state alone", async () => {
    const fixture = createPackageFixture({ extraFile: true });
    const configDir = mkdtempSync(join(tmpdir(), "atlas-legacy-config-"));
    mkdirSync(join(configDir, "base"));
    writeFileSync(join(configDir, "base", "sentinel"), "keep\n");
    writeFileSync(join(configDir, "state.json"), '{"schema":3}\n');
    const calls: string[][] = [];
    const pulled: string[] = [];

    const prepared = await prepareLegacyBase({
      configDir,
      packageVersion: VERSION,
      runCommand: fixture.runCommand(calls),
      pullImage: async (image) => {
        pulled.push(image);
        return receipt(image);
      }
    });

    expect(calls[0]?.slice(0, 2)).toEqual(["npm", "pack"]);
    expect(calls[0]).toContain("--ignore-scripts");
    expect(calls[0]).toContain("--json");
    expect(calls[0]).toContain("--pack-destination");
    expect(calls[0]).toContain(`atlas-core@${VERSION}`);
    expect(prepared.baseDeployment.coreImage).toBe(CORE_IMAGE);
    expect(prepared.baseDeployment.coreLocalImageId).toBe(`sha256:${"0".repeat(64)}`);
    expect(pulled).toEqual([CORE_IMAGE, POSTGRES_IMAGE, MINIO_CLIENT_IMAGE, MINIO_IMAGE]);
    expect(prepared.baseDeployment.images.map((image) => image.image_index)).toEqual(pulled);
    expect(prepared.baseDirectory).toContain(prepared.candidateDirectory);
    expect(readFileSync(join(prepared.baseDirectory, "docker-compose.yml"), "utf8")).toContain('restart: "no"');
    expect(readFileSync(join(prepared.baseDirectory, "docker-compose.yml"), "utf8")).not.toContain("unless-stopped");
    expect(existsSync(join(prepared.candidateDirectory, "unpacked", "package", "dist", "cli.js"))).toBe(false);
    expect(readFileSync(join(configDir, "base", "sentinel"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(configDir, "state.json"), "utf8")).toBe('{"schema":3}\n');
    expect(prepared.manifest.files.map((file) => file.path)).toEqual([
      "docker-compose.init.yml",
      "docker-compose.yml",
      "source_gateway.production.json"
    ]);

    prepared.cleanup();
    expect(existsSync(prepared.candidateDirectory)).toBe(false);
  });

  it("rejects package metadata that does not match the requested exact release", async () => {
    const fixture = createPackageFixture({ packageVersion: "0.1.7" });
    const configDir = mkdtempSync(join(tmpdir(), "atlas-legacy-config-"));
    const pulls: string[] = [];

    await expect(
      prepareLegacyBase({
        configDir,
        packageVersion: VERSION,
        runCommand: fixture.runCommand([]),
        pullImage: async (image) => {
          pulls.push(image);
          return receipt(image);
        }
      })
    ).rejects.toThrow(/does not match the requested version/);
    expect(pulls).toEqual([]);
    expect(fixture.lastCandidate && existsSync(fixture.lastCandidate)).toBe(false);

    const invalidImageFixture = createPackageFixture({ coreImage: "ghcr.io/the-drunken-coder/atlas-core:mutable" });
    await expect(
      prepareLegacyBase({
        configDir: mkdtempSync(join(tmpdir(), "atlas-legacy-config-")),
        packageVersion: VERSION,
        runCommand: invalidImageFixture.runCommand([]),
        pullImage: async (image) => receipt(image)
      })
    ).rejects.toThrow(/atlasCoreImage must be an immutable digest-pinned image/);
  });

  it("rejects links but ignores safe unselected package files", async () => {
    const symlinkFixture = createPackageFixture({ symlink: true });
    const symlinkConfig = mkdtempSync(join(tmpdir(), "atlas-legacy-config-"));
    await expect(
      prepareLegacyBase({
        configDir: symlinkConfig,
        packageVersion: VERSION,
        runCommand: symlinkFixture.runCommand([]),
        pullImage: async (image) => receipt(image)
      })
    ).rejects.toThrow(/symbolic or hard link/);

    const extraFixture = createPackageFixture({ extraFile: true });
    const extraConfig = mkdtempSync(join(tmpdir(), "atlas-legacy-config-"));
    const extraPrepared = await prepareLegacyBase({
      configDir: extraConfig,
      packageVersion: VERSION,
      runCommand: extraFixture.runCommand([]),
      pullImage: async (image) => receipt(image)
    });
    expect(existsSync(join(extraPrepared.baseDirectory, "dist"))).toBe(false);
    extraPrepared.cleanup();
    expect(existsSync(extraPrepared.candidateDirectory)).toBe(false);
  });

  it("rejects an image pull receipt that does not identify the requested immutable image", async () => {
    const fixture = createPackageFixture();
    const configDir = mkdtempSync(join(tmpdir(), "atlas-legacy-config-"));
    await expect(
      prepareLegacyBase({
        configDir,
        packageVersion: VERSION,
        runCommand: fixture.runCommand([]),
        pullImage: async (image) => receipt(image === CORE_IMAGE ? MINIO_IMAGE : image)
      })
    ).rejects.toThrow(/different image than/);
  });

  it("parses the production Compose Core variable with a spaced required message", async () => {
    const fixture = createPackageFixture({ productionAssets: true });
    const configDir = mkdtempSync(join(tmpdir(), "atlas-legacy-config-"));
    const pulled: string[] = [];

    const prepared = await prepareLegacyBase({
      configDir,
      packageVersion: VERSION,
      runCommand: fixture.runCommand([]),
      pullImage: async (image) => {
        pulled.push(image);
        return receipt(image);
      }
    });

    expect(pulled).toEqual(
      [CORE_IMAGE, PRODUCTION_MINIO_CLIENT_IMAGE, PRODUCTION_MINIO_IMAGE, PRODUCTION_POSTGRES_IMAGE].sort()
    );
    prepared.cleanup();
  });

  it("rejects mutable image scalars instead of silently skipping them", async () => {
    const fixture = createPackageFixture({ postgresImage: "postgres:15 # mutable" });
    await expect(
      prepareLegacyBase({
        configDir: mkdtempSync(join(tmpdir(), "atlas-legacy-config-")),
        packageVersion: VERSION,
        runCommand: fixture.runCommand([]),
        pullImage: async (image) => receipt(image)
      })
    ).rejects.toThrow(/immutable digest-pinned image/);

    const dynamicFixture = createPackageFixture({ coreExpression: "${OTHER_IMAGE:?image must be configured}" });
    await expect(
      prepareLegacyBase({
        configDir: mkdtempSync(join(tmpdir(), "atlas-legacy-config-")),
        packageVersion: VERSION,
        runCommand: dynamicFixture.runCommand([]),
        pullImage: async (image) => receipt(image)
      })
    ).rejects.toThrow(/unapproved dynamic image reference/);
  });
});

type PackageFixture = {
  root: string;
  lastCandidate?: string;
  runCommand: (calls: string[][]) => (command: string, args: readonly string[]) => Promise<LegacyCommandResult>;
};

function createPackageFixture(
  options: {
    packageVersion?: string;
    coreImage?: string;
    symlink?: boolean;
    extraFile?: boolean;
    productionAssets?: boolean;
    postgresImage?: string;
    coreExpression?: string;
  } = {}
): PackageFixture {
  const root = mkdtempSync(join(tmpdir(), "atlas-legacy-package-"));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "assets"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "atlas-core",
      version: options.packageVersion ?? VERSION,
      atlasCoreImage: options.coreImage ?? CORE_IMAGE
    })
  );
  if (options.productionAssets) {
    const sourceRoot = fileURLToPath(new URL("../assets/", import.meta.url));
    for (const file of ["docker-compose.yml", "docker-compose.init.yml", "source_gateway.production.json"]) {
      cpSync(join(sourceRoot, file), join(packageRoot, "assets", file));
    }
  } else {
    writeFileSync(
      join(packageRoot, "assets", "docker-compose.yml"),
      [
        "services:",
        "  api:",
        `    image: ${options.coreExpression ?? "${ATLAS_CORE_IMAGE:?ATLAS_CORE_IMAGE must be set}"}`,
        "    restart: unless-stopped",
        "  postgres:",
        `    image: ${options.postgresImage ?? POSTGRES_IMAGE}`,
        "  minio:",
        `    image: ${MINIO_IMAGE}`,
        "    restart: always",
        "  minio-init:",
        `    image: ${MINIO_CLIENT_IMAGE}`,
        "    restart: on-failure",
        ""
      ].join("\n")
    );
    writeFileSync(
      join(packageRoot, "assets", "docker-compose.init.yml"),
      ["services:", "  minio:", "    extends:", "      file: docker-compose.yml", "      service: minio", ""].join("\n")
    );
    writeFileSync(join(packageRoot, "assets", "source_gateway.production.json"), '{"listen_address":":8080"}\n');
  }
  if (options.symlink) symlinkSync("../package.json", join(packageRoot, "assets", "link.json"));
  if (options.extraFile) {
    mkdirSync(join(packageRoot, "dist"));
    writeFileSync(join(packageRoot, "dist", "cli.js"), "process.exit(0);\n");
    writeFileSync(join(packageRoot, "README.md"), "Legacy package documentation\n");
  }

  const fixture: PackageFixture = {
    root,
    runCommand: (calls) => async (command, args) => {
      calls.push([command, ...args]);
      if (command === "npm") {
        const destination = args[args.indexOf("--pack-destination") + 1];
        if (!destination) throw new Error("test fixture missing pack destination");
        mkdirSync(destination, { recursive: true });
        const archivePath = join(destination, `atlas-core-${VERSION}.tgz`);
        execFileSync("tar", ["--format=ustar", "-czf", archivePath, "-C", root, "package"]);
        fixture.lastCandidate = destination;
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              name: "atlas-core",
              version: VERSION,
              filename: `atlas-core-${VERSION}.tgz`,
              size: statSync(archivePath).size,
              unpackedSize: 1024 * 1024,
              entryCount: 20
            }
          ]),
          stderr: ""
        };
      }
      try {
        const stdout = execFileSync(command, [...args], { encoding: "utf8" });
        return { status: 0, stdout, stderr: "" };
      } catch (error) {
        const result = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
        return {
          status: result.status ?? 1,
          stdout: result.stdout?.toString() ?? "",
          stderr: result.stderr?.toString() ?? ""
        };
      }
    }
  };
  return fixture;
}

function receipt(image: string): ImageReceipt {
  const localId = image === CORE_IMAGE ? `sha256:${"0".repeat(64)}` : `sha256:${"1".repeat(64)}`;
  return {
    image_index: image,
    platform_manifest_sha256: image.slice(image.lastIndexOf("@") + 1),
    local_image_id: localId
  };
}
