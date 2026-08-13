# Security Considerations

_Revision: 2026-07-10_

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
- `http://localhost:8787`
- `http://localhost:4173`
- `http://127.0.0.1:3000`
- `http://127.0.0.1:8080`
- `http://127.0.0.1:5173`
- `http://127.0.0.1:5175`
- `http://127.0.0.1:8787`
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

- `https://*.atlas-je0.pages.dev`
- `https://*-atlas-command-interface.preview.example.com`

Broad credentialed-CORS wildcards such as `*`, `https://*`, `https://*.pages.dev`, and `https://*.workers.dev` are rejected.

### Current Middleware Behavior

- `AllowCredentials` is enabled so trusted browser origins can send Core-owned session cookies.
- Allowed methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`
- Allowed request headers: `Accept`, `Authorization`, `Content-Type`, `If-Match`, `X-API-Key`, `X-Request-ID` (structured-log correlation)
- Exposed headers: `ETag`, `X-Has-More`, `X-Next-Cursor`, `X-Limit`, `X-Returned-Count`, `Content-Length`

Operators should prefer exact trusted origins. Use constrained origin patterns only for deployment systems that generate per-branch hostnames. Unsafe cookie-authenticated browser methods are rejected unless the `Origin` header matches configured CORS origins or constrained origin patterns.

## Trusted Proxy Client IPs

Browser-admin login failures are limited by both username and client IP: eight
failures within 15 minutes throttle that key until the window expires. Forwarded
client-IP headers are therefore security-sensitive.

`TRUSTED_PROXY_CIDRS` is an environment-only, comma-separated list of the
immediate reverse-proxy peers allowed to supply those headers. It defaults to an
empty list. For a direct request, Core always uses the socket peer and ignores
`CF-Connecting-IP` and `X-Forwarded-For`, so an arbitrary client cannot choose
its throttle bucket.

For a configured trusted peer, Core prefers a single valid
`CF-Connecting-IP`. If that header is absent, Core walks `X-Forwarded-For` from
right to left, skipping configured trusted hops. A missing, malformed, or
ambiguous authoritative forwarded identity produces no IP bucket instead of
falling back to the shared proxy address; the username throttle remains active.
This prevents malformed proxy traffic from recreating a proxy-wide admin
lockout.

Cloudflare Tunnel origins see the local `cloudflared` process IP, and Cloudflare
recommends `CF-Connecting-IP` as the consistent single-IP HTTP header. The
bundled tunnel Compose files therefore put only Core and `cloudflared` on a
dedicated `172.30.0.0/29` ingress bridge, pin `cloudflared` to `172.30.0.3`, and
trust only `172.30.0.3/32`. Do not configure Cloudflare edge ranges or a broad
Docker subnet: neither identifies the immediate trusted peer narrowly enough.
Keep Cloudflare's visitor-IP headers enabled. See Cloudflare's
[request-header reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
and [Tunnel source-IP behavior](https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/).

Any peer in `TRUSTED_PROXY_CIDRS` can choose the resolved client identity. A
custom proxy must therefore overwrite `CF-Connecting-IP`, or remove it and
append the client address it observed to `X-Forwarded-For`; never trust a peer
that passes both headers through unchanged.

## Authentication

Atlas Core supports two protected-route auth modes:

- Machine clients can use API-key auth.
- Browser clients can use Core-owned admin sessions.

Browser sessions use an `atlas_session` cookie with `HttpOnly; Secure`. The default SameSite mode is `None` so the Cloudflare-hosted UI can call a separately hosted Core with `credentials: "include"`. Set `ATLAS_ADMIN_COOKIE_SAMESITE=lax` only when the UI and Core are same-site.

Raw development startup seeds a development-only default admin credential:

- username: `admin`
- password: `password`

This credential is for local development only; its `admin_records` row still survives scratch data resets. The default `atlas.py --dev` launcher replaces the password with a generated value in `atlas_core/docker/.env.local` so it can safely enable machine auth. The bundled production Compose launcher requires `ATLAS_ADMIN_PASSWORD`; direct Core processes and explicitly mounted custom containers may instead use `ATLAS_ADMIN_PASSWORD_FILE`. Production admin passwords must contain at least 12 characters. When API-key auth is enabled, Core refuses to start if the seeded account would use the default `admin` / `password` credential. If an explicit admin password override changes between restarts, Core updates the seeded admin account so password rotation works even when `DATABASE_RECREATE_ON_STARTUP=false`.

Optional API key auth is controlled by:

- `ENABLE_API_AUTH` and `API_AUTH_KEY` environment variables (take precedence)
- `enable_api_auth` and `api_auth_key` in `atlas_core.settings.json`

`python3 atlas_core/scripts/atlas.py --dev` enables API-key auth for the local
stack and generates or reuses the bootstrap key and admin password in the
owner-only `atlas_core/docker/.env.local`. This gives local clients one shared
credential source without exposing the machine key to browser-delivered
configuration or making local secrets available to production and tunnel startup.

If enabled, middleware accepts the bootstrap API key or an active managed API key (`X-API-Key` or `Authorization: Bearer ...`) before serving protected routes. Browser session cookies are also accepted on protected resource routes. Managed API keys are full-access machine credentials in v1; Core stores only `sha256(secret)` plus metadata and returns the full key only from the create response. Managed keys are inactive while API-key auth is disabled, and Core rejects new managed-key creation until `ENABLE_API_AUTH=true`.

Managed API key administration is browser-session-only:

- `GET /admin/api-keys`
- `POST /admin/api-keys`
- `DELETE /admin/api-keys/{key_id}`

API-key-authenticated requests cannot manage API keys. `admin_records` stores admin accounts, sessions, login throttles, and managed API key metadata. It is durable production data included in full-database backup/restore, and it also survives explicit development scratch-mode resource refreshes.

### Production Docker image

The production Docker target does not copy `atlas_core.settings.json.example`
into the image. Its entrypoint refuses to start unless `ENABLE_API_AUTH=true`
and `API_AUTH_KEY` is set to a strong ASCII value that is non-empty, non-placeholder,
not common, not too short, not low-entropy, and not sequential. This bootstrap
key remains required even when managed API keys exist. The example settings
file keeps the Core-level default disabled; the development launcher overrides
it with its generated local credentials, while raw Compose follows its `.env`.

### Startup fail-fast

The process refuses to start when:

- `ENABLE_API_AUTH` / `enable_api_auth` is true and the key is empty
- The key is still a placeholder or fails the weak-key guard
- `ENABLE_API_AUTH` / `enable_api_auth` is true and neither `ATLAS_ADMIN_PASSWORD` nor `ATLAS_ADMIN_PASSWORD_FILE` replaces the default development admin password
- The bundled production launcher receives only `ATLAS_ADMIN_PASSWORD_FILE`; its Compose stack does not mount that path

### Public unauthenticated paths

`/health`, `/readiness`, and `OPTIONS` skip protected-route auth. `/resources` requires an API key or admin session because it performs per-request CPU/runtime inspection and exposes host/process capacity details. `/feed` also bypasses the shared protected-route middleware because websocket clients may need first-message API-key auth, but the feed handler still requires either a preauthenticated API key, a trusted browser session, or a first auth frame when API-key auth is enabled. `POST /admin/auth/login` is public so the browser can establish a session. `POST /admin/auth/logout` is origin-gated, and `GET /admin/auth/me` remains protected.

## Configuration Checklist

- [ ] Rotate database and MinIO credentials per environment, protect their durable volumes, and test paired PostgreSQL/MinIO backup restoration.
- [ ] Restrict network ingress to trusted operators.
- [ ] Set explicit `CORS_ORIGINS` for production and constrained `CORS_ORIGIN_PATTERNS` only for trusted preview deployment hostnames.
- [ ] Set `ENABLE_API_AUTH=true` and a strong `API_AUTH_KEY` for production.
- [ ] Override the development `admin` / `password` seed with an `ATLAS_ADMIN_PASSWORD` of at least 12 characters; use `ATLAS_ADMIN_PASSWORD_FILE` only for direct Core or a custom container that explicitly mounts it.
- [ ] Keep `ATLAS_ADMIN_COOKIE_SAMESITE=none` for cross-site UI/Core deployments, or set `lax` only for same-site deployments.
- [ ] Leave `TRUSTED_PROXY_CIDRS` empty for direct deployments; behind a custom proxy, trust only its exact immediate peer `/32` or `/128`.
- [ ] Audit environment variables and settings file before release.
