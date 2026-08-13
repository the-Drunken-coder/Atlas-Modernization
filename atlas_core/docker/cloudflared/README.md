# Cloudflare Tunnel Service

This folder documents the Docker-side setup for the `cloudflared` container that
proxies public HTTPS traffic to the local ATLAS Core API.

## Usage

1. Create a Cloudflare tunnel in the Cloudflare dashboard and copy its **run token**.

2. For a development tunnel, export the token, a real API key, and an admin
   password override before starting Compose, or put them in
   `atlas_core/docker/.env`:

   ```bash
   export CLOUDFLARE_TUNNEL_TOKEN='your-tunnel-token'
   export API_AUTH_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
   export ATLAS_ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
   ```

   The admin password must contain at least 12 characters.

3. From the **repository root**, start the development tunnel stack:

   ```bash
   python3 atlas_core/scripts/atlas.py --tunnel
   ```

4. For the production-image stack, load the complete operator-owned production
   environment described in `atlas_core/docs/DEPLOYMENT_RUNBOOK.md`, including
   PostgreSQL and MinIO credentials, the API key, and admin password. Supply the
   tunnel token either in that process environment or in
   `atlas_core/docker/.env`, then start from the repository root:

   ```bash
   python3 atlas_core/scripts/atlas.py --production --tunnel
   ```

   The production launcher requires the Core credentials in its process
   environment; it does not accept those production credentials only from
   `docker/.env`. It may load the tunnel token from that file afterward. Use
   `atlas.py` for development tunnel starts. The direct development Compose
   overlay only injects the tunnel token and bootstrap API key; it does not pass
   the admin password override that Core requires when API auth is enabled.

The `cloudflared` service runs:

```text
cloudflared tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
```

The tunnel service is kept in `docker-compose.tunnel.yml` so normal non-tunnel
Compose runs do not require or expand `CLOUDFLARE_TUNNEL_TOKEN`. Both development
and production tunnel starts layer that file over their base Compose file.

Managed tunnel starts force `ENABLE_API_AUTH=true` for the API service and
require `API_AUTH_KEY` plus `ATLAS_ADMIN_PASSWORD` to be set to real values.
The bundled Compose stack does not mount an admin-password file. The committed example
settings file keeps auth disabled for local development, but public tunnel
traffic must not use that development default.

Note: Atlas Core's production PostgreSQL and configured MinIO bucket are durable
and must be backed up/restored together. Only development Compose enables the
explicit scratch reset that clears resource rows and MinIO while preserving the
verified schema, migration history, and local `admin_records`.

Core and `cloudflared` share a dedicated `172.30.0.0/29` ingress bridge inside
Compose. Core is pinned to `172.30.0.2`, `cloudflared` is pinned to
`172.30.0.3`, and Core trusts client-IP headers only from that exact
`172.30.0.3/32` peer. PostgreSQL and MinIO remain on the separate backend
network. `cloudflared` forwards to `http://api:8000`; hostname routing is
configured in the Cloudflare dashboard, not a local credentials file.

This peer check is the boundary that makes `CF-Connecting-IP` safe to use for
browser-admin login throttling. Direct clients cannot spoof that header because
their socket address is not trusted. Core uses `X-Forwarded-For` only when the
Cloudflare header is absent. If a trusted request has no valid forwarded client
address, Core keeps the username throttle but does not put the request into one
shared proxy-IP bucket.

## Local files

- `config.yml` and `credentials/` are retained for reference or manual tunnel runs.
  They are **not** mounted by the current `docker-compose.yml` tunnel service.
- For manual config-file runs, set `CLOUDFLARED_TUNNEL` to your tunnel UUID and render
  the config: `envsubst '${CLOUDFLARED_TUNNEL}' < config.yml > /tmp/cloudflared-config.yml`
- `atlas.py --tunnel` may load `CLOUDFLARE_TUNNEL_TOKEN`, `API_AUTH_KEY`, and
  `ATLAS_ADMIN_PASSWORD` from the shell or `atlas_core/docker/.env`.
  `atlas.py --production --tunnel` requires its operator-owned credentials in
  the process environment before reading that Compose file. Neither mode reads
  `credentials/atlas-core.json`.

## Troubleshooting

- Confirm the API container is healthy before starting the tunnel stack.
- If the dedicated `172.30.0.0/29` subnet conflicts with a host route, update
  that subnet, both static service addresses, and Core's trusted proxy `/32`
  together before restarting the stack.
- For development `atlas.py --tunnel`, verify the token, API key, and admin
  password override are exported in the shell or present in
  `atlas_core/docker/.env`. For `atlas.py --production --tunnel`, export the
  required Core credentials; the tunnel token may be exported or stored in
  `atlas_core/docker/.env`.
- Check tunnel logs: `cd atlas_core/docker && docker compose -f docker-compose.yml -f docker-compose.tunnel.yml logs cloudflared`
