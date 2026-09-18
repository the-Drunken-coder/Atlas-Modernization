import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const publication = readFileSync(join(repository, ".github/workflows/release-atlas-core.yml"), "utf8");
const request = readFileSync(join(repository, ".github/workflows/request-atlas-core-release.yml"), "utf8");
const tagRulesetGuard = readFileSync(join(repository, ".github/scripts/require-atlas-core-tag-rulesets.sh"), "utf8");
const sourcePackage = JSON.parse(readFileSync(join(repository, "surfaces/core-cli/package.json"), "utf8")) as {
  version?: unknown;
  atlasCoreImage?: unknown;
};
const publisher = jobBlock(publication, "publish");
const completedVerifier = jobBlock(publication, "verify-completed");
const reservation = jobBlock(request, "reserve-tag");
const requestValidation = jobBlock(request, "validate");
const trustedCheckout = stepBlock(reservation, "Checkout trusted release control");
const prepareTag = stepBlock(reservation, "Prepare the annotated tag without release credentials");
const inspectionCredential = stepBlock(reservation, "Mint read-only release inspection credential");
const recheckProtections = stepBlock(reservation, "Recheck release protections with the release App");
const tagCredential = stepBlock(reservation, "Mint tag-only release credential");
const createTag = stepBlock(reservation, "Create or verify annotated release tag");

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
  assert.equal(request.match(/create-github-app-token/gu)?.length, 2);
  assert.match(reservation, /client-id: \$\{\{ vars\.ATLAS_CORE_RELEASE_APP_CLIENT_ID \}\}/u);
  assert.match(inspectionCredential, /permission-administration: read/u);
  assert.match(inspectionCredential, /permission-contents: read/u);
  assert.doesNotMatch(inspectionCredential, /permission-contents: write/u);
  assert.match(tagCredential, /permission-contents: write/u);
  assert.doesNotMatch(tagCredential, /permission-administration/u);
  assert.match(trustedCheckout, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(trustedCheckout, /persist-credentials: false/u);
  assert.match(reservation, /require-atlas-core-tag-rulesets/u);
  assert.match(reservation, /ATLAS_CORE_RELEASE_CLI:.*atlas-core-tag-tool\/cli\.js/u);
  assert.match(reservation, /require-immutable-releases/u);
  assert.match(createTag, /GIT_CONFIG_VALUE_0=.*authorization/u);
  assert.match(createTag, /GH_TOKEN: \$\{\{ steps\.app-tag-token\.outputs\.token \}\}/u);
  assert.doesNotMatch(requestValidation, /require-atlas-core-tag-rulesets|require-immutable-releases/u);
  assert.doesNotMatch(reservation, /ref: \$\{\{ needs\.validate\.outputs\.source_sha \}\}/u);
  assert.doesNotMatch(trustedCheckout, /token: \$\{\{ steps\.app-/u);
  assert.doesNotMatch(reservation, /persist-credentials: true|git config[^\n]*extraheader/u);
  assert.ok(
    reservation.indexOf("Checkout trusted release control") <
      reservation.indexOf("Mint read-only release inspection credential")
  );
  assert.ok(reservation.indexOf(prepareTag) < reservation.indexOf(inspectionCredential));
  assert.ok(reservation.indexOf(recheckProtections) < reservation.indexOf(tagCredential));
  assert.doesNotMatch(reservation, /npm (?:ci|run|test|publish)/u);
  assert.doesNotMatch(request, /git push[^\n]*main/u);
});

test("tag ruleset checks pin the intended App and can use the isolated CLI", () => {
  assert.match(tagRulesetGuard, /if \[ "\$#" -ne 2 \]/u);
  assert.match(tagRulesetGuard, /--release-app-id "\$release_app_id"/u);
  assert.match(tagRulesetGuard, /ATLAS_CORE_RELEASE_CLI:-/u);
  const appIdBinding = /RELEASE_APP_ID:\s*\$\{\{\s*vars\.ATLAS_CORE_RELEASE_APP_ID\s*\}\}/u;
  assert.match(jobBlock(publication, "inspect"), appIdBinding);
  assert.match(publisher, appIdBinding);
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

function stepBlock(job: string, name: string): string {
  const start = job.indexOf(`\n      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step ${name}`);
  const remaining = job.slice(start + 1);
  const next = remaining.slice(1).search(/\n      - name:/u);
  return next === -1 ? remaining : remaining.slice(0, next + 1);
}
