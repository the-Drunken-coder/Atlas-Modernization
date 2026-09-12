# Atlas Core CLI

`atlas-core` installs and operates one durable Atlas Core deployment on an arm64 or x64 macOS or Linux host with Docker Compose. Docker Buildx is also required to read raw OCI manifests when Docker's manifest inspection cannot verify their serialization.
The npm package is the operator interface. Atlas Core itself runs from the matching
`ghcr.io/the-drunken-coder/atlas-core` container image.

## Install

Install Node.js 24 or newer and Docker with Compose 2.17.0 or newer, then install the CLI globally. The CLI requires a
local Linux Docker daemon over a Unix socket so its deployment and durable storage remain bound to one host.

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
After initialization, install and load the recovery service with `atlas-core supervision install` before using the
default `atlas-core start` or `atlas-core restart`; use `--manual` only when an intentional one-shot start or restart
is acceptable.

The menu is a user-friendly layer over the same commands shown below. Those commands remain available for scripts and
direct operation.

## Commands

```text
atlas-core
atlas-core help
atlas-core init
atlas-core start [--manual]
atlas-core stop
atlas-core restart [--manual]
atlas-core reset [--manual]
atlas-core config
atlas-core update [cli|all]
atlas-core status
atlas-core logs [core|source-gateway|postgres|minio] [--follow]
atlas-core doctor
atlas-core supervision [install|uninstall|status]
atlas-core version
atlas-core plugins
atlas-core plugins enable <plugin_id>
atlas-core plugins disable <plugin_id>
atlas-core plugins status [plugin_id]
atlas-core plugins logs <plugin_id> [--follow]
atlas-core plugins install <plugin_id> [version]
atlas-core plugins update <plugin_id|all>
atlas-core plugins rollback <plugin_id>
atlas-core plugins uninstall <plugin_id>
atlas-core plugins refresh
atlas-core plugins rotate-core-key
atlas-core recover status
atlas-core recover retry
atlas-core recover forward <version>
atlas-core recover restored --confirm-paired-restore
atlas-core supervise
```

## Plugins

