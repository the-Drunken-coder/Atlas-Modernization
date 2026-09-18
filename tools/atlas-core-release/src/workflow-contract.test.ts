import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const publication = readFileSync(join(repository, ".github/workflows/release-atlas-core.yml"), "utf8");
const request = readFileSync(join(repository, ".github/workflows/request-atlas-core-release.yml"), "utf8");
const sourcePackage = JSON.parse(readFileSync(join(repository, "surfaces/core-cli/package.json"), "utf8")) as {
  version?: unknown;
  atlasCoreImage?: unknown;
};
const publisher = jobBlock(publication, "publish");
const completedVerifier = jobBlock(publication, "verify-completed");
const reservation = jobBlock(request, "reserve-tag");
const requestValidation = jobBlock(request, "validate");

test("publication is tag-triggered, manually recoverable, and defaults to no permissions", () => {
  assert.match(publication, /push:\n\s+tags:\n\s+- atlas-core-v\*/u);
  assert.match(publication, /workflow_dispatch:\n/u);
  assert.match(publication, /permissions: \{\}/u);
});

test("only the publisher receives OIDC under the stable trusted-publisher environment", () => {
  assert.match(publisher, /environment:\n\s+name: release-publish/u);
  assert.match(publisher, /permissions:[\s\S]*?id-token: write/u);
  assert.equal(publication.match(/id-token: write/gu)?.length, 1);
  assert.doesNotMatch(publication, /NPM_TOKEN|create-github-app-token/u);
});

test("publication runs the typed reconciler and requires an immutable release seal", () => {
  assert.match(publisher, /reconcile-publication/u);
  assert.doesNotMatch(completedVerifier, /reconcile-publication/u);
  assert.match(completedVerifier, /verify-completed-publication/u);
  assert.match(publication, /gh release verify/u);
  assert.doesNotMatch(publication, /docker buildx imagetools create --tag/u);
  assert.doesNotMatch(publication, /npm publish "\$package"/u);
});

test("the request workflow isolates the release App in the tag job", () => {
  assert.match(reservation, /name: release-commit/u);
  assert.equal(request.match(/create-github-app-token/gu)?.length, 1);
  assert.match(reservation, /client-id: \$\{\{ vars\.ATLAS_CORE_RELEASE_APP_CLIENT_ID \}\}/u);
  assert.match(reservation, /permission-administration: read/u);
  assert.match(reservation, /require-atlas-core-tag-rulesets/u);
  assert.match(reservation, /require-immutable-releases/u);
  assert.doesNotMatch(requestValidation, /require-atlas-core-tag-rulesets|require-immutable-releases/u);
  assert.doesNotMatch(reservation, /npm (?:ci|run|test|publish)/u);
  assert.doesNotMatch(request, /git push[^\n]*main/u);
});

test("checked-in package metadata is explicitly unreleased", () => {
  assert.equal(sourcePackage.version, "0.0.0-dev");
  assert.equal(sourcePackage.atlasCoreImage, null);
});

function jobBlock(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const remaining = workflow.slice(start + 1);
  const next = remaining.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  return next === -1 ? remaining : remaining.slice(0, next + 1);
}
