# External ingress for packaged Atlas Core

`atlas-core` owns the local Core deployment. It does not install a reverse proxy, manage DNS, or store tunnel
credentials. A reverse proxy connects to Core through its loopback HTTP port:

```text
public hostname -> operator-managed proxy -> http://127.0.0.1:8000 -> Atlas Core
```

Only publish port `8000`. Do not create tunnel routes for PostgreSQL on `5432` or MinIO on `9000` and `9001`.

## Cloudflare Tunnel

Create a remotely managed tunnel in Cloudflare, then run `cloudflared` as a host service. In the tunnel dashboard,
add a published application route with these values:

```text
Hostname: api.example.com
Service:  http://localhost:8000
```

Cloudflare documents the current setup in [Routing](https://developers.cloudflare.com/tunnel/routing/) and
[Run as a service](https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/). Keep the
tunnel token in the `cloudflared` service configuration or its token file. Do not put it in `~/.atlas/core/.env`.
[Cloudflare Tunnel supports WebSockets](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/),
which covers the connection used by the Atlas change feed.

Start Core before the tunnel and compare local and public readiness:

```bash
atlas-core start
curl -fsS http://127.0.0.1:8000/readiness
curl -fsS https://api.example.com/readiness
```

## Browser configuration

Core must allow the exact command-interface origin. Edit the owner-only `~/.atlas/core/.env`, then restart Core:

```dotenv
CORS_ORIGINS=https://atlas.example.com
CORS_ORIGIN_PATTERNS=https://*.atlas-example.pages.dev
```

Omit `CORS_ORIGIN_PATTERNS` when the deployment has no preview origins. Do not use `*` for browser credentials.

The static command interface also needs the public Core URL when it is built:

```bash
VITE_ATLAS_CORE_BASE_URL=https://api.example.com npm run build:command-interface
```

This value also produces the matching HTTPS and WebSocket entries in the command interface's security policy.

## Authentication and client addresses

The packaged Core always enables its own admin-session and API-key authentication. Cloudflare Access, WAF rules,
and edge rate limits are optional outer controls. They do not replace Atlas credentials.

[Cloudflare sends the original visitor address](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
in `CF-Connecting-IP`, but Core accepts that header only from a peer listed in `TRUSTED_PROXY_CIDRS`. Keep that setting
empty for a separately installed host tunnel unless you have identified and isolated the exact socket peer that Core
sees. Never trust Cloudflare's public address ranges, a broad Docker subnet, or an address shared with untrusted local
processes.

With no trusted proxy configured, Core safely ignores forwarded client-address headers. All tunnel requests then use
the local proxy peer for the client-IP login throttle. Eight failed logins from that shared peer can temporarily
throttle other operators. Cloudflare Access or an edge login rate limit can reduce this risk for a personal
deployment. A deployment that needs distinct client-IP throttles should use the repository's pinned private-network
[tunnel overlay](../../services/core/docker/docker-compose.tunnel.yml) instead of the host-service recipe.

## Other reverse proxies

The same loopback interface works with another operator-managed reverse proxy. Terminate public TLS at the proxy,
forward HTTP and WebSocket traffic to `127.0.0.1:8000`, and configure the browser origins above. Set
`TRUSTED_PROXY_CIDRS` only to an exact controlled peer whose forwarded headers the proxy overwrites rather than
passing through from the client.
