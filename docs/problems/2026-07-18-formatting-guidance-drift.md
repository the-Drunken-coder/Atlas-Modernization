# Root README understates the formatting scope enforced by CI

1. **Time & Date:** 2026-07-18T08:27:38-04:00
2. **Name:** Root README understates the formatting scope enforced by CI
3. **Issue:** The root JavaScript-toolchain guidance says formatting is checked only for files changed from a selected base, but CI runs each workspace formatting command without a `--since` argument.
4. **Severity:** S4 (Minor)
5. **Location:** `README.md`, `.github/workflows/ci.yml`, JavaScript workspace `package.json` files
6. **Expected:** The README tells contributors to run the same full-workspace formatting check enforced by CI.
7. **Actual:** `README.md:15-18` passes `--since=origin/main` and says only changed files are checked, while `.github/workflows/ci.yml` invokes every workspace's unscoped `format:check` script.
8. **Reproduction:**
   1. Run `rg -n 'format:check|only.*changed' README.md`
   2. Run `rg -n 'format:check' .github/workflows/ci.yml atlas_*/package.json`
   3. Observe that the README alone adds `--since=origin/main`; CI runs the unscoped package scripts for all four JavaScript workspaces.
9. **Notes:** Verified against `main` at `2d6106e` on 2026-07-25. Remove the `--since` argument and changed-files claim from the README so the contributor example matches the existing CI policy.
