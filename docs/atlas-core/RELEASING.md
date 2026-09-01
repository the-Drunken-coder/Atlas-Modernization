# Releasing Atlas Core

Implementation status: this guide describes the current v1 workflow, which still releases catalog Plugin images with
Core. [`2026-09-01-plugins-release-independently-from-atlas-core.md`](../design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md)
supersedes that coupling. Keep following this guide until the independent Plugin workflow and catalog are implemented;
then this guide must remove every Plugin build, digest, visibility, and package-asset step. That first decoupled Core
update must refuse to proceed while a bundled-v1 Plugin remains enabled; `docs/atlas-plugins/MANAGEMENT.md` defines the
greenfield transition.

After that transition, every immutable npm Core version must continue carrying its complete base deployment bundle,
including the declarative templates and placeholder schema used to generate Plugin deployment files. The host manager may
fetch `atlas-core@<installed Core version>` without installing or executing it to repair lost bundle bytes, and accepts
the candidate only when its complete bundle hash matches deployment state.

The first independent-release package must change every retained production base service and the Plugin generation
template to Compose `restart: "no"`. Package validation rejects another policy. Its disposable-host acceptance test must
restart the Docker daemon during a pending transaction, prove that no base or Plugin container starts automatically, then
prove that `atlas-core start` recovers the journal before starting the verified composition.

Atlas Core uses one version for the npm CLI, Core and catalog Plugin images, git tag, and GitHub Release. A normal
release starts from `main`. Its coordinator stays open until the automatically queued immutable-tag run publishes and
verifies the release.

## Normal release

1. Open **Actions**, select **Release Atlas Core**, and choose the `main` branch.
2. Select **Run workflow**. Enter the new stable SemVer without a leading `v`, and leave advanced recovery disabled.
   Leave the internal coordinator run ID empty. Prerelease versions are not supported.
3. Wait for **Draft and validate changelog** and **Build approval artifact** to finish.
4. Read the run summary. Download `atlas-core-<version>` and review `release-artifacts/release.diff`, the release notes,
   and the packed archive.
5. Grant the release approval for **Run approved release phase**. This permits candidate image publication, the
   disposable-host acceptance test, the atomic release commit and tag push, and automatic public publication from that
   immutable tag.
6. Keep the coordinator run open. It finds the queued tag run, waits for it, and fails if tag-bound publication fails.
   The tag run verifies the coordinator's release authorization, rebuilds the final package from the immutable release
   commit, promotes the reviewed image digests, publishes npm with provenance, and makes the GitHub Release public and
   latest.
7. Confirm the npm version, GHCR image tags, and GitHub Release are public. Confirm every new catalog Plugin image is
   also anonymously pullable.

The main run and tag run share the coordinator run ID in their titles. The main run contains the only approval and links
to the tag run that completed publication.

## Moving from the two-approval workflow

Before the first release with this workflow:

1. Create and install the dedicated Atlas Core release GitHub App described below.
2. Add both required release-tag rulesets described below.
3. Keep the existing `release` environment, its required reviewer, and its `main` and `atlas-core-v*` policies.
4. Create `release-publish`, restrict it to tags matching `atlas-core-v*`, and do not add a required reviewer.
5. After this workflow is on `main`, change the npm trusted publisher environment from `release` to `release-publish`.
6. If the bootstrap `NPM_TOKEN` still exists, move it to `release-publish`.

Do not remove the reviewer from `release`. The coordinator uses that environment for the only release approval.

## Required release-tag authority

Create a GitHub App dedicated to Atlas Core releases. Install it only on this repository and grant these repository
permissions:

- Contents: read and write.

Record its client ID as the repository variable `ATLAS_CORE_RELEASE_APP_CLIENT_ID` and its private key as the `release`
environment secret `ATLAS_CORE_RELEASE_APP_PRIVATE_KEY`. Do not grant the App Administration permission.

Create two active tag rulesets targeting only `refs/tags/atlas-core-v*`:

1. `Atlas Core release tag creation` restricts creation and grants `always` bypass only to the dedicated release App.
   It must not restrict updates or deletions because its App bypass would apply to those rules too.
2. `Atlas Core release tag immutability` restricts updates and deletions, does not restrict creation, and has an empty
   bypass list.

Do not grant the repository-wide GitHub Actions App, a user, a team, or a repository role bypass. Verify the two bypass
lists in repository settings: the creation ruleset contains exactly the release App, and the immutability ruleset is
empty. GitHub withholds bypass actors from API credentials that cannot edit the ruleset; granting that power to the
release App would defeat this boundary. The workflow instead checks the active rule names, targets, and restrictions
before preparation and again after approval. It then mints a short-lived App token that can write repository contents but
cannot change rulesets. The push itself fails unless that App has creation authority, and no routine credential can move
or delete an existing release tag.

## What the workflow checks

Before release approval, the workflow:

- gives the relevant git history to `opencode-go/gpt-5.6-luna` and accepts only its `CHANGELOG.md` edit;
- versions and packs the npm CLI in a fresh job;
- runs the Core CLI checks, release helper tests, Protocol checks and tests, Core tests, and npm audit;
- restricts the prepared diff to release-owned files.

