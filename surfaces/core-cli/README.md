# Atlas Core CLI

`atlas-core` installs and operates one durable Atlas Core deployment on an arm64 or x64 macOS or Linux host with Docker Compose.
The npm package is the operator interface. Atlas Core itself runs from the matching
`ghcr.io/the-drunken-coder/atlas-core` container image.

## Install

Install Node.js 24 or newer and Docker with Compose 2.17.0 or newer, then install the CLI globally. The CLI requires a
local Linux Docker daemon over a Unix socket; it refuses remote Docker contexts because the fixed deployment names and
durable volumes belong to one host.

```bash
npm install --global atlas-core
atlas-core
```

Running `atlas-core` without arguments opens an interactive action menu. It provides initialization, start and stop,
service health and performance, configuration, updates, logs, diagnostics, and the confirmed reset flow. The status
view reports CPU, memory, network and block I/O, process count, uptime, restart count, health, and image details from
Docker. It refreshes every five seconds without overlapping Docker reads. Up and down scroll the status body, left and
right select a service, and `r` refreshes immediately. Arrow keys move through other menus, typing filters the main
menu, Enter selects an action, and Escape or `q` goes back.

### Preview the terminal UI

From a repository checkout, run the visual preview with fixture data:

```bash
python3 scripts/preview_atlas_core_tui.py
```

Use `--state stopped`, `--state degraded`, or `--state not-initialized` to open another deployment state. The preview
builds and runs the real terminal UI, but its operator is entirely in memory. It never contacts Docker, reads Atlas Core
configuration, uses credentials, accesses the network, or changes containers and durable storage. Pass `--no-build` to
reuse the current `surfaces/core-cli/dist` output while iterating on visual changes.

Initialization generates strong local credentials and provisions the MinIO bucket only when it can prove the deployment
is new. It refuses to create new credentials over existing Atlas containers or volumes. Configuration is stored in
`~/.atlas/core` with owner-only permissions. Set `ATLAS_CORE_HOME` before the first command to choose another location.

The menu is a user-friendly layer over the same commands shown below. Those commands remain available for scripts and
direct operation.

## Commands

```text
atlas-core
atlas-core help
atlas-core init
atlas-core start
atlas-core stop
atlas-core restart
atlas-core reset
atlas-core config
atlas-core update [cli|all]
atlas-core status
atlas-core logs [core|source-gateway|postgres|minio] [--follow]
atlas-core doctor
atlas-core version
atlas-core plugins
atlas-core plugins enable <plugin_id>
atlas-core plugins disable <plugin_id>
atlas-core plugins status [plugin_id]
atlas-core plugins logs <plugin_id> [--follow]
```

## Plugins

Implementation status: the commands below describe the current Core-packaged Plugin catalog. The accepted independent
release design is documented in
[`../../docs/design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md`](../../docs/design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md).
Until that design is implemented, the CLI does not yet install, update, roll back, or uninstall independently
versioned Plugins.

The `Plugins` menu and matching commands manage trusted, query-only Plugins published in the installed Atlas Core
catalog. Building Scan is available as an opt-in first-party Plugin; no Plugin is enabled by default. The CLI does not
accept arbitrary paths, images, or third-party bundles.

Enabling a Plugin pulls the catalog's immutable image digest, stages its private Compose and configuration fragments,
validates the complete Compose model, and then commits the new state. A running deployment starts the Plugin and
restarts Core and Source Gateway with a health wait. A stopped deployment stays stopped. Failure restores the previous
files, state, and running composition. Disabling removes the stateless Plugin container and its fragments but keeps the
cached image. Plugin mutations require the CLI and deployment versions to match; status and logs remain available after
a CLI-only update.

The menu's `Configure` action opens a configuration menu. `Admin account` changes the password for the fixed `admin`
username. The direct `config` command opens the same hidden password prompt. The password must contain at least 12
characters and is never accepted as a command argument, which keeps it out of shell history and process listings. No
other deployment settings are exposed yet.

When Core is running, `config` restarts it so the new password applies to subsequent logins. When Core is stopped, the
new password applies on the next start. Existing browser sessions expire normally. The initial random password remains
in `~/.atlas/core/.env` until the operator changes it.

## Updates

The menu's `Update` action checks the npm `latest` release and shows the installed CLI version, running Core version,
and available release before changing anything. Choose one of two update scopes:

- `Update CLI only` or `atlas-core update cli` installs the latest global CLI through the current npm prefix. The
  running Atlas Core containers, credentials, and durable storage stay unchanged.
- `Update CLI + Atlas Core` or `atlas-core update all` installs the latest CLI, pulls that release's digest-pinned Core
  image plus every enabled Plugin image, and restarts a running deployment against the existing PostgreSQL and MinIO
  volumes. A stopped deployment stays stopped. The update refuses a target catalog that no longer contains an enabled
  Plugin and pulls every target digest before changing the deployment.

Core releases may carry schema migrations. Before a Core update, create and validate the paired PostgreSQL and MinIO
backup described in the [deployment runbook](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/main/services/core/docs/DEPLOYMENT_RUNBOOK.md#pre-deploy-backup).
The menu review screen and `atlas-core update all` both require confirmation that a current paired backup exists.
CLI-only updates do not require a deployment backup because they do not change the running Core or its stores.

CLI-only updates may leave the CLI newer than the running Core. Status, logs, diagnostics, stop, reset, and the explicit
update flow remain available in that state. Start and restart refuse to change Core implicitly and direct the operator
to `atlas-core update all`.

For a running deployment, the CLI records the new Core version only after Docker reports the updated services healthy.
For a stopped deployment, it records the version after pulling the reviewed image and leaves Core stopped. If an update
fails, it does not delete credentials or volumes and leaves the recorded Core version unchanged so the operator can
inspect logs and retry. Updating the global CLI requires write access to the npm prefix where `atlas-core` is installed.

`stop` removes containers and the private Compose network. It preserves PostgreSQL and MinIO volumes. Removing the
npm package also leaves those durable volumes untouched.

`reset` is the explicit exception. It permanently deletes the known Atlas Core containers, both durable volumes, and
the credentials and state in the selected `ATLAS_CORE_HOME`. It then creates new credentials and empty storage, and
starts the image pinned by the installed CLI package. Reset is for intentionally discarding a deployment, not for
updates. Use `atlas-core update all` to move an existing deployment to the newest release without deleting its data.

Reset lists what it will delete and asks `Continue? [y/N]`. It proceeds only after `y` or `yes`. Reset verifies
ownership labels and stops before deleting anything if another container uses either durable volume. It does not remove
separately managed tunnels, reverse proxies, or their credentials.

The packaged deployment also starts the private Source Gateway from the same immutable Core image. Its base
configuration has no connectors, and Core starts with no configured Plugins. Enabling a catalog Plugin mounts that
Plugin's endpoint and connector fragments into private directories without adding Plugin-specific settings to the base
Compose file.

The first release binds the Core API, PostgreSQL, and MinIO ports to loopback. It does not configure public ingress.
Start, restart, and update require registry access and pull the release's digest-pinned image. Neither a locally
retagged image nor an overwritten registry tag can replace the reviewed Core image.

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
using an existing container or volume. Initialization also takes a Docker-engine-scoped project lock, so different
configuration directories cannot initialize the same fixed deployment concurrently.

If `init` finds existing Atlas volumes without its matching configuration, it stops. Recover the credentials and paired
storage unless you intend to discard the deployment. Use the confirmed `reset` command only when permanent deletion is
the desired outcome.
