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
- `cors_origins` in `atlas_core.settings.json` (applies when env vars are not set)

When `CORS_ORIGINS` is **explicitly set to empty**, no origins are allowed (deny-all). This differs from omitting the variable, which uses the built-in default list above.

### Current Middleware Behavior

- `AllowCredentials` is disabled.
- Allowed methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`
- Allowed request headers: `Accept`, `Authorization`, `Content-Type`, `If-Match`, `X-API-Key`, `X-Request-ID`
- Exposed headers: `ETag`, `X-Has-More`, `X-Next-Cursor`, `X-Limit`, `X-Returned-Count`, `Content-Length`

Operators must still choose safe origins and use explicit hosts over wildcards.

## API Authentication

Optional API key auth is controlled by:

- `ENABLE_API_AUTH` and `API_AUTH_KEY` environment variables (take precedence)
- `enable_api_auth` and `api_auth_key` in `atlas_core.settings.json`

If enabled, middleware requires a valid API key (`X-API-Key` or `Authorization: Bearer ...`)
before serving protected routes.

### Production Docker image

The production Docker target does not copy `atlas_core.settings.json.example`
into the image. Its entrypoint refuses to start unless `ENABLE_API_AUTH=true`
and `API_AUTH_KEY` is set to a non-empty value other than
`REPLACE_WITH_SECURE_KEY`. The auth-disabled example settings file is kept only
for the development image / loopback-only Compose workflow.

### Startup fail-fast

The process refuses to start when:

- `ENABLE_API_AUTH` / `enable_api_auth` is true and the key is empty
- The key is still the example placeholder `REPLACE_WITH_SECURE_KEY`

### Public unauthenticated paths

`/health` and `/readiness` skip API key auth (and request logging).

## Configuration Checklist

- [ ] Rotate database and MinIO credentials per environment, even though Atlas Core treats that storage as disposable runtime state.
- [ ] Restrict network ingress to trusted operators.
- [ ] Set explicit `CORS_ORIGINS` for production.
- [ ] Set `ENABLE_API_AUTH=true` and a real `API_AUTH_KEY` for production.
- [ ] Audit environment variables and settings file before release.
