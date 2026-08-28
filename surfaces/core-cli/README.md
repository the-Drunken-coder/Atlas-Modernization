# Atlas Core CLI

`atlas-core` installs and operates one durable Atlas Core deployment on a macOS or Linux host with Docker Compose.
The npm package is the operator interface. Atlas Core itself runs from the matching
`ghcr.io/the-drunken-coder/atlas-core` container image.

## Install

Install Node.js 24 or newer and Docker with Compose, then install the CLI globally:

```bash
npm install --global atlas-core
atlas-core init
atlas-core start
```

`init` generates strong local credentials and provisions the MinIO bucket only when it can prove the deployment is
new. It refuses to create new credentials over existing Atlas containers or volumes. Configuration is stored in `~/.atlas/core`
with owner-only permissions. Set `ATLAS_CORE_HOME` before the first command to choose another location.

## Commands

```text
atlas-core help
atlas-core init
atlas-core start
atlas-core stop
atlas-core restart
atlas-core status
atlas-core logs [core|postgres|minio] [--follow]
atlas-core doctor
atlas-core version
```

`stop` removes containers and the private Compose network. It preserves PostgreSQL and MinIO volumes. Removing the
npm package also leaves those durable volumes untouched.

The first release binds the Core API, PostgreSQL, and MinIO ports to loopback. It does not configure public ingress.
Installing a different CLI version does not upgrade an initialized deployment. `start` and `restart` stop with an
explicit version mismatch until a backup-aware upgrade path is available.

## External ingress

Run Cloudflare Tunnel or another reverse proxy separately and route only the Core HTTP endpoint at
`http://127.0.0.1:8000`. Atlas does not install the proxy or store its credentials. Follow the
[external ingress guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/main/docs/atlas-core/EXTERNAL_INGRESS.md)
for CORS, command-interface configuration, readiness checks, and trusted-proxy behavior.

## Storage safety

PostgreSQL and the configured MinIO bucket are one durable store. Back them up and restore them together. The CLI
never enables Core's destructive development startup mode and never passes `--volumes` to `docker compose down`.
After the first full-stack start attempt, it refuses to recreate either durable volume if one goes missing. It also
binds the state directory to the Docker engine that initialized it and verifies Docker Compose ownership labels before
using an existing container or volume.

If `init` finds existing Atlas volumes without its matching configuration, it stops. Do not delete those volumes to
silence the check. Recover the credentials and paired storage instead.
