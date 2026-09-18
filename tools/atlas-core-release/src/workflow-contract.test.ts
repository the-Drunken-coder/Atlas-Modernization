import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const publication = readFileSync(join(repository, ".github/workflows/release-atlas-core.yml"), "utf8");
const request = readFileSync(join(repository, ".github/workflows/request-atlas-core-release.yml"), "utf8");
const sourcePackage = JSON.parse(readFileSync(join(repository, "surfaces/core-cli/package.json"), "utf8")) as {
  version?: unknown;
  atlasCoreImage?: unknown;
};

test("publication is tag-triggered, manually recoverable, and defaults to no permissions", () => {
  assert.match(publication, /push:\n\s+tags:\n\s+- atlas-core-v\*/u);
  assert.match(publication, /workflow_dispatch:\n/u);
  assert.match(publication, /permissions: \{\}/u);
});

test("only the publisher receives OIDC under the stable trusted-publisher environment", () => {
  assert.equal(publication.match(/id-token: write/gu)?.length, 1);
  assert.equal(publication.match(/name: release-publish/gu)?.length, 1);
  assert.doesNotMatch(publication, /NPM_TOKEN|create-github-app-token/u);
});

test("publication runs the typed reconciler and requires an immutable release seal", () => {
  assert.match(publication, /reconcile-publication/u);
  assert.match(publication, /require-immutable-releases/u);
  assert.match(publication, /gh release verify/u);
  assert.doesNotMatch(publication, /docker buildx imagetools create --tag/u);
  assert.doesNotMatch(publication, /npm publish "\$package"/u);
});

test("the request workflow isolates the release App in the tag job", () => {
  assert.match(request, /name: release-commit/u);
  assert.equal(request.match(/create-github-app-token/gu)?.length, 1);
  const tagJob = request.slice(request.indexOf("  reserve-tag:"));
  assert.doesNotMatch(tagJob, /npm (?:ci|run|test|publish)/u);
  assert.doesNotMatch(request, /git push[^\n]*main/u);
});

test("checked-in package metadata is explicitly unreleased", () => {
  assert.equal(sourcePackage.version, "0.0.0-dev");
  assert.equal(sourcePackage.atlasCoreImage, null);
});
