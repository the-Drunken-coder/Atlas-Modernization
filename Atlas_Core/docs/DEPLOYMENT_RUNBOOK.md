# Atlas Core Deployment Runbook

Atlas Core uses the original Atlas single-host deployment posture: Docker
Compose runs the Core API, PostgreSQL, and MinIO on one machine, and an optional
Cloudflare Tunnel container provides the public HTTPS edge.

Atlas Core resource tables and the configured MinIO bucket are disposable
runtime scratch storage. The default startup path drops/recreates resource
tables and clears the bucket. `admin_records` is preserved for operator
credentials and managed API key metadata.

## Local Development

From the repository root:

```bash
python3 Atlas_Core/scripts/atlas.py
```

This uses `Atlas_Core/docker/docker-compose.yml`, builds the development image,
bind-mounts source directories, and keeps API auth disabled for loopback-only
development.

Direct Compose is also supported:

```bash
cd Atlas_Core/docker
docker compose up -d --build
```

## Production Image

Set runtime credentials in the shell or in `Atlas_Core/docker/.env`:

```bash
export POSTGRES_PASSWORD='replace-with-strong-password'
export MINIO_ROOT_USER='atlas'
export MINIO_ROOT_PASSWORD='replace-with-strong-password'
export API_AUTH_KEY='replace-with-secure-api-key'
export ATLAS_ADMIN_PASSWORD='replace-with-secure-admin-password'
```

`atlas.py` loads `Atlas_Core/docker/.env` automatically during managed starts.
Direct production `docker compose -f docker-compose.production.yml ...` commands
parse the Compose file before contacting Docker, so run them from
`Atlas_Core/docker` with `.env` present or re-export the same
`POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `API_AUTH_KEY`,
and `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` values first.

Start the production-image stack:

```bash
python3 Atlas_Core/scripts/atlas.py --production
```

This uses `Atlas_Core/docker/docker-compose.production.yml`, builds the
Dockerfile `production` target, omits development bind mounts and settings
files, binds the API to `127.0.0.1:8000`, and requires API-key auth for API
routes. `API_AUTH_KEY` is the required strong bootstrap machine key; browser
admins can create additional managed machine keys after sign-in. Health,
readiness, and the `/feed` middleware bypass remain outside protected-route
middleware; the feed handler performs its own API-key or browser-session
authentication. The host/process `/resources` diagnostic requires a protected
API key or admin session.

## Production Tunnel

Create a Cloudflare Tunnel in the Cloudflare dashboard and copy its run token.
Hostname routing is managed in Cloudflare, not in a local credentials file.
Use the same production credentials from the previous section, then add the
tunnel values:

```bash
export CLOUDFLARE_TUNNEL_TOKEN='replace-with-cloudflare-token'
export ATLAS_TUNNEL_HOSTNAME='atlascommandapi.org'
export API_AUTH_KEY='replace-with-secure-api-key'
export ATLAS_ADMIN_PASSWORD='replace-with-secure-admin-password'
python3 Atlas_Core/scripts/atlas.py --production --tunnel
```

`ATLAS_TUNNEL_HOSTNAME` defaults to `atlascommandapi.org`. The tunnel container
forwards traffic to `http://api:8000` over a dedicated `172.30.0.0/29` ingress
bridge shared only with Core. Compose pins Core to `172.30.0.2`, pins
`cloudflared` to `172.30.0.3`, and configures Core to trust only the tunnel
peer's `172.30.0.3/32` client-IP headers. Direct clients remain keyed by their
socket address and cannot spoof `CF-Connecting-IP` or `X-Forwarded-For`.
For the browser interface, `api.atlasinterface.com` is the default Core URL and
points at the same tunnel service as `atlascommandapi.org`.

`atlas.py` recreates the Compose containers and networks during a managed
restart. When upgrading a host with direct Compose commands, run the documented
`down --remove-orphans` command with both Compose files before starting the
tunnel so Docker can create the dedicated ingress bridge. If `172.30.0.0/29`
conflicts with a host
route, change the subnet, the two static service addresses, and
`TRUSTED_PROXY_CIDRS` together; the trusted value must remain the exact
`cloudflared` `/32`.

