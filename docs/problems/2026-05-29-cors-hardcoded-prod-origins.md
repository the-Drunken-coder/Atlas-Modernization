# Problem

1. **Time & Date:** 2026-05-29T00:00:00Z
2. **Name:** Production hostnames baked into compile-time CORS defaults
3. **Issue:** `DefaultCORSOrigins` hardcodes environment-specific production hosts (`https://atlas-je0.pages.dev`, `https://atlasinterface.com`) alongside the localhost dev origins. Compile-time defaults should not carry deployment-specific config; production origins belong in env/settings so the binary stays environment-agnostic.
4. **Severity:** S4 (Minor) — config hygiene; works today but couples the build to one deployment.
5. **Location:** `Atlas_Core/internal/config/config.go` (`DefaultCORSOrigins`, ~L76–89), referenced by `cmd/atlas_core/main.go` CORS wiring; documented in `Atlas_Core/docs/SECURITY.md`
6. **Expected:** Defaults cover only local development; production origins are supplied via `CORS_ORIGINS` / `ALLOWED_ORIGINS` env or `cors_origins` in `atlas_core.settings.json`.
7. **Actual:** Production hostnames are compiled into the default allowlist and ship in every build.
8. **Reproduction:**
   1. Start the server with no CORS env/settings override.
   2. Observe `atlasinterface.com` / `atlas-je0.pages.dev` are allowed by default.
9. **Notes:** Move prod origins to deployment config (settings file / env), keep only localhost in the compiled default. Update `SECURITY.md` to match. Consider as part of this: `AllowCredentials: true` is set in `main.go` while auth travels in `X-API-Key`/`Authorization` headers (not cookies) — likely unnecessary and worth re-evaluating, though tracked separately if pursued.
