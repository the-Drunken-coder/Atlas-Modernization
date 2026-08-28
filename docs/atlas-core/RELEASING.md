# Releasing Atlas Core

Atlas Core releases come only from the manually dispatched `Release Atlas Core` GitHub Actions workflow. One version
identifies the npm CLI, the GHCR image, the git tag, and the GitHub Release.

## Before the first release

1. Create a GitHub environment named `release`. Restrict it to `main` and add a required reviewer.
2. Add `OPENCODE_API_KEY` as a repository Actions secret. Use an OpenCode Go API key, not a copied local auth file.
3. Create a short-lived npm granular access token with read/write package access and **Bypass 2FA**. Because
   `atlas-core` does not exist yet, the first token may need access to all packages owned by the publishing account.
   Store it as an environment secret named `NPM_TOKEN`.
4. Allow the release workflow's `GITHUB_TOKEN` to push its release commit to `main`, or grant that workflow the narrow
   ruleset bypass required for the push.

npm cannot configure trusted publishing until the first publication creates the package. Keep the bootstrap token's
expiration short and do not reuse it elsewhere.

The first run stops after pushing the GHCR image if anonymous pulls are still blocked. Make
`ghcr.io/the-drunken-coder/atlas-core` public, then rerun the failed publishing job. The workflow will reuse the
reviewed release commit and tag, verify the public image, and publish npm only after that check passes.

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
2. The preparation job checks Core and the npm package, gives the relevant git history to
   `opencode-go/gpt-5.6-luna`, and requires OpenCode to edit only `CHANGELOG.md`.
3. Inspect the changelog diff and the prepared artifact in the workflow run.
4. Approve the `release` environment deployment.
5. The publishing job refuses unrelated movement on `main`. It commits the version and changelog, pushes
   `atlas-core-v<version>`, publishes the multi-architecture GHCR image, verifies anonymous access, and creates or
   verifies the GitHub Release. npm publication is the final step.

A failed-job rerun recognizes the exact generated release commit, tag, image visibility, npm integrity, and release
assets. It repairs an incomplete draft release but rejects mismatched published artifacts. It never asks OpenCode to
write the same release section twice or rebuilds the image after npm already contains the reviewed tarball.
