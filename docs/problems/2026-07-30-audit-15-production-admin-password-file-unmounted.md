# Production Compose passes an unmounted admin password file path

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Production Compose passes an unmounted admin password file path
3. **Original Audit Finding:** 15
4. **Validation Status:** Confirmed end to end against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`.
5. **Issue:** The launcher and production entrypoint accept a host `ATLAS_ADMIN_PASSWORD_FILE` path as satisfying production preflight, and Compose copies the string into the container environment without mounting the file. Core then tries to open that container path and startup fails.
6. **Affected Surface & Severity:** Atlas Core production operator configuration and documented credential rotation; **S3 (Moderate)** because the advertised file option is unusable in the bundled stack, while the direct `ATLAS_ADMIN_PASSWORD` environment variable is a working workaround.
7. **Location:** `atlas_core/scripts/atlas.py:489-506`, `atlas_core/docker/docker-compose.production.yml:3-43`, `atlas_core/docker/Dockerfile:72-100`, `atlas_core/docker/production-entrypoint.sh:42-50`, `atlas_core/internal/admin/admin.go:527-543`, `atlas_core/README.md:68-84`, and `atlas_core/docs/SECURITY.md:104-110,143-161`.
8. **Expected:** Every credential source accepted by bundled production preflight is readable inside the production container, or the bundled launcher clearly accepts only the working environment-value source.
9. **Actual:** The host path passes launcher and shell-entrypoint non-empty checks. Compose has no `volumes` or `secrets` entry for the API service, and the production image copies only the binary and entrypoint. `developmentPassword` calls `os.ReadFile` on the unchanged path, so a normal host file is absent in the container.
10. **Concrete Evidence / Reproduction:**
    1. Run `ATLAS_ADMIN_PASSWORD_FILE=/run/secrets/atlas_admin` with the other required probe values through `docker compose -f atlas_core/docker/docker-compose.production.yml config`.
    2. Rendered config shows `api.environment.ATLAS_ADMIN_PASSWORD_FILE: /run/secrets/atlas_admin` and no API `volumes`/`secrets`; only PostgreSQL and MinIO have mounts.
    3. Inspect `Dockerfile:84-89`; no operator secret is copied into the runtime image.
    4. Inspect `production-entrypoint.sh:42-48`; it checks only that the path string is non-empty, not readable.
    5. Inspect `admin.go:527-538`; Core reads the path and returns `read ATLAS_ADMIN_PASSWORD_FILE: ...` when it is missing.
    6. No container was started and no credential file was read during validation.
11. **Root Cause:** A process-level file-path option was exposed unchanged through a container boundary without defining ownership or a mount/secret mapping. Both preflights validate presence of the string rather than availability of the file in the selected runtime.
12. **Simplest Correct Proposed Solution:** Current bundled production requirements already use `ATLAS_ADMIN_PASSWORD` in the concrete startup example and do not require Docker Secrets. Remove `ATLAS_ADMIN_PASSWORD_FILE` as an accepted/promised source from the bundled launcher, production Compose, production entrypoint message, and bundled-stack docs; retain Core's process-level file option for direct/custom deployments. If a real Docker secret requirement is later established, add one explicit read-only secret mount and pass its fixed container path instead.
13. **Acceptance Criteria / Regression-Test Plan:**
    1. `atlas.py --production` with only `ATLAS_ADMIN_PASSWORD_FILE` fails before Docker with an actionable message.
    2. Production Compose/entrypoint no longer claim an unmounted path is supported.
    3. The documented `ATLAS_ADMIN_PASSWORD` production startup still passes launcher, entrypoint, and Core seeding/rotation tests.
    4. Direct-process tests for `developmentPassword` continue to support a readable file and reject missing/empty files.
    5. A repository search leaves no bundled-Compose instruction telling operators to set a host password-file path.
14. **Scope / Non-Goals:** Do not add a generalized secret manager, invent a Docker/Kubernetes secret requirement, remove direct-process file support, or change password hashing/session behavior.
15. **Overlaps:** Finding 1 affects the same production launcher but concerns data destruction. Finding 3 concerns login throttling after an admin credential is successfully configured.
