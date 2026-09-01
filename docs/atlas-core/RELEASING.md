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

1. Add the required release-tag ruleset described below.
2. Keep the existing `release` environment, its required reviewer, and its `main` and `atlas-core-v*` policies.
3. Create `release-publish`, restrict it to tags matching `atlas-core-v*`, and do not add a required reviewer.
4. After this workflow is on `main`, change the npm trusted publisher environment from `release` to `release-publish`.
5. If the bootstrap `NPM_TOKEN` still exists, move it to `release-publish`.

Do not remove the reviewer from `release`. The coordinator uses that environment for the only release approval.

## Required release-tag ruleset

Create an active tag ruleset named `Atlas Core release tags` with these exact controls:

- target `refs/tags/atlas-core-v*`;
- restrict creations, updates, and deletions;
- grant `always` bypass only to the GitHub Actions app.

The workflow confirms the active ruleset target and restrictions before preparing a release and again before coordinated
tag publication. GitHub does not expose the bypass list to the workflow token, so verify that list in repository settings.
The ruleset prevents a collaborator from creating or moving a release tag to enter the automatic `release-publish`
environment. Do not grant a user, team, or repository role bypass. An administrator can edit the ruleset for emergency
recovery.

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

The workflow refuses to push if `main` moved. It pushes the release commit and tag atomically, so neither moves without
the other. After that push, the coordinator uploads an authorization record containing the coordinator run ID, version,
tag, source commit, and release commit. The automatic tagged run must download that exact record from the approved
coordinator before it can publish. It rebuilds the npm archive from the release commit, verifies anonymous access to
every exact image, checks npm integrity, signatures, and provenance, then publishes the GitHub Release.

A tag run without a coordinator ID cannot use the automatic `release-publish` environment. It falls back to `release`
and requires a reviewer. This keeps manual recovery possible without letting an ordinary tag dispatch bypass approval.

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

1. Create the active `Atlas Core release tags` ruleset described above.
2. Create a GitHub environment named `release`. Restrict it to `main` and tags matching `atlas-core-v*`, then add a
   required reviewer.
3. Create a GitHub environment named `release-publish`. Restrict it to tags matching `atlas-core-v*`. Do not add a
   required reviewer. The workflow reaches this environment only through an immutable tag created by the approved
   coordinator.
4. Add `OPENCODE_API_KEY` as a repository Actions secret. Use an OpenCode Go API key, not a copied local auth file.
5. Create a short-lived npm granular access token with read/write package access and **Bypass 2FA**. Because
   `atlas-core` does not exist yet, the first token may need access to all packages owned by the publishing account.
   Store it as an environment secret named `NPM_TOKEN` in `release-publish`.
6. Give Actions the read and write workflow permission so the workflow can push the release commit, dispatch the tagged
   run, and wait for its result. If a ruleset protects `main`, grant this workflow the narrow required bypass.

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
pushed the release commit and tag. Tagged-job reruns recognize the exact release commit, pinned digests, image
visibility, npm integrity, provenance, release notes, and assets. They repair an incomplete draft release and reject
mismatched published artifacts. Manual tagged recovery waits for approval in `release`.

Use advanced recovery only when npm already contains the exact version with matching integrity, but the immutable-tag
workflow cannot finish because its tagged workflow contains a bug fixed later on `main`:

1. Dispatch **Release Atlas Core** from `main` for the same version.
2. Enable **Advanced recovery only, when this exact npm version already exists**.
3. Review the rebuilt artifact and grant the release approval.

Recovery keeps the existing tag fixed. It verifies the release commit, package files, npm integrity, pinned images,
tag-bound npm provenance, registry signature, release notes, and assets before publishing a draft GitHub Release. It
cannot publish a missing npm version. If npm does not contain the version, leave recovery disabled and run the tagged
workflow so publication provenance remains bound to the immutable tag.
