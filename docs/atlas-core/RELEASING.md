# Releasing Atlas Core

Atlas Core releases reserve an already-tested source commit with an immutable annotated tag. The tag runs one
self-contained publication workflow. Releases do not create a commit, update `main`, or add entries to `CHANGELOG.md`.
The permanent release notes and recovery bundle live in the GitHub Release.

```text
Request version
    -> pin source SHA and verify required CI
    -> create immutable tag
    -> generate notes, build and test candidate
    -> approve exact candidate
    -> publish and verify
```

Creating `atlas-core-v<version>` reserves that version. If the selected source is wrong, fix the source and request a
new version. Never move or replace a release tag, overwrite a published package, or unpublish a version as recovery.
`main` may advance as soon as the request pins its source SHA.

## Request a release

1. Confirm the intended source commit is on `main` and its required Core CI is green.
2. Open **Actions**, choose **Request Atlas Core release**, and run it from `main`.
3. Enter a new stable SemVer without a leading `v`. Leave **source_sha** empty to use the dispatch's `main` commit, or
   enter a full 40-character commit SHA already reachable from `main`.
   The selected source must contain release contract schema 1, so a pre-cutover commit cannot accidentally run the
   retired coordinator workflow.
4. The request waits up to 45 minutes for the exact required workflow runs. Immediately before reservation, it uses a
   read-only release App token to recheck immutable-release and tag-ruleset configuration. It then replaces that token
   with a tag-only token and creates the annotated `atlas-core-v<version>` tag. This reserves the version and triggers
   **Release Atlas Core**.
5. Open the tag-triggered publication run. Review its notes, manifest, package hash, image digest, Actions artifact
   digest, and acceptance evidence in the run summary.
6. Approve the `release-publish` environment deployment. The publisher uploads the exact bundle to a draft, publishes
   it as an immutable prerelease, verifies GitHub's release and asset attestations, reconciles GHCR and npm, then marks
   the same immutable release stable without changing the repository-wide GitHub latest release.
7. After completion, run **Release Atlas Core** manually from the same tag. A completed release follows the read-only
   verification path and performs no mutation.

The request run only reports reservation and links to publication. It never claims that a release completed.

## Required source CI

Eligibility is evaluated against the exact workflow file, `push` event, source SHA, workflow run, and job identity. A
same-named check from another workflow or event does not count. Missing, failed, canceled, skipped, or duplicate required
jobs block reservation.

The required jobs are:

- `.github/workflows/ci.yml`: `workflow-validation`, `go-quality`, `atlas-protocol`, `atlas-sdk`, both
  `atlas-core-package` platform jobs, and `docker-build`.
- `.github/workflows/integration.yml`: `integration` and `production-persistence`.
- The required, non-nightly jobs in `core-live-transactions.yml`, `core-storage-recovery.yml`, and
  `core-migration-restore.yml`.

UI, simulations, Meshtastic Link, and nightly modes do not gate Core releases.

## Candidate and approval boundary

The publication workflow builds one multi-architecture Core image and one npm tarball. It injects the tag-derived
version and image digest only into a temporary packaging worktree. Unreleased source remains `0.0.0-dev` with no
production image pin.

OpenCode Go receives factual git context plus the previous published release notes. It may create only the standalone
`release-notes.md`; a failed notes job is a visible preparation failure. A successful candidate records these identities
in `release-manifest.json`:

- version, repository, source commit, annotated tag name, and tag object;
- multi-architecture image digest and exact `linux/amd64` and `linux/arm64` platform set;
- tarball filename, SHA-256, and npm SHA-512 integrity;
- release-notes and acceptance-evidence hashes;
- preparation run and attempt.

Native Linux amd64 and arm64 jobs exercise the exact tarball and image through the Docker lifecycle. Native Linux and
macOS amd64 and arm64 jobs install and exercise the same tarball as packed consumers. Approval occurs only after all
evidence is included in the candidate identity. Any pre-seal rebuild requires another approval.

Actions artifacts carry a prepared candidate for 90 days. The publisher checks its run, tag SHA, artifact digest, and
manifest. A draft remains mutable and is not a seal. After the complete asset set is downloaded and compared
byte-for-byte, the publisher makes the release an immutable prerelease and verifies GitHub's signed release attestation
and every asset digest. Only then is the candidate sealed. Sealed GitHub Release assets are the permanent recovery
source.

The tag-triggered workflow never receives release App credentials. The request workflow owns the privileged ruleset
check and tag write. Publication and recovery revalidate the exact annotated tag object, source commit, required CI,
and candidate identity without depending on later repository-ruleset configuration.

## Publication and reconciliation

Publication is serialized across all Core versions; preparation for different tags may run concurrently. The publisher
performs these operations in order:

1. Revalidate the immutable tag and candidate identity.
2. Create a draft GitHub Release, upload the package, manifest, notes, checksums, and evidence, download and compare
   every byte, then publish it as an immutable prerelease and verify GitHub's release and asset attestations.
3. Promote the exact GHCR digest to the version tag and verify anonymous access.
4. Publish the exact tarball through npm trusted publishing when the version is absent.
5. Verify npm integrity, workflow/source provenance, registry signatures, and attestations with `npm audit signatures`.
6. Mark the same immutable GitHub Release stable with GitHub's latest-release flag disabled.

