1. **Time & Date:** 2026-09-16T15:45:49Z
2. **Name:** Build-push action comments omit the pinned patch version
3. **Issue:** Five hash-pinned `docker/build-push-action` uses clauses annotate the pinned commit with only the incomplete major-only comment `# v7`, while commit `53b7df96c91f9c12dcc8a07bcb9ccacbed38856a` resolves to the `v7.3.0` release. The incomplete comments trigger `zizmor` `ref-version-mismatch` findings and can prevent Dependabot from tracking the pin correctly.
4. **Severity:** S4 (Minor)
5. **Location:** `.github/workflows/ci.yml:692,700,708`; `.github/workflows/release-atlas-core.yml:849`; `.github/workflows/release-atlas-plugin.yml:167`; `.github/workflows/nightly.yml:90-95`
6. **Expected:** Each comment identifies the exact tag for the pinned commit, `# v7.3.0`, so the workflow audit and dependency-update tooling can correlate the SHA with its release.
7. **Actual:** All five uses contain `# v7`. The nightly workflow's `zizmor` v1.25.2 audit reports five medium-confidence `ref-version-mismatch` findings for these lines. The action still executes the pinned commit, so this does not alter the image build or release behavior directly.
8. **Reproduction:**
   1. Check out `798c2e066f6874299336794335367b86a907a090`.
   2. Run `rg -n 'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a' .github/workflows` and observe the five `# v7` comments.
   3. Resolve commit `53b7df96c91f9c12dcc8a07bcb9ccacbed38856a` in `docker/build-push-action`; it is tagged `v7.3.0`.
   4. Run the repository's workflow audit (`zizmor` v1.25.2 over `.github/workflows`, as configured in `.github/workflows/nightly.yml`) and observe five `ref-version-mismatch` findings.
9. **Notes:** This is documentation/dependency-tracking drift, not an implementation or test defect. `zizmor` documents that stale version comments can cause Dependabot to silently ignore the pin. Updating the comments to `# v7.3.0` preserves the existing SHA and runtime behavior while restoring audit consistency.
