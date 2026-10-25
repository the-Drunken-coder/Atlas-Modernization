import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copyRetainedBundle, hashRetainedBundle, verifyRetainedBundle } from "../src/retained-bundle.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "atlas-bundle-test-"));
}

function writeSourceBundle(): { source: string; files: string[] } {
  const source = temporaryDirectory();
  mkdirSync(join(source, "plugin-templates"));
  writeFileSync(
    join(source, "docker-compose.yml"),
    'services:\n  api:\n    volumes: ["./source_gateway.production.json:/app/source.json:ro"]\n'
  );
  writeFileSync(
    join(source, "docker-compose.init.yml"),
    'services:\n  minio:\n    extends: { file: "docker-compose.yml", service: minio }\n'
  );
  writeFileSync(join(source, "source_gateway.production.json"), '{"listen_address":":8080"}\n');
  writeFileSync(join(source, "plugin-templates", "schema.json"), '{"placeholders":[]}\n');
  return {
    source,
    files: [
      "docker-compose.yml",
      "docker-compose.init.yml",
      "source_gateway.production.json",
      "plugin-templates/schema.json"
    ]
  };
}

describe("retained bundle", () => {
  it("accepts the current production Compose files without treating image commands as host files", () => {
    const source = join(fileURLToPath(new URL("..", import.meta.url)), "assets");
    const target = join(temporaryDirectory(), "base");
    const manifest = copyRetainedBundle({
      sourceRoot: source,
      targetRoot: target,
      files: ["docker-compose.yml", "docker-compose.init.yml", "source_gateway.production.json"],
      composeFiles: ["docker-compose.yml", "docker-compose.init.yml"]
    });
    verifyRetainedBundle(target, manifest);
  });

  it("copies a complete candidate, hashes paths and bytes deterministically, and verifies it", () => {
    const { source, files } = writeSourceBundle();
    const target = join(temporaryDirectory(), "base");
    const manifest = copyRetainedBundle({
      sourceRoot: source,
      targetRoot: target,
      files,
      requiredFiles: ["docker-compose.yml", "plugin-templates/schema.json"],
      composeFiles: ["docker-compose.yml"]
    });
    expect(manifest.bundleSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.files.map((file) => file.path)).toEqual([...files].sort());
    verifyRetainedBundle(target, manifest);
    expect(hashRetainedBundle(target)).toBe(manifest.bundleSha256);
  });

  it("removes group and world write permissions from copied package files", () => {
    const { source, files } = writeSourceBundle();
    const target = join(temporaryDirectory(), "base");
    for (const file of files) chmodSync(join(source, file), 0o664);
    const manifest = copyRetainedBundle({ sourceRoot: source, targetRoot: target, files });
    expect(manifest.files.map((file) => file.mode)).toEqual(files.map(() => 0o644));
    expect(manifest.bundleSha256).toBe(hashRetainedBundle(source));
    verifyRetainedBundle(target, manifest);
  });

  it("repairs a changed retained bundle only after validating the candidate", () => {
    const { source, files } = writeSourceBundle();
    const target = join(temporaryDirectory(), "base");
    const first = copyRetainedBundle({ sourceRoot: source, targetRoot: target, files });
    writeFileSync(join(target, "source_gateway.production.json"), "corrupt\n");
    expect(() => verifyRetainedBundle(target, first)).toThrow(/hash check/);
    const second = copyRetainedBundle({ sourceRoot: source, targetRoot: target, files });
    expect(second.bundleSha256).toBe(first.bundleSha256);
    expect(readFileSync(join(target, "source_gateway.production.json"), "utf8")).toContain("listen_address");
    verifyRetainedBundle(target, second);
  });

  it("rejects missing Compose references, path escapes, symlinks, and missing required files", () => {
    const { source, files } = writeSourceBundle();
    const target = join(temporaryDirectory(), "base");
    expect(() =>
      copyRetainedBundle({
        sourceRoot: source,
        targetRoot: target,
        files: files.filter((path) => path !== "source_gateway.production.json"),
        composeFiles: ["docker-compose.yml"]
      })
    ).toThrow(/references missing/);
    expect(() =>
      copyRetainedBundle({ sourceRoot: source, targetRoot: target, files, requiredFiles: ["absent.json"] })
    ).toThrow(/missing required/);
    expect(() =>
      copyRetainedBundle({ sourceRoot: source, targetRoot: target, files: [...files, "../outside"] })
    ).toThrow(/escapes/);
    symlinkSync(join(source, "source_gateway.production.json"), join(source, "link.json"));
    expect(() => copyRetainedBundle({ sourceRoot: source, targetRoot: target, files: ["link.json"] })).toThrow(
      /symbolic link/
    );
  });

  it.each([
    ["multiline mount", 'services:\n  api:\n    volumes:\n      - "./extra.json:/app/config.json:ro"\n'],
    [
      "long bind",
      "services:\n  api:\n    volumes:\n      - type: bind\n        source: extra.json\n        target: /app/config.json\n"
    ],
    ["build Dockerfile", "services:\n  api:\n    build: {context: ., dockerfile: extra.json}\n"],
    ["scalar env_file", "services:\n  api:\n    env_file: extra.json\n"],
    ["list env_file", "services:\n  api:\n    env_file:\n      - extra.json\n"],
    ["long env_file", "services:\n  api:\n    env_file:\n      - path: extra.json\n"],
    ["config", "configs:\n  settings:\n    file: extra.json\nservices: {}\n"],
    ["secret", "secrets:\n  credentials:\n    file: extra.json\nservices: {}\n"],
    ["extends", "services:\n  api:\n    extends: {file: extra.json, service: base}\n"],
    [
      "merged alias",
      'x-base: &base\n  volumes: ["./extra.json:/app/config.json:ro"]\nservices:\n  api:\n    <<: *base\n'
    ]
  ])("checks %s dependencies before replacing the previous bundle", (_name, compose) => {
    const { source, files } = writeSourceBundle();
    const target = join(temporaryDirectory(), "base");
    const previous = copyRetainedBundle({ sourceRoot: source, targetRoot: target, files });
    writeFileSync(join(source, "docker-compose.yml"), compose);
    const options = { sourceRoot: source, targetRoot: target, files, composeFiles: ["docker-compose.yml"] };

    expect(() => copyRetainedBundle(options)).toThrow(/references missing file extra\.json/);
    verifyRetainedBundle(target, previous);

    writeFileSync(join(source, "extra.json"), "{}\n");
    const complete = copyRetainedBundle({ ...options, files: [...files, "extra.json"] });
    verifyRetainedBundle(target, complete);
  });

  it("checks every file in a relative directory bind", () => {
    const { source, files } = writeSourceBundle();
    mkdirSync(join(source, "config"));
    writeFileSync(join(source, "config", "one.json"), "{}\n");
    writeFileSync(join(source, "config", "two.json"), "{}\n");
    writeFileSync(join(source, "docker-compose.yml"), 'services:\n  api:\n    volumes: ["./config:/app/config:ro"]\n');
    const options = {
      sourceRoot: source,
      targetRoot: join(temporaryDirectory(), "base"),
      files: [...files, "config/one.json"],
      composeFiles: ["docker-compose.yml"]
    };
    expect(() => copyRetainedBundle(options)).toThrow(/references missing file config[/\\]two\.json/);
    const complete = copyRetainedBundle({ ...options, files: [...options.files, "config/two.json"] });
    verifyRetainedBundle(options.targetRoot, complete);
  });

  it("ignores optional env files and container paths but rejects a relative bind escaping the bundle", () => {
    const { source, files } = writeSourceBundle();
    const options = {
      sourceRoot: source,
      targetRoot: join(temporaryDirectory(), "base"),
      files,
      composeFiles: ["docker-compose.yml"]
    };
    writeFileSync(
      join(source, "docker-compose.yml"),
      `services:
  api:
    command: ["./container-only"]
    volumes: ["data:/app/data", "/app/cache"]
    env_file:
      - path: optional.env
        required: false
`
    );
    const previous = copyRetainedBundle(options);
    writeFileSync(
      join(source, "docker-compose.yml"),
      'services:\n  api:\n    volumes:\n      - "../outside:/app/config:ro"\n'
    );
    expect(() => copyRetainedBundle(options)).toThrow(/escapes its root/);
    verifyRetainedBundle(options.targetRoot, previous);
  });

  it("rejects extra files in a bundle because the hash covers the complete file set", () => {
    const { source, files } = writeSourceBundle();
    const target = join(temporaryDirectory(), "base");
    const manifest = copyRetainedBundle({ sourceRoot: source, targetRoot: target, files });
    writeFileSync(join(target, "unexpected.json"), "unexpected\n");
    expect(() => verifyRetainedBundle(target, manifest)).toThrow(/file set/);
    expect(existsSync(join(target, "unexpected.json"))).toBe(true);
  });
});
