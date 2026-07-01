# Security Considerations

_Revision: 2026-05-29_

## Cross-Origin Resource Sharing (CORS)

CORS is configured in:

- `internal/config/config.go` (origin list loading)
- `cmd/atlas_core/main.go` (middleware wiring)

### Default Allowed Origins

If no override is provided, the service allows:

- `http://localhost:3000`
- `http://localhost:8080`
- `http://localhost:5173`
- `http://localhost:5175`
- `http://localhost:4173`
- `http://127.0.0.1:3000`
- `http://127.0.0.1:8080`
- `http://127.0.0.1:5173`
- `http://127.0.0.1:5175`
- `http://127.0.0.1:4173`

Production origins are not compiled into defaults. Configure each hosted origin explicitly through env/settings.

### Overrides

You can override origins with:

- `CORS_ORIGINS` (JSON array string or comma-separated string)
- `CORS_ORIGIN_PATTERNS` (JSON array string or comma-separated string)
- `cors_origins` in `atlas_core.settings.json` (applies when env vars are not set)
- `cors_origin_patterns` in `atlas_core.settings.json` (applies when env vars are not set)

When `CORS_ORIGINS` is **explicitly set to empty** and `CORS_ORIGIN_PATTERNS` is unset or empty, no origins are allowed (deny-all). This differs from omitting both variables, which uses the built-in default exact-origin list above.

`CORS_ORIGINS` and `CORS_ORIGIN_PATTERNS` form one combined allowlist. If either environment variable is set, environment configuration owns the whole allowlist and an omitted counterpart is treated as empty. The settings-file keys behave the same way when no CORS environment variables are set.

`CORS_ORIGIN_PATTERNS` is for hosted preview environments such as Cloudflare branch/PR deployments. Patterns must be full `http` or `https` origins with exactly one wildcard constrained inside the leftmost hostname label, for example:

- `https://*-atlas-command-interface.preview.example.com`

Broad credentialed-CORS wildcards such as `*`, `https://*`, and `https://*.workers.dev` are rejected.

### Current Middleware Behavior

- `AllowCredentials` is enabled so trusted browser origins can send Core-owned session cookies.
- Allowed methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`
- Allowed request headers: `Accept`, `Authorization`, `Content-Type`, `If-Match`, `X-API-Key`, `X-Request-ID`
- Exposed headers: `ETag`, `X-Has-More`, `X-Next-Cursor`, `X-Limit`, `X-Returned-Count`, `Content-Length`

Operators should prefer exact trusted origins. Use constrained origin patterns only for deployment systems that generate per-branch hostnames. Unsafe cookie-authenticated browser methods are rejected unless the `Origin` header matches configured CORS origins or constrained origin patterns.

## Authentication

Atlas Core supports two protected-route auth modes:

- Machine clients can use API-key auth.
- Browser clients can use Core-owned admin sessions.

Browser sessions use an `atlas_session` cookie with `HttpOnly; Secure`. The default SameSite mode is `None` so the Cloudflare-hosted UI can call a separately hosted Core with `credentials: "include"`. Set `ATLAS_ADMIN_COOKIE_SAMESITE=lax` only when the UI and Core are same-site.

The development startup path seeds a disposable admin account:

- username: `admin`
- password: `password`
- role: `admin`

This is for development scratch storage only. Production operators must set `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` before exposing Core. When API-key auth is enabled, Core refuses to start if the seeded account would use the default `admin` / `password` credential. If an explicit admin password override changes between restarts, Core updates the seeded admin account so password rotation works even when `DATABASE_RECREATE_ON_STARTUP=false`.

Optional API key auth is controlled by:

- `ENABLE_API_AUTH` and `API_AUTH_KEY` environment variables (take precedence)
- `enable_api_auth` and `api_auth_key` in `atlas_core.settings.json`

If enabled, middleware accepts the bootstrap API key or an active managed API key (`X-API-Key` or `Authorization: Bearer ...`) before serving protected routes. Browser session cookies are also accepted on protected resource routes. Managed API keys are full-access machine credentials in v1; Core stores only `sha256(secret)` plus metadata and returns the full key only from the create response. Managed keys are inactive while API-key auth is disabled, and Core rejects new managed-key creation until `ENABLE_API_AUTH=true`.

Managed API key administration is browser-session-only:

- `GET /admin/api-keys`
- `POST /admin/api-keys`
- `DELETE /admin/api-keys/{key_id}`

API-key-authenticated requests cannot manage API keys. `admin_records` stores admin accounts, sessions, login throttles, and managed API key metadata; it is preserved across recreate-mode resource table refreshes.

### Production Docker image

The production Docker target does not copy `atlas_core.settings.json.example`
into the image. Its entrypoint refuses to start unless `ENABLE_API_AUTH=true`
and `API_AUTH_KEY` is set to a non-empty value other than
`REPLACE_WITH_SECURE_KEY`. This bootstrap key remains required even when managed
API keys exist. The auth-disabled example settings file is kept only for the
development image / loopback-only Compose workflow.

### Startup fail-fast

The process refuses to start when:

- `ENABLE_API_AUTH` / `enable_api_auth` is true and the key is empty
- The key is still the example placeholder `REPLACE_WITH_SECURE_KEY`
- `ENABLE_API_AUTH` / `enable_api_auth` is true and neither `ATLAS_ADMIN_PASSWORD` nor `ATLAS_ADMIN_PASSWORD_FILE` replaces the default development admin password

### Public unauthenticated paths

`/health`, `/readiness`, `/resources`, and `OPTIONS` skip protected-route auth. `POST /admin/auth/login` is public so the browser can establish a session. `POST /admin/auth/logout` is origin-gated, and `GET /admin/auth/me` remains protected.

## Configuration Checklist

- [ ] Rotate database and MinIO credentials per environment, even though Atlas Core treats that storage as disposable runtime state.
- [ ] Restrict network ingress to trusted operators.
- [ ] Set explicit `CORS_ORIGINS` for production and constrained `CORS_ORIGIN_PATTERNS` only for trusted preview deployment hostnames.
- [ ] Set `ENABLE_API_AUTH=true` and a real `API_AUTH_KEY` for production.
- [ ] Override the development `admin` / `password` seed with `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE`.
- [ ] Keep `ATLAS_ADMIN_COOKIE_SAMESITE=none` for cross-site UI/Core deployments, or set `lax` only for same-site deployments.
- [ ] Audit environment variables and settings file before release.
