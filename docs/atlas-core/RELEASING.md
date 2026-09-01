# Releasing Atlas Core

Implementation status: this guide describes the current v1 workflow, which still releases catalog Plugin images with
Core. [`2026-09-01-plugins-release-independently-from-atlas-core.md`](../design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md)
supersedes that coupling. Keep following this guide until the independent Plugin workflow and catalog are implemented;
then this guide must remove every Plugin build, digest, visibility, and package-asset step. That first decoupled Core
update must refuse to proceed while a bundled-v1 Plugin remains enabled; `docs/atlas-plugins/MANAGEMENT.md` defines the
greenfield transition.

Atlas Core uses one version for the npm CLI, Core and catalog Plugin images, git tag, and GitHub Release. A normal
release starts from `main` and finishes in an automatically queued run from the immutable release tag.

## Normal release

1. Open **Actions**, select **Release Atlas Core**, and choose the `main` branch.
2. Select **Run workflow**. Enter the new stable SemVer without a leading `v`, and leave advanced recovery disabled.
   Prerelease versions are not supported.
3. Wait for **Draft and validate changelog** and **Build approval artifact** to finish.
4. Read the run summary. Download `atlas-core-<version>` and review `release-artifacts/release.diff`, the release notes,
   and the packed archive.
5. Grant Approval 1 for **Run approved release phase**. This permits the workflow to publish candidate images, run the
   disposable-host acceptance test, and atomically push the release commit and `atlas-core-v<version>` tag.
6. Open the automatically queued run named `Atlas Core <version> from atlas-core-v<version>`. Download its
   `atlas-core-<version>` artifact. This is the final package built from the immutable release commit.
7. Grant Approval 2. The tagged run promotes the reviewed image digests, publishes npm with provenance, and makes the
   GitHub Release public and latest.
8. Confirm the npm version, GHCR image tags, and GitHub Release are public. Confirm every new catalog Plugin image is
   also anonymously pullable.

The main run and tag run have different titles and summaries. Each summary identifies the artifact to review and the
side effects authorized by its approval.

## What the workflow checks

Before Approval 1, the workflow:

- gives the relevant git history to `opencode-go/gpt-5.6-luna` and accepts only its `CHANGELOG.md` edit;
- versions and packs the npm CLI in a fresh job;
- runs the Core CLI checks, release helper tests, Protocol checks and tests, Core tests, and npm audit;
- restricts the prepared diff to release-owned files.

After Approval 1, it builds `linux/amd64` and `linux/arm64` Core and catalog Plugin images, verifies their labels and
digests, records the immutable digests in the package, and exercises the packed CLI on a disposable Docker host. The
acceptance test covers refusal to adopt unknown containers, initialization, start, diagnostics, status, update, reset,
and stop while confirming that ordinary stop preserves both durable volumes.

The workflow refuses to push if `main` moved. It pushes the release commit and tag atomically, so neither moves without
the other. The tagged run rebuilds the npm archive from that commit, verifies anonymous access to every exact image,
checks npm integrity, signatures, and provenance, then publishes the GitHub Release.

## If the review needs changes

Before Approval 1, reject or cancel the run. Correct `CHANGELOG.md` on `main`, then dispatch the same version again. If
the newest changelog section already matches that version, the workflow validates and preserves it instead of asking
OpenCode to write it again.

After the release commit and tag exist, never move or replace the tag. Rerun a failed tagged job when the existing
artifacts still match. If the release itself is wrong after public publication, prepare a new patch release rather than
rewriting the published version.

## New GHCR packages

GitHub creates a new Core or catalog Plugin package as private. The tagged run stops before npm publication if any exact
image digest is not anonymously pullable. Make each new package public, then rerun the failed tagged job. Existing image
digests, the release commit, and the tag remain unchanged.

## First-time setup

1. Create a GitHub environment named `release`. Restrict it to `main` and tags matching `atlas-core-v*`, then add a
   required reviewer.
2. Add `OPENCODE_API_KEY` as a repository Actions secret. Use an OpenCode Go API key, not a copied local auth file.
3. Create a short-lived npm granular access token with read/write package access and **Bypass 2FA**. Because
   `atlas-core` does not exist yet, the first token may need access to all packages owned by the publishing account.
   Store it as an environment secret named `NPM_TOKEN`.
4. Give Actions the read and write workflow permission so the workflow can push the release commit and dispatch the
   tagged run. If a ruleset protects `main`, grant this workflow the narrow required bypass.

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
   - environment: `release`
   - allowed action: `npm publish`
4. Delete the `NPM_TOKEN` GitHub environment secret and revoke the bootstrap token in npm.
5. Require two-factor authentication and disallow token-based publication in the npm package settings.

Later releases require no npm token.

## Recovery after the tag exists

If automatic dispatch fails after the atomic push, dispatch **Release Atlas Core** manually from
`atlas-core-v<version>`. Do not rerun the original main job after it has pushed the release commit and tag. Tagged-job
reruns recognize the exact release commit, pinned digests, image visibility, npm integrity, provenance, release notes,
and assets. They repair an incomplete draft release and reject mismatched published artifacts.

Use advanced recovery only when npm already contains the exact version with matching integrity, but the immutable-tag
workflow cannot finish because its tagged workflow contains a bug fixed later on `main`:

1. Dispatch **Release Atlas Core** from `main` for the same version.
2. Enable **Advanced recovery only, when this exact npm version already exists**.
3. Review the rebuilt artifact and grant the release approval.

Recovery keeps the existing tag fixed. It verifies the release commit, package files, npm integrity, pinned images,
tag-bound npm provenance, registry signature, release notes, and assets before publishing a draft GitHub Release. It
cannot publish a missing npm version. If npm does not contain the version, leave recovery disabled and run the tagged
workflow so publication provenance remains bound to the immutable tag.
