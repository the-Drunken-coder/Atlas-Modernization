import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixtureCatalogPath = join(
  repositoryRoot,
  "packages/protocol/conformance/tasking/fixtures/catalog.json",
);
const fixtureManifestPath = join(
  repositoryRoot,
  "packages/protocol/conformance/tasking/fixtures/manifest.json",
);
const fixtureCatalogText = readFileSync(fixtureCatalogPath, "utf8");

export const taskFixtureCatalog = JSON.parse(fixtureCatalogText);
export const taskFixtureManifest = JSON.parse(
  readFileSync(fixtureManifestPath, "utf8"),
);
export const taskFixtureQueuedCommand = "fixture.queued";
export const taskFixtureVariant = {
  name: "tasking-conformance-catalog-overlay",
  catalog: "packages/protocol/conformance/tasking/fixtures/catalog.json",
  manifest: "packages/protocol/conformance/tasking/fixtures/manifest.json",
  scope: "test-only compile-time Core catalog overlay",
};

export function prepareTaskFixture({ artifacts }) {
  const fixtureDirectory = mkdtempSync(
    join(tmpdir(), "atlas-acceptance-task-fixture-"),
  );
  try {
    chmodSync(fixtureDirectory, 0o755);
    const replacementPath = join(fixtureDirectory, "command_catalog.go");
    const overlayPath = join(fixtureDirectory, "overlay.json");
    const replacementTarget =
      "/packages/protocol/generated/go/atlasprotocol/command_catalog.go";
    const replacementSource = "/acceptance-task-fixture/command_catalog.go";
    writeFileSync(
      replacementPath,
      "// Code generated for the Atlas Task acceptance fixture. DO NOT EDIT.\n\n" +
        "package atlasprotocol\n\n" +
        "// CommandCatalogJSON is the tasking conformance catalog embedded only in this acceptance Core variant.\n" +
        `const CommandCatalogJSON = ${JSON.stringify(fixtureCatalogText)}\n`,
      { mode: 0o644 },
    );
    writeFileSync(
      overlayPath,
      `${JSON.stringify({ Replace: { [replacementTarget]: replacementSource } }, null, 2)}\n`,
      {
        mode: 0o644,
      },
    );
    chmodSync(replacementPath, 0o644);
    chmodSync(overlayPath, 0o644);

    const metadata = {
      ...taskFixtureVariant,
      catalog: {
        source: taskFixtureVariant.catalog,
        sha256: sha256(fixtureCatalogText),
        commands: taskFixtureCatalog.map(({ command }) => command),
      },
      manifest: {
        source: taskFixtureVariant.manifest,
        sha256: sha256(readFileSync(fixtureManifestPath)),
        commands: taskFixtureManifest.map(({ command }) => command),
      },
      overlay: { target: replacementTarget, source: replacementSource },
      cleanup: "temporary fixture directory removed after the acceptance run",
    };
    writeFileSync(
      join(artifacts, "task-fixture.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    return {
      environment: { ATLAS_ACCEPTANCE_TASK_FIXTURE_DIR: fixtureDirectory },
      metadata,
      cleanup: () => rmSync(fixtureDirectory, { force: true, recursive: true }),
    };
  } catch (error) {
    rmSync(fixtureDirectory, { force: true, recursive: true });
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
