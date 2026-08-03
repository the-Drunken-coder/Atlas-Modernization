# Production Compose passes an unmounted admin password file path

1. **Time & Date:** 2026-08-03T06:07:56Z (revalidated; originally recorded 2026-07-30)
2. **Name:** Production Compose passes an unmounted admin password file path
3. **Issue:** The launcher accepts a host `ATLAS_ADMIN_PASSWORD_FILE` path, but production Compose passes the string into the container without mounting the file, so Core cannot read it.
4. **Severity:** **S3 (Moderate)** — the documented credential source is unusable in the bundled production stack, although `ATLAS_ADMIN_PASSWORD` works.
5. **Location:** `atlas_core/scripts/atlas.py`, `atlas_core/docker/docker-compose.production.yml`, `atlas_core/docker/Dockerfile`, `atlas_core/docker/production-entrypoint.sh`, `atlas_core/internal/admin/admin.go`, `atlas_core/README.md`, `atlas_core/docs/SECURITY.md`
6. **Expected:** Every credential source accepted by bundled production preflight is readable inside the container, or the launcher clearly accepts only the working environment-value source.
7. **Actual:** Host-path preflight still succeeds; Compose defines no API volume or secret mount; the image contains no operator secret; Core calls `os.ReadFile` on the unchanged container path and startup fails. This was revalidated end to end against `main` at `f4b0187fdb68088ea0b59d28218d02204f4cfc9c`.
8. **Reproduction:**
   1. Render production Compose with `ATLAS_ADMIN_PASSWORD_FILE=/run/secrets/atlas_admin`.
   2. The API environment contains that path but has no matching `volumes` or `secrets`; the Dockerfile does not copy it.
   3. Remove this source from bundled-stack preflight/Compose/docs while retaining Core's direct-process file option, and test that file-only production launch fails before Docker.
