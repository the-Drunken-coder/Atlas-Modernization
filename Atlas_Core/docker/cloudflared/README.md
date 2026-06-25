# Cloudflare Tunnel Service

This folder documents the Docker-side setup for the `cloudflared` container that
proxies public HTTPS traffic to the local ATLAS Core API.

## Usage

1. Create a Cloudflare tunnel in the Cloudflare dashboard and copy its **run token**.

2. Export the token and a real API key before starting Compose, or put them in
   `Atlas_Core/docker/.env`:

   ```bash
   export CLOUDFLARE_TUNNEL_TOKEN='your-tunnel-token'
   export API_AUTH_KEY='your-secure-api-key'
   ```

3. From the **repository root**, start the tunnel profile:

   ```bash
   python3 Atlas_Core/scripts/atlas.py --tunnel
   ```

   For the production-image stack:

   ```bash
   python3 Atlas_Core/scripts/atlas.py --production --tunnel
   ```

   or via Docker Compose directly:

   ```bash
   docker compose \
     -f Atlas_Core/docker/docker-compose.yml \
     -f Atlas_Core/docker/docker-compose.tunnel.yml \
     up -d
   ```

The `cloudflared` service runs:

```text
cloudflared tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
```

The tunnel service is kept in `docker-compose.tunnel.yml` so normal non-tunnel
Compose runs do not require or expand `CLOUDFLARE_TUNNEL_TOKEN`.
Production mode uses the tunnel profile in `docker-compose.production.yml` for
the same reason.

Tunnel mode also forces `ENABLE_API_AUTH=true` for the API service and requires
`API_AUTH_KEY` to be set to a real value. The committed example settings file
keeps auth disabled for local development, but public tunnel traffic must not
use that development default.

Note: Atlas Core's PostgreSQL database and configured MinIO bucket are
disposable runtime scratch storage. Default startup drops and recreates them
intentionally; they are not durable systems of record for operators.

It joins the same `atlas_core_network` bridge as the API service and forwards traffic to
`http://api:8000` inside Compose. Hostname routing is configured in the Cloudflare
dashboard for the tunnel — not via a local credentials file.

## Local files

- `config.yml` and `credentials/` are retained for reference or manual tunnel runs.
  They are **not** mounted by the current `docker-compose.yml` tunnel service.
- For manual config-file runs, set `CLOUDFLARED_TUNNEL` to your tunnel UUID and render
  the config: `envsubst '${CLOUDFLARED_TUNNEL}' < config.yml > /tmp/cloudflared-config.yml`
- `atlas.py --tunnel` requires `CLOUDFLARE_TUNNEL_TOKEN` and `API_AUTH_KEY` from
  the shell or `Atlas_Core/docker/.env`; it does not read
  `credentials/atlas-core.json`.

## Troubleshooting

- Confirm the API container is healthy before starting the tunnel profile.
- For `atlas.py --tunnel`, verify the token and API key are exported in the shell
  or present in `Atlas_Core/docker/.env`.
- Check tunnel logs: `docker compose -f Atlas_Core/docker/docker-compose.yml -f Atlas_Core/docker/docker-compose.tunnel.yml logs cloudflared`
