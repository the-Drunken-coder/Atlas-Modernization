# Releasing Atlas Core

Atlas Core releases come only from the manually dispatched `Release Atlas Core` GitHub Actions workflow. One version
identifies the npm CLI, the GHCR image, the git tag, and the GitHub Release.

## Before the first release

1. Create a GitHub environment named `release`. Restrict it to `main` and tags matching `atlas-core-v*`, then add a
   required reviewer.
2. Add `OPENCODE_API_KEY` as a repository Actions secret. Use an OpenCode Go API key, not a copied local auth file.
3. Create a short-lived npm granular access token with read/write package access and **Bypass 2FA**. Because
   `atlas-core` does not exist yet, the first token may need access to all packages owned by the publishing account.
   Store it as an environment secret named `NPM_TOKEN`.
4. Allow the release workflow's `GITHUB_TOKEN` to push its release commit to `main`, or grant that workflow the narrow
   ruleset bypass required for the push.

npm cannot configure trusted publishing until the first publication creates the package. Keep the bootstrap token's
expiration short and do not reuse it elsewhere.

The first approved run publishes a version-and-commit-specific candidate image, records its immutable manifest digest
in the npm package, and atomically pushes the dedicated release commit and `atlas-core-v<version>` tag. It then stops.
Dispatch the workflow again for the same version from that immutable tag. Publication starts only from this tagged
run so npm provenance identifies the release commit and the package pins the reviewed image. Ordinary movement on
`main` cannot invalidate the tagged publishing run. On the first package release, the tagged run stops if anonymous
image access is still blocked. Make `ghcr.io/the-drunken-coder/atlas-core` public, then rerun that failed job. The
workflow verifies the exact public digest before publishing npm.

## After the first release

1. Confirm the `atlas-core` npm package is public.
2. Confirm `ghcr.io/the-drunken-coder/atlas-core` remains public.
3. Configure npm trusted publishing with these exact values:
   - organization or user: `the-Drunken-coder`
   - repository: `Atlas-Modernization`
   - workflow filename: `release-atlas-core.yml`
   - environment: `release`
   - allowed action: `npm publish`
4. Delete the `NPM_TOKEN` GitHub environment secret and revoke the bootstrap token in npm.
5. Require two-factor authentication and disallow token-based publishing in the npm package settings. Trusted
   publishing continues through GitHub OIDC.

Later releases require no npm token.

## Release flow

1. Open **Actions**, select **Release Atlas Core**, and enter a stable SemVer value without a leading `v`. Prerelease
   versions are not supported.
2. An isolated job gives the relevant git history to `opencode-go/gpt-5.6-luna` and exports only its reviewed
   `CHANGELOG.md`. A fresh job then versions, checks, and packs Core and the npm package without inheriting the agent's
   process environment.
3. Inspect the changelog diff and the prepared artifact in the workflow run.
4. Approve the `release` environment deployment.
5. The publishing job refuses movement on `main`, publishes a candidate image, commits its immutable digest with the
   version and changelog, atomically pushes the dedicated release commit and tag, and stops.
6. Dispatch the workflow again for the same version from `atlas-core-v<version>` and approve the reviewed artifacts.
   This run verifies and promotes only the pinned digest, prepares a draft GitHub Release, publishes npm, verifies npm
   integrity, signatures, and provenance, then makes the GitHub Release public and latest.

Do not rerun the job that stops after pushing the release commit and tag. Dispatch the workflow from the immutable tag
as described above. If another commit reaches `main` before the atomic push, neither the release commit nor tag is
pushed. Failed tagged-job reruns recognize the exact generated release commit, pinned image digest, tag, image
visibility, npm integrity, provenance, and release assets. They repair an incomplete draft release but reject
mismatched published artifacts. The workflow never asks OpenCode to write the same release section twice or rebuilds
the image after its digest is committed.

## Recovering with an updated workflow

Use `recover_existing_release` only when npm already contains the exact version with matching integrity, but the
immutable-tag run cannot finish because its tagged workflow contains a bug fixed later on `main`. Dispatch **Release
Atlas Core** from `main` for the same version, enable **Resume an existing exact release**, inspect the rebuilt
artifacts, and approve the `release` environment.

The recovery run keeps the existing tag fixed, requires its release commit and package files to match, verifies npm
integrity before changing draft assets, and rechecks the pinned image, tag-bound npm provenance, registry signature,
release notes, and assets before publishing the draft GitHub Release. It cannot publish npm. If the npm version does
not exist, leave recovery disabled and dispatch from `atlas-core-v<version>` so publication provenance remains bound
to the immutable tag.
