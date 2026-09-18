# Core CLI default check repeats packed installation

1. **Time & Date:** 2026-09-17T15:32:00Z
2. **Name:** Default Core CLI check repeats the package build, pack, and install path
3. **Issue:** `atlas-core`'s default `check` runs the dedicated portable packed-package acceptance after the ordinary packed-install smoke. This repeats package work and fresh npm-consumer installation on every local check even though the same portable gate already runs in its own native platform workflow.
4. **Severity:** S5 (Note)
5. **Location:** `surfaces/core-cli/package.json:40-50`; `surfaces/core-cli/test/packed-install-smoke.mjs:7-53`; `surfaces/core-cli/test/portable-packed-cli.mjs:16-195`; `.github/workflows/acceptance-cli-platform.yml:14-84`
6. **Expected:** The default check should cover formatting, lint, types, unit tests, build, and the ordinary packed-install smoke. The platform-specific packed CLI gate should remain available as an explicit command and run in its dedicated host matrix, without imposing a second package install on every default check.
7. **Actual:** `check` invokes `npm run test:package && npm run test:portable-package` at `package.json:50`. `test:package` runs `npm pack` and installs the tarball into a temporary consumer (`packed-install-smoke.mjs:34-53`), while `test:portable-package` runs another build, `npm pack`, and temporary-consumer install (`portable-packed-cli.mjs:151-195`) before OS/Docker probes. Both scripts use unique temporary npm caches, so each check creates a second package-install/cache path. CI's ordinary `atlas-core` job already runs this combined check (`.github/workflows/ci.yml:254-258`), and the dedicated workflow repeats the portable command on four native hosts (`acceptance-cli-platform.yml:14-33,73-84`).
8. **Reproduction:**
   1. From a clean checkout after `npm ci`, run `npm run check --workspace atlas-core`.
   2. Observe the command sequence: explicit `npm run build`, `test:package`'s `npm pack` (which runs `prepack` and builds again), then `test:portable-package`'s explicit build, `npm pack --ignore-scripts`, and a second temporary `npm install`.
   3. Repeat the check during a normal edit/test loop. Each invocation performs both packed-consumer installs; on pull requests, the regular CI check performs the portable run once and the dedicated platform workflow performs it four more times.
9. **Notes:**
   - This is not a finding against the portable test itself. Its host/architecture probes and fake-Docker validation are unique and useful; the README intentionally documents `npm run test:portable-package --workspace atlas-core` as a platform acceptance command (`surfaces/core-cli/README.md:291-329`).
   - The avoidable cost is its inclusion in `check`, which adds one build, one pack, and one npm consumer installation to the ordinary package check. Severity is S5 because correctness coverage remains available through the explicit command and dedicated workflow; no product runtime failure was found.
   - A clean checkout without installed workspace dependencies prevented a timing run here. The repeated subprocesses and fresh cache roots are directly visible in the scripts; no source or generated output was modified by this audit.
