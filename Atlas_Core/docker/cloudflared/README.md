# Cloudflare Tunnel Service

This folder documents the Docker-side setup for the `cloudflared` container that
proxies public HTTPS traffic to the local ATLAS Core API.

## Usage

1. Create a Cloudflare tunnel in the Cloudflare dashboard and copy its **run token**.

2. Export the token before starting Compose:

   ```bash
   export CLOUDFLARE_TUNNEL_TOKEN='your-tunnel-token'
   ```

3. From the **repository root**, start the tunnel profile:

   ```bash
   python3 Atlas_Core/scripts/atlas.py --tunnel
   ```

   or via Docker Compose directly:

   ```bash
   docker compose -f Atlas_Core/docker/docker-compose.yml --profile tunnel up -d
   ```

The `cloudflared` service runs:

```text
cloudflared tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
```

It joins the same `atlas_core_network` bridge as the API service and forwards traffic to
`http://api:8000` inside Compose. Hostname routing is configured in the Cloudflare
dashboard for the tunnel — not via a local credentials file.

## Local files

- `config.yml` and `credentials/` are retained for reference or manual tunnel runs.
  They are **not** mounted by the current `docker-compose.yml` tunnel service.
- For manual config-file runs, set `CLOUDFLARED_TUNNEL` to your tunnel UUID and render
  the config: `envsubst '${CLOUDFLARED_TUNNEL}' < config.yml > /tmp/cloudflared-config.yml`
- `atlas.py --tunnel` requires `CLOUDFLARE_TUNNEL_TOKEN`; it does not read
  `credentials/atlas-core.json`.

## Troubleshooting

- Confirm the API container is healthy before starting the tunnel profile.
- Verify the token is set in the shell or `.env` used by Compose.
- Check tunnel logs: `docker compose -f Atlas_Core/docker/docker-compose.yml logs cloudflared`
