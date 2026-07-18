# Root README understates the formatting scope enforced by CI

1. **Time & Date:** 2026-07-18T08:27:38-04:00
2. **Name:** Root README understates the formatting scope enforced by CI
3. **Issue:** The root JavaScript-toolchain guidance says formatting is checked only for files changed from a selected base, but CI runs each workspace formatting command without a `--since` argument.
4. **Severity:** S4 (Minor)
5. **Location:** `README.md`, `.github/workflows/ci.yml`, JavaScript workspace `package.json` files
6. **Expected:** The README describes the same formatting scope that contributors and CI actually exercise.
7. **Actual:** The README example shows `--since=origin/main` and states that only changed files are checked, while CI invokes each package's full `format:check` script.
8. **Reproduction:**
   1. Inspect the JavaScript toolchain section in `README.md`
   2. Inspect the formatting steps in `.github/workflows/ci.yml`
   3. Compare them with each workspace's `format:check` script
9. **Notes:** Decide whether the intended policy is full-workspace formatting or changed-file formatting, then align the README and CI rather than documenting both behaviors as equivalent.