For a non-Compose reverse proxy, leave `TRUSTED_PROXY_CIDRS` empty unless Core's
socket peer is that proxy. Then configure only the exact peer `/32` or `/128`.
The proxy must overwrite `CF-Connecting-IP`, or remove it and append its
observed client to `X-Forwarded-For`; passing client-supplied values through is
unsafe.
Never use Cloudflare's public edge ranges for Tunnel: Core connects to the local
`cloudflared` process, not directly to the edge.

The production Core environment should allow the Pages origins that can call
cookie-authenticated admin/resource routes:

```bash
CORS_ORIGINS=https://atlasinterface.com
CORS_ORIGIN_PATTERNS=https://*.atlas-je0.pages.dev
```

## Readiness Policy

Use `/health` for process liveness and `/readiness` for traffic admission:

- HTTP `200` with `healthy` means the database and configured MinIO bucket are reachable.
- HTTP `200` with `degraded` is reserved for an intentionally storage-unconfigured local or DB-only process.
- HTTP `503` with `unhealthy` means the database is unavailable or configured storage could not be initialized, reached, or verified. A missing configured bucket is also unhealthy because object operations cannot succeed.

Do not route production traffic while readiness is `503`. Inspect the API and MinIO logs, confirm `MINIO_ENDPOINT`, credentials, network reachability, and `MINIO_BUCKET`, then restore MinIO or its bucket. Readiness returns to `200` after the configured bucket check succeeds. In recreate mode, a storage failure during bucket clearing remains startup-fatal so an empty database is never served alongside stale blobs.

## Smoke Tests

For local production mode:

```bash
API_AUTH_KEY="$API_AUTH_KEY" \
ATLAS_CORE_API_URL=http://localhost:8000 \
./Atlas_Core/scripts/run_integration_tests.sh
```

For tunnel mode:

```bash
ATLAS_API_AUTH_KEY="$API_AUTH_KEY" \
ATLAS_CORE_API_URL="https://${ATLAS_TUNNEL_HOSTNAME:-atlascommandapi.org}" \
./Atlas_Core/scripts/run_integration_tests.sh
```

`API_AUTH_KEY` and `ATLAS_API_AUTH_KEY` both add `X-API-Key` to smoke requests;
`ATLAS_API_AUTH_KEY` takes precedence.

## Logs And Shutdown

The production commands below assume `Atlas_Core/docker/.env` exists or the same
credential environment variables are exported in the current shell.

Development logs:

```bash
cd Atlas_Core/docker
docker compose logs -f api postgres minio
```

Production logs:

```bash
cd Atlas_Core/docker
docker compose -f docker-compose.production.yml logs -f api postgres minio
```

Production tunnel logs:

```bash
cd Atlas_Core/docker
docker compose -f docker-compose.production.yml -f docker-compose.tunnel.yml logs -f api cloudflared
```

Stop a production tunnel deployment and remove its dedicated ingress network:

```bash
cd Atlas_Core/docker
docker compose -f docker-compose.production.yml -f docker-compose.tunnel.yml down --remove-orphans
```

Core accepts an existing `X-Request-ID` and includes it as `request_id` on structured request and request-scoped error logs; otherwise it generates one. Handler error-envelope 4xx diagnostics use warning severity, while 5xx error envelopes and panic recovery use error severity. Readiness dependency warnings remain warning-level probe diagnostics even when readiness is `503`. Use `request_id` to follow one request across access and failure records; `error_id` identifies one handler error response.

Stop containers without deleting volumes:

```bash
cd Atlas_Core/docker
docker compose -f docker-compose.production.yml down --remove-orphans
```

Reset containers and volumes:

```bash
cd Atlas_Core/docker
docker compose -f docker-compose.production.yml down -v --remove-orphans
```

The reset command removes Docker volumes, but ordinary Atlas Core startup also
recreates resource tables and clears the configured MinIO bucket in recreate
mode while preserving `admin_records`.
