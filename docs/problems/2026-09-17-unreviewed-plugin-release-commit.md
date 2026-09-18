# Problem: Plugin release tags do not require reviewed source

1. **Time & Date:** 2026-09-17T15:05:05Z
2. **Name:** Unreviewed Plugin release commits can enter the signed catalog
3. **Issue:** A repository writer can create an `atlas-plugin-*-v*` tag at a valid but unreviewed or unmerged commit and dispatch the Plugin release workflow from that tag. The resulting release and catalog entry are signed with the production catalog credentials.
4. **Severity:** S3 (Moderate)
5. **Location:** `.github/workflows/release-atlas-plugin.yml:49-66,240-253,326-345`; `docs/atlas-plugins/CATALOG_BOOTSTRAP.md:11-14`
6. **Expected:** A signed first-party Plugin release should be attributable to an authorized, reviewed source commit. Scheduled catalog renewal may remain reviewer-free, but Plugin release-tag creation must be protected or the release workflow must require equivalent review provenance.
7. **Actual:** The release validation accepts `main` or the exact requested Plugin tag and checks only that the checked-out commit equals `GITHUB_SHA`. The publish job enters the `plugin-catalog` environment with `contents: write`, and can create the release tag through the GitHub API. The bootstrap record says that environment has no required reviewer and records protection against Plugin tag update/deletion, not creation. No Plugin tag-ruleset gate exists in the workflow; the runtime ruleset gate is present only for Atlas Core releases.
8. **Reproduction:**
   1. From a valid Plugin commit that is not merged to `main`, create a new semver release tag such as `atlas-plugin-building_scan-v0.1.1`.
   2. Dispatch `Release Atlas Plugin` with `plugin_id=building_scan` and `version=0.1.1`, selecting that tag as the workflow ref.
   3. The validation job accepts the exact tag and records its commit as `source_sha` (`.github/workflows/release-atlas-plugin.yml:58-67`).
   4. After the candidate checks pass, the publish job runs without a reviewer and signs the catalog entry from that source (`.github/workflows/release-atlas-plugin.yml:240-253,420-445`). If the tag is absent when a release is dispatched from `main`, the same job creates it directly from `source_sha` (`.github/workflows/release-atlas-plugin.yml:334-344`).
9. **Notes:** The source-SHA equality check, candidate image labels, release-document verification, and catalog ledger compare-and-swap prevent artifact substitution after checkout; they do not prove review or merge provenance. The no-review environment is intentional for weekly renewal, but reusing it for release publication leaves the release boundary without an equivalent authorization check. The checked-in bootstrap record is the available evidence for the external environment/ruleset configuration; a live GitHub ruleset API check was unavailable during this audit. Audited at detached `43b5928ceba19bc95d00d578cc6ed9c03319167e`; no product code or workflow was changed.
