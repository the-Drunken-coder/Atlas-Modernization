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
`POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, and `MINIO_ROOT_PASSWORD` values first.

Start the production-image stack:

```bash
python3 Atlas_Core/scripts/atlas.py --production
```

This uses `Atlas_Core/docker/docker-compose.production.yml`, builds the
Dockerfile `production` target, omits development bind mounts and settings
files, binds the API to `127.0.0.1:8000`, and requires API-key auth for API
routes. `API_AUTH_KEY` is the required bootstrap machine key; browser admins can
create additional managed machine keys after sign-in. Health and readiness
endpoints remain unauthenticated.

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
joins the Compose network and forwards traffic to `http://api:8000`.

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
docker compose -f docker-compose.production.yml --profile tunnel logs -f api cloudflared
```

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
