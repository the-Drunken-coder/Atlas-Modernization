import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repositoryRoot, "scripts", "plugin-release.mjs");
const image = `ghcr.io/the-drunken-coder/atlas-building-scan@sha256:${"a".repeat(64)}`;

function runCandidate(manifest) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plugin-candidate-"));
  const bin = join(directory, "bin");
  const docker = join(bin, "docker");
  const curl = join(bin, "curl");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    docker,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run") process.stdout.write("abcdef123456\\n");
else if (args[0] === "port") process.stdout.write("0.0.0.0:12345\\n");
else if (args[0] === "network" && args[1] === "create") process.stdout.write("network123\\n");
else if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) process.stdout.write("");
else process.exit(1);
`
  );
  writeFileSync(
    curl,
    `#!/usr/bin/env node
const url = process.argv.at(-1);
if (url.endsWith("/manifest")) process.stdout.write(process.env.CANDIDATE_MANIFEST + "\\n200\\n");
else if (url.endsWith("/health")) process.stdout.write('{"status":"ok"}\\n200\\n');
else process.stdout.write("404\\n");
`
  );
  chmodSync(docker, 0o755);
  chmodSync(curl, 0o755);
  try {
    return spawnSync(process.execPath, [script, "check-candidate", "building_scan", image], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CANDIDATE_MANIFEST: JSON.stringify(manifest) }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runReleaseDocument(imageReference) {
  return spawnSync(process.execPath, [script, "release-document", "building_scan", "0.1.0", imageReference], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env
  });
}

test("embeds the strict source connector and generated SDK Protocol revision", () => {
  const result = runReleaseDocument(image);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.source_connector.id, "building_scan");
  assert.deepEqual(document.source_connector.secret_headers, {});
  assert.deepEqual(document.source_connector.egress, {
    allow_private: false,
    allow_loopback: false,
    allow_link_local: false
  });
  assert.match(document.atlas_protocol_revision, /^sha256:[0-9a-f]{64}$/u);
});

test("accepts a candidate only when its private manifest matches the authored interaction contract", () => {
  const result = runCandidate({
    plugin_id: "building_scan",
    display_name: "Building Scan",
    core_to_plugin_protocol_major: 1,
    operations: [
      {
        operation_id: "search_buildings",
        display_name: "Search buildings",
        timeout_ms: 15_000,
        interaction: { kind: "map_area" }
      }
    ]
  });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects candidate manifest fields that can change the managed query-only contract", () => {
  const result = runCandidate({
    plugin_id: "building_scan",
    display_name: "Building Scan",
    core_to_plugin_protocol_major: 1,
    tool_asset_id: "plugin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    operations: [
      {
        operation_id: "search_buildings",
        display_name: "Search buildings",
        timeout_ms: 15_000,
        interaction: { kind: "map_area" }
      }
    ]
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not expose tool_asset_id/);
});