Matching existing state is success. A conflicting tag, image digest, npm package, release manifest, or sealed asset is a
hard failure. npm metadata and attestations may become visible at different times, so publication verification retries
temporary transport, rate-limit, and visibility failures for up to 15 minutes. Identity mismatches fail immediately. If
`npm publish` returns an ambiguous response, the workflow inspects registry state and never repeats the publish call in
that run.

The newest stable Core release receives npm's `latest` tag. An absent older version is initially published with npm's
`recovered` tag so it cannot displace `latest`. Because npm has only one movable `recovered` tag, its later position is
not part of an older release's identity or completion state. Atlas Core never changes the repository-wide GitHub latest
release because Core and Plugin releases share that namespace.

## Cancellation and recovery

Canceling a run stops future work but cannot undo a tag, candidate image, immutable prerelease, GHCR tag, or npm version
already written. The final reporting job records the observed public and partial state when GitHub permits it to run. You can
always inspect state locally after building the release tool:

```sh
npm ci --workspace @atlas/atlas-core-release --ignore-scripts
npm run build --workspace @atlas/atlas-core-release
node tools/atlas-core-release/dist/cli.js status --version <version>
```

`status` reports completion only after downloading and validating the immutable bundle, verifying GitHub's release and
asset attestations, checking the exact GHCR and npm identities, validating npm provenance, and auditing npm signatures.
The check is point-in-time: GitHub still permits release title, notes, and prerelease metadata to be edited after assets
become immutable, so every recovery revalidates those fields. Completed verification never repairs drift.

To recover, manually dispatch **Release Atlas Core** from `atlas-core-v<version>`. Never dispatch it from `main`.

- If no candidate was sealed, the workflow prepares and tests a new candidate and requires approval.
- If a candidate was sealed, the workflow downloads it from GitHub Releases, verifies every byte, requires fresh
  approval, and performs only missing publication operations.
- If publication is complete, the workflow performs read-only verification without entering the approval environment.
- Expired Actions artifacts do not affect sealed recovery. Missing sealed bytes are an explicit failure, never a reason
  to rebuild that version.

Rerunning recovery is safe after a successful external write whose response was lost. Existing matching state is reused;
conflicting state is never replaced.

## Configuration and cutover

The dedicated Atlas Core release GitHub App needs repository **Contents: read and write** plus **Administration: read**.
Administration access is used only to verify immutable-release settings and the exact release-tag bypass actors
immediately before reservation. Record its client ID as `ATLAS_CORE_RELEASE_APP_CLIENT_ID`, its numeric App ID as the
repository variable `ATLAS_CORE_RELEASE_APP_ID`, and its private key as the `release-commit` environment secret
`ATLAS_CORE_RELEASE_APP_PRIVATE_KEY`. The numeric App ID pins every ruleset check to this App rather than accepting any
integration bypass. The isolated tag job checks out the workflow's trusted source with read-only credentials and
prepares the annotated tag before minting the App token. It never checks out or executes code from the selected release
source under that token. The write credential is supplied ephemerally to the exact tag push and is not persisted in git
configuration. Ruleset and immutable-release checks use a separate token with Administration read and Contents read;
that token cannot create or move tags. The App no longer needs a `main` protection bypass.

Maintain two active tag rulesets targeting only `refs/tags/atlas-core-v*`:

1. `Atlas Core release tag creation` restricts creation and grants `always` bypass only to the release App. It does not
   restrict updates or deletions.
2. `Atlas Core release tag immutability` restricts updates and deletions, does not restrict creation, and has no bypass.

Configure environments as follows:

- `release-commit`: tag creation only, no required reviewer, and the App private key. It pushes no branch.
- `release-publish`: allow `atlas-core-v*`, disable administrator bypass, and require the release reviewer. npm trusted
  publishing must continue to identify workflow `release-atlas-core.yml` and environment `release-publish`.

Enable repository **Immutable releases** before the first request. The request rechecks this setting with the release App
after the CI wait and immediately before creating the tag. Publication accepts only a release that GitHub reports as
immutable and verifies its signed release attestation. Immutable releases lock the tag and assets when a draft is
published. This setting does not retroactively make historical releases immutable.

After this replacement is merged and no release is in flight:

1. Move the required reviewer to `release-publish` if it is still on the retired `release` environment.
2. Remove the release App's `main` bypass and keep only its release-tag creation bypass.
3. Confirm the rulesets above are active and repository immutable releases are enabled.
4. Confirm no `NPM_TOKEN` fallback exists. `atlas-core` already exists, so trusted publishing is the only supported path.
5. Confirm no other workflow uses the old `release` environment, then retire it.

The first live release is the cutover validation. Completion requires one reserved source tag, one self-contained tag
workflow, approval of the tested candidate, matching public npm/GHCR/GitHub artifacts, and a subsequent read-only status
check reporting completion.

## Historical tags

Tags created by the retired automatic-release-commit/coordinator workflow remain immutable historical releases. Use the
workflow version contained in an old tag only when recovering a legacy release that has no sealed bundle. Do not add a
runtime compatibility layer for coordinator IDs, authorization artifacts, release commits, or `main` recovery to the new
workflow. Historical `CHANGELOG.md` entries remain in git and are not rewritten.

Plugin images and catalog assets have their own lifecycle. See
[`docs/atlas-plugins/RELEASE_FORMAT.md`](../atlas-plugins/RELEASE_FORMAT.md); Atlas Core publication does not build,
promote, or document Plugin releases.