After approval, it builds `linux/amd64` and `linux/arm64` Core and catalog Plugin images, verifies their labels and
digests, records the immutable digests in the package, and exercises the packed CLI on a disposable Docker host. The
acceptance test covers refusal to adopt unknown containers, initialization, start, diagnostics, status, update, reset,
and stop while confirming that ordinary stop preserves both durable volumes.

The workflow refuses to push if `main` moved. The reviewed job checks both tag rulesets, mints the dedicated release App
credential, then pushes the release commit and tag atomically. The coordinator dispatches the tagged run through GitHub's
API and records the exact returned child run ID. Its authorization record binds the coordinator run ID, child run ID,
version, tag, source commit, and release commit. The tagged run must download that exact record, match its own run ID, and
verify the coordinator was the expected workflow dispatched from `main` at the source commit before it can publish. It
rebuilds the npm archive from the release commit, verifies anonymous access to every exact image, checks npm integrity,
signatures, and provenance, then publishes the GitHub Release.

A tag run without a coordinator ID first waits for reviewer approval in `release`. After that gate, all tag-bound npm
publication runs in `release-publish`, so automatic and manual recovery share the one npm trusted-publisher identity.

## If the review needs changes

Before release approval, reject or cancel the run. Correct `CHANGELOG.md` on `main`, then dispatch the same version
again. If the newest changelog section already matches that version, the workflow validates and preserves it instead of
asking OpenCode to write it again.

After the release commit and tag exist, never move or replace the tag. Rerun a failed tagged job when the existing
artifacts still match. If the release itself is wrong after public publication, prepare a new patch release rather than
rewriting the published version.

## New GHCR packages

GitHub creates a new Core or catalog Plugin package as private. The tagged run stops before npm publication if any exact
image digest is not anonymously pullable. Make each new package public, then rerun the failed tagged job. Existing image
digests, the release commit, and the tag remain unchanged.

## First-time setup

1. Create and install the dedicated release GitHub App. Add the repository variable and the private-key environment
   secret described above.
2. Create both active Atlas Core release-tag rulesets described above.
3. Create a GitHub environment named `release`. Restrict it to `main` and tags matching `atlas-core-v*`, then add a
   required reviewer.
4. Create a GitHub environment named `release-publish`. Restrict it to tags matching `atlas-core-v*`. Do not add a
   required reviewer. The workflow reaches this environment only through an immutable tag created by the approved
   coordinator.
5. Add `OPENCODE_API_KEY` as a repository Actions secret. Use an OpenCode Go API key, not a copied local auth file.
6. Create a short-lived npm granular access token with read/write package access and **Bypass 2FA**. Because
   `atlas-core` does not exist yet, the first token may need access to all packages owned by the publishing account.
   Store it as an environment secret named `NPM_TOKEN` in `release-publish`.
7. Give Actions the read and write workflow permission so the workflow can dispatch the tagged run and wait for its
   result. If a ruleset protects `main`, grant the dedicated release App the narrow bypass needed for the atomic push.

npm cannot configure trusted publishing until the first publication creates the package. Keep the bootstrap token's
expiration short and do not reuse it elsewhere. The first tagged run stops if a newly created GHCR package is private;
follow the new-package instructions above and rerun the failed job.

## Finish trusted publishing setup

After the first npm publication:

1. Confirm `atlas-core` is public.
2. Confirm the Core and every first-party catalog Plugin GHCR package are public.
3. Configure npm trusted publishing with:
   - organization or user: `the-Drunken-coder`
   - repository: `Atlas-Modernization`
   - workflow filename: `release-atlas-core.yml`
   - environment: `release-publish`
   - allowed action: `npm publish`
4. Delete the `NPM_TOKEN` GitHub environment secret and revoke the bootstrap token in npm.
5. Require two-factor authentication and disallow token-based publication in the npm package settings.

Later releases require no npm token.

## Recovery after the tag exists

If automatic dispatch fails after the atomic push, dispatch **Release Atlas Core** manually from
`atlas-core-v<version>`. Leave the internal coordinator run ID empty. Do not rerun the original main job after it has
pushed the release commit and tag. Manual recovery waits for approval in `release`, then publishes from
`release-publish`. Tagged-job reruns recognize the exact release commit, pinned digests, image visibility, npm integrity,
provenance, release notes, and assets. They repair an incomplete draft release and reject mismatched published artifacts.

Use advanced recovery only when npm already contains the exact version with matching integrity, but the immutable-tag
workflow cannot finish because its tagged workflow contains a bug fixed later on `main`:

1. Dispatch **Release Atlas Core** from `main` for the same version.
2. Enable **Advanced recovery only, when this exact npm version already exists**.
3. Review the rebuilt artifact and grant the release approval.

Recovery keeps the existing tag fixed. It verifies the release commit, package files, npm integrity, pinned images,
tag-bound npm provenance, registry signature, release notes, and assets before publishing a draft GitHub Release. It
cannot publish a missing npm version. If npm does not contain the version, leave recovery disabled and run the tagged
workflow so publication provenance remains bound to the immutable tag.
