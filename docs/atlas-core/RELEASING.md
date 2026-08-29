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

The first approved run publishes the multi-architecture image, records its immutable manifest digest in the npm
package, pushes the dedicated release commit, and then stops. Dispatch the workflow again for the same version from
that exact new `main` head. Publication starts only from that second run so npm provenance identifies the release
commit and the package can pin the already-reviewed image. On the first package release, the second run stops if
anonymous image access is still blocked. Make `ghcr.io/the-drunken-coder/atlas-core` public, then rerun that failed
publishing job. The workflow verifies the pinned public image before publishing npm.

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
5. The publishing job refuses unrelated movement on `main`, publishes the reviewed image, commits its immutable
   digest with the version and changelog, pushes that dedicated release commit, and stops.
6. Dispatch the workflow again for the same version from that exact new `main` head and approve the reviewed artifacts.
   This run pushes `atlas-core-v<version>`, verifies the pinned public image, and creates or verifies the GitHub
   Release. npm publication is the final step.

Do not rerun the job that stops after pushing the release commit; dispatch the workflow from that exact commit as
described above. If another commit reaches `main` first, the workflow refuses to publish the stale release. Later
failed-job reruns recognize the exact generated release commit, pinned image digest, tag, image visibility, npm
integrity, and release assets. They repair an incomplete draft release but reject mismatched published artifacts. The
workflow never asks OpenCode to write the same release section twice or rebuilds the image after its digest is committed.
