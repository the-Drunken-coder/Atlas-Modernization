# Production Compose passes an unmounted admin password file path

1. **Time & Date:** 2026-07-30T01:35:00-07:00
2. **Name:** Production Compose passes an unmounted admin password file path
3. **Issue:** The launcher accepts a host `ATLAS_ADMIN_PASSWORD_FILE` path, but production Compose passes the string into the container without mounting the file, so Core cannot read it.
4. **Severity:** **S3 (Moderate)** — the documented credential source is unusable in the bundled production stack, although `ATLAS_ADMIN_PASSWORD` works.
5. **Location:** `atlas_core/scripts/atlas.py:489-506`, `atlas_core/docker/docker-compose.production.yml:3-43`, `atlas_core/docker/Dockerfile:72-100`, `atlas_core/docker/production-entrypoint.sh:42-50`, `atlas_core/internal/admin/admin.go:527-543`, `atlas_core/README.md:68-84`, `atlas_core/docs/SECURITY.md:104-110,143-161`
6. **Expected:** Every credential source accepted by bundled production preflight is readable inside the container, or the launcher clearly accepts only the working environment-value source.
7. **Actual:** Host-path preflight succeeds; Compose defines no API volume/secret mount; the image contains no operator secret; Core calls `os.ReadFile` on the unchanged container path and startup fails. This was confirmed end to end against `main` at `2426bb66c59466f142f101500f85016b9d6f76d4`.
8. **Reproduction:**
   1. Render production Compose with `ATLAS_ADMIN_PASSWORD_FILE=/run/secrets/atlas_admin`.
   2. The API environment contains that path but has no matching `volumes` or `secrets`; the Dockerfile does not copy it.
   3. Remove this source from bundled-stack preflight/Compose/docs while retaining Core's direct-process file option, and test that file-only production launch fails before Docker.