Implementation status: the independent Plugin lifecycle and release workflow are implemented in this worktree, and
local validation passes. The candidate-image Docker acceptance test still awaits CI. The approved terminal UI redesign is specified in [GitHub issue #359](https://github.com/the-Drunken-coder/Atlas-Modernization/issues/359); the current runtime is unchanged. Existing
published Core packages may still use the bundled Plugin catalog; schema-4 deployments use independent catalog state.
Production catalog signing, trust bootstrap, and Pages rollout remain external setup. The accepted independent release
design is documented in [`../../docs/design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md`](../../docs/design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md).
The independent command behavior is specified in [`../../docs/atlas-plugins/MANAGEMENT.md`](../../docs/atlas-plugins/MANAGEMENT.md).

The `Plugins` menu and matching commands manage trusted, query-only Plugins. Schema-4 deployments read the signed catalog
and local Installed Plugin records. Schema-3 deployments retain the bundled catalog only for the explicit transition:
disable bundled Plugins with the matching v1 CLI, update Core, and install independent releases afterward. Building Scan
is available as an opt-in first-party Plugin; no Plugin is enabled by default. The CLI does not accept arbitrary paths,
images, or third-party bundles.

Enabling a Plugin pulls the catalog's immutable image digest, stages its private Compose and configuration fragments,
validates the complete Compose model, and then commits the new state. A running deployment starts the Plugin and
restarts Core and Source Gateway with a health wait. A stopped deployment stays stopped. Failure restores the previous
files, state, and running composition. Disabling first validates the candidate deployment, records a small durable intent
with the deployed Plugin metadata, and commits the Plugin's disabled state before removing its container or files. An
interrupted disable is retried idempotently from either side of that state commit. A later enable first finishes the
Plugin-free runtime and pending disable before pulling or staging the Plugin again. `stop` durably changes every pending
disable target to stopped before it runs Compose down with orphan removal, then settles the files while Core remains
stopped. A retry cannot restart a deployment after a stop attempt.
Core status, details, and logs plus Plugin status use the committed state and staged deployment metadata, so they remain
useful during the destructive part of a disable and after catalog drift. Dead-owner reclaim covers Plugin-disable work
and Docker engine-transition recovery. Plugin disable waits for its recorded Docker process group to exit. Both paths
verify the exact Docker network lock ID before removal. The CLI pins the validated local Docker socket for every command
in a mutation and verifies the daemon ID again after every Docker or Compose command. If the socket starts serving a
different daemon, the CLI retains an engine-bound recovery owner and refuses local state changes. Restore the original
daemon and retry the command to remove its lock and continue.
Disabling keeps the cached image. Independent Plugin mutations use the installed Core's retained bundle and exact image,
so a Plugin update does not publish or install a new Core version. Status and logs remain available after a CLI-only
update. Direct commands print each mutation stage.

The host manager provisions and rotates its shared SDK Plugin key through the host-only `atlas_core managed-keys`
executable inside the exact running Core container. The subcommands are `create <name>`, `list <name>`, and
`revoke <key_id>`. They call Core's existing admin domain operations and do not add an HTTP or CORS bypass, accept an
API-key management credential, or run migrations. Operators use `atlas-core plugins rotate-core-key`; the container
executable is an internal transaction step.

If a process dies during a mutation, `atlas-core recover status` reports the phase and required action. `recover retry`
uses the same exact staged candidate. `recover forward <version>` stages a newly verified compatible Core target while
stopped, without the ordinary running-deployment guard. After an operator restores the paired PostgreSQL and MinIO
backup, `recover restored --confirm-paired-restore` compares the prior migration ledger, retained image and bundle
receipts, and backup identity before completing; it does not perform the restore. Once a target Core has started, the CLI
never auto-restores the old Core image. An explicit `atlas-core stop` records a stopped `run-intent.json` and wins over
automatic resume from `start` or `supervise`.

Retained base and generated Plugin services use `restart: "no"`, so Compose and Docker cannot start around recovery.
`atlas-core supervise` is the recovery-aware long-lived startup path. A Linux user service needs lingering enabled for
boot-time recovery. A macOS LaunchAgent runs after login and cannot provide pre-login recovery. The default `start` and
`restart` require an installed and loaded supervisor; `start --manual` and `restart --manual` are the explicit one-shot
exceptions without an automatic recovery guarantee.
Supervisor definitions pin the validated local Docker socket, clear inherited Docker context overrides, and record the
CLI version. A CLI upgrade reinstalls active matching supervision with the newly installed CLI before updating Core.
An active service whose definition does not match the selected deployment must be reinstalled explicitly first.
The Plugins menu keeps the operation in an activity view with elapsed timestamps, reports rollback status, and returns
to the Plugin catalog after safe cancellation.

The menu's `Configure` action opens a configuration menu. `Admin account` changes the password for the fixed `admin`
username. The direct `config` command opens the same hidden password prompt. The password must contain at least 12
characters and is never accepted as a command argument, which keeps it out of shell history and process listings. No
other deployment settings are exposed yet.

When Core is running, `config` restarts it so the new password applies to subsequent logins. When Core is stopped, the
new password applies on the next start. Existing browser sessions expire normally. The initial random password remains
in `~/.atlas/core/.env` until the operator changes it. A running password change requires every Core and enabled Plugin
service to be healthy before disruption. If it then fails, the CLI verifies the previous configuration before starting
that deployment again. If configuration restoration cannot be verified, Atlas Core stays stopped.

## Updates

The menu's `Update` action checks the npm `latest` release and shows the installed CLI version, running Core version,
and available release before changing anything. Choose one of two update scopes:

- `Update CLI only` or `atlas-core update cli` installs the latest global CLI through the current npm prefix. The
  running Atlas Core containers, credentials, and durable storage stay unchanged.
- `Update CLI + Atlas Core` or `atlas-core update all` installs the latest CLI, pulls that release's digest-pinned Core
  image, and restarts a running deployment against the existing PostgreSQL and MinIO volumes. It does not select or
  publish Plugin releases; Plugin updates use `atlas-core plugins update <plugin_id|all>` and the retained Core bundle.
  A stopped deployment stays stopped. A schema-3 deployment still follows its bundled-catalog transition rules and
  refuses a target catalog that no longer contains an enabled Plugin.

Core releases may carry schema migrations. Before a Core update, create and validate the paired PostgreSQL and MinIO
backup described in the [deployment runbook](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/main/services/core/docs/DEPLOYMENT_RUNBOOK.md#pre-deploy-backup).
The released menu review screen and `atlas-core update all` both require confirmation that a current paired backup exists.
Set `ATLAS_CORE_BACKUP_DIR` to that backup directory’s absolute path before updating. The CLI records a content hash of
the dump, bucket mirror, and runbook metadata. Preserve the pair and select it again with the same environment variable
when running `recover restored --confirm-paired-restore`; recovery requires the recorded hash to match. This identifies
the backup artifacts and does not prove that the operator restored them.
The approved future update policy in [issue #368](https://github.com/the-Drunken-coder/Atlas-Modernization/issues/368) removes this prerequisite while retaining restored recovery only for receipt-bearing journals.
CLI-only updates do not require a deployment backup because they do not change the running Core or its stores.

CLI-only updates may leave the CLI newer than the running Core. Status, logs, diagnostics, stop, reset, and the explicit
update flow remain available in that state. Start and restart refuse to change Core implicitly and direct the operator
to `atlas-core update all`. This applies only when both releases use the current engine-scoped resource layout.

State schemas 1 and 2 belong to the retired fixed-name experimental layout. Schema 3 is the current bundled deployment
state with the `engine-scoped-v1` layout. Independent Plugin management uses schema 4. The first independent Core
transition does not infer receipts from enabled bundled Plugins; disable them with the matching v1 CLI first. This CLI
does not migrate the old fixed-name layout, and even `reset` refuses old state so it cannot delete the wrong namespace.
That first schema-3 transition applies an engine-locked Docker `restart=no` preflight to the recorded legacy containers
before stopping the old Compose project; its imported base candidate also normalizes legacy Compose restart fields. This
prevents an old `unless-stopped` policy from racing the transition without changing live state or durable volumes.
Before replacing a CLI that wrote schema 1 or 2, stop and remove that experiment's fixed-name
containers and paired volumes with the old package's Compose assets, then remove its matching `ATLAS_CORE_HOME`.
That cleanup permanently deletes the old PostgreSQL and MinIO data. Install this CLI and run `atlas-core init` only
after the old deployment and configuration are gone.

For a running deployment, the CLI records the new Core version only after Docker reports the updated services healthy.
For a stopped deployment, it records the version after pulling the reviewed image and leaves Core stopped. If an update
fails, it does not delete credentials or volumes and leaves the recorded Core version unchanged so the operator can
inspect logs and retry. Updating the global CLI requires write access to the npm prefix where `atlas-core` is installed.

`stop` removes containers and the private Compose network. It preserves PostgreSQL and MinIO volumes. Removing the
npm package also leaves those durable volumes untouched.

`reset` is the explicit exception. It first requires a valid ready deployment state in the selected `ATLAS_CORE_HOME`
that matches the current Docker engine. It then permanently deletes the known Atlas Core containers, both durable
volumes, and the credentials and state in that home before creating new credentials and empty storage and starting the
image pinned by the installed CLI package. Reset is for intentionally discarding an initialized deployment, not for
updates. Use `atlas-core update all` to move an existing deployment to the newest release without deleting its data.

Before deleting anything, reset requires active recovery supervision. Use `atlas-core reset --manual` to explicitly acknowledge running without automatic recovery, as with `start --manual`.

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
binds the state directory to the Docker engine that initialized it, derives the Compose project and resource names from
that immutable engine ID, and verifies Docker Compose and engine ownership labels before using an existing container or
volume. The engine-derived namespace prevents a same-socket daemon replacement from redirecting a destructive command
into the replacement daemon's live Atlas deployment. A post-command daemon check prevents the CLI from committing local
state based on a command that reached a replacement engine. Initialization also takes a daemon-wide project lock, so
different configuration directories cannot initialize the same deployment concurrently.

If `init` finds existing Atlas volumes without its matching configuration, it stops. Recover the credentials and paired
storage unless you intend to discard the deployment. Use the confirmed `reset` command only when permanent deletion is
the desired outcome.

Image platform selection uses the local Docker daemon architecture, including when Node runs under Rosetta.

## Platform acceptance

The portable package check builds the current CLI, packs it, installs it into a
temporary npm consumer, and executes its installed binary. It runs the help and
version commands and confirms that initialization rejects a non-Linux Docker
daemon before writing configuration. The latter uses a controlled Docker-command
fake to verify the packaged validation path; it does not establish Docker
acceptance.

From the repository root, after `npm ci`, run:

```bash
npm run test:portable-package --workspace atlas-core
```

By default, each run writes a uniquely named
`$TMPDIR/atlas-core-portable-package-evidence-*.json` file. Set
`ATLAS_CORE_PACKED_CLI_EVIDENCE` to an absolute JSON output path to override it.
The file records the revision, Node runtime, host OS and architecture, native or
emulated execution, each completed scenario, and the packed artifact's filename,
SHA-1, and npm integrity hash. A failed run preserves its tarball next to the
evidence file. The dedicated `CLI platform acceptance` workflow runs this check
natively on the following GitHub-hosted runners and uploads that evidence for
every run:

| Host | Architecture | Execution mode | Docker acceptance |
| --- | --- | --- | --- |
| `ubuntu-24.04` | x64 | packed npm consumer | not established here |
| `ubuntu-24.04-arm` | arm64 | packed npm consumer | not established here |
| `macos-15-intel` | x64 | packed npm consumer | unavailable in this workflow |
| `macos-15` | arm64 | packed npm consumer | unavailable in this workflow |

The CLI only supports macOS and Linux x64/arm64 hosts and requires Node.js 24+
and Docker Compose 2.17.0+. Any command that configures or operates a deployment
also requires a local Linux Docker daemon over a Unix socket. Portable checks and
macOS runner results are not evidence that a Docker deployment works. The
existing `.github/scripts/test-atlas-core-package.sh` is the disposable Linux
Docker lifecycle acceptance command; its multi-architecture execution and
evidence are tracked separately from this portable package workflow.
