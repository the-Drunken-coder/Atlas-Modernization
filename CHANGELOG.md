# Changelog

Atlas Core release notes are listed newest first. The manual release workflow writes each new section from the
verified commit history with OpenCode Go, then pauses for approval before publishing.

## 0.2.1 - 2026-09-11

### Fixed

- Generated Plugin endpoint and Source Gateway connector files are now readable by container users. Credentials and release receipts remain owner-only.
- Retained deployment files no longer inherit group or world write permissions from npm installations, preventing Plugin template rejection under umask `0002`.
- Release verification allows five minutes of retry delays for npm to expose an accepted package and its provenance.

## 0.2.0 - 2026-09-11

### Added

- Movement history is available through authenticated history, trail, import, and point-inspection routes, with 30-day retention and bounded pagination and trail queries.
- Schema-4 deployments can install, enable, disable, update, roll back, uninstall, and refresh independently released trusted Plugins with `atlas-core plugins`.

### Changed

- Plugin releases no longer require publishing or installing a new Atlas Core version. Plugin updates use the installed Core bundle and require explicit operator approval.
- The independent Plugin manager uses schema 4. Before moving a schema-3 deployment from bundled Plugins, disable them with the matching v1 CLI, update Core, and install the independent releases.
- Movement history is durable Atlas storage and must be backed up and restored with the paired PostgreSQL and MinIO store; development scratch resets clear it.
- MeshCore transport has been retired. Meshtastic Link is the maintained radio communication method.

## 0.1.8 - 2026-09-08

### Breaking changes

- The CLI now requires state schema 3 and Docker resource names scoped to the Docker engine. Deployments created by earlier releases cannot update in place. Before installing this release, use the old package's Compose assets to stop and remove the old containers and paired PostgreSQL and MinIO volumes, then remove the matching `ATLAS_CORE_HOME`. This permanently deletes the old deployment's data. See `surfaces/core-cli/README.md` for the transition requirements.

### Changed

- Atlas Core lifecycle and Plugin operations now recover interrupted changes safely, preserve stopped deployments as stopped, and report operation progress in the terminal UI.
- Production deployment startup verifies the paired PostgreSQL and MinIO storage set before stopping or starting containers; durable storage remains preserved by ordinary lifecycle commands.
- Plugin endpoint origins and Source Gateway connector origins are validated before use, and Source Gateway reports admission timeouts separately from upstream timeouts.
- The `Release Atlas Core` workflow now publishes after one approval and retries the authorization upload after creating the release tag. Its disposable-host acceptance test uses the current engine-scoped resource names.

## 0.1.7 - 2026-09-01

### Added

- The `atlas-core plugins` commands manage trusted, query-only Plugins from the installed catalog. Building Scan is available as an opt-in first-party Plugin.

### Changed

- Enabling a catalog Plugin stages its Compose and configuration fragments, validates the complete Compose model, and restarts the affected services; a stopped deployment stays stopped and a failed change restores the previous state.
- Catalog Plugin images are released with Atlas Core for `linux/amd64` and `linux/arm64` and pinned by immutable digest in the CLI package. Plugin mutations require matching CLI and deployment versions.

## 0.1.6 - 2026-08-31

### Added

- The interactive `atlas-core` menu, status view, and update flow now use an Ink-based terminal interface with terminal-size guidance and keyboard navigation.

### Changed

- The release workflow now prepares and verifies release artifacts before publication, builds Atlas Core images for `linux/amd64` and `linux/arm64`, and publishes from the immutable release tag.

## 0.1.5 - 2026-08-30

### Added

- Core now supports configured trusted Plugins through authenticated `GET /plugins` discovery and `POST /plugins/{plugin_id}/operations/{operation_id}` synchronous JSON operations, with bounded requests, responses, timeouts, cancellation, and Plugin-specific error codes.
- The Compose deployment now includes a private Source Gateway for configured external-source connectors. Operators can set `ATLAS_SOURCE_GATEWAY_CONFIG_FILE`; connector credentials are supplied through environment variables or files rather than stored in connector configuration or Atlas resources.

### Changed

- Plugin and Source Gateway configuration is deployment-owned; installing or upgrading a Plugin requires changing deployment configuration or its image and restarting the Compose deployment. Production starts with no configured Plugins or Source Gateway connectors by default.
- Source Gateway connectors enforce configured origins, egress policy, header allowlists, request and response limits, rate limits, caching, retries, and circuit breaking. Plugin or Source Gateway failures do not change Core liveness or readiness.
- The Core-to-Plugin protocol has no version negotiation or compatibility layer, so coordinated Plugin and deployment updates are required when that contract changes.

## 0.1.4 - 2026-08-30

### Added

- `atlas-core status` and the interactive status view now show deployment state, Core and CLI versions, service health, image details, uptime, restart counts, and Docker resource metrics, with service log access and refresh and diagnostics actions.
- `atlas-core update [cli|all]` and the interactive update flow check the npm `latest` release and support updating only the CLI or updating the CLI and Atlas Core together.

### Changed

- Core updates require confirmation of a current paired PostgreSQL and MinIO backup, preserve credentials and durable storage, and leave a stopped deployment stopped.
- A failed update leaves credentials, durable volumes, and the recorded Core version unchanged for inspection and retry; CLI-only updates leave the running Core unchanged.

## 0.1.3 - 2026-08-30

### Added

- Running `atlas-core` without arguments now opens an interactive operator menu for initialization, lifecycle actions, admin configuration, logs, diagnostics, and reset.
- The menu supports arrow-key navigation, typing to filter actions, Enter to select, and Escape or `q` to exit; it requires an interactive terminal.

### Changed

- The existing commands remain available for scripts and direct operation after installing the CLI with `npm install --global atlas-core`.

## 0.1.2 - 2026-08-30

### Added

- `atlas-core reset` now provides an explicit, confirmation-gated way to permanently delete the Atlas Core containers, PostgreSQL and MinIO volumes, credentials, and state, then recreate empty storage and start the installed release.
- To reset onto the newest release, install `atlas-core@latest` before running `atlas-core reset`.

### Security

- Reset verifies Atlas Core ownership labels and stops before deletion if either durable volume is used by an unknown container.

## 0.1.1 - 2026-08-29

### Fixed

- `atlas-core init` now reads Docker container ownership labels correctly when checking for existing Atlas Core containers.
- Release verification now installs `atlas-core@$VERSION` in a clean consumer before auditing npm signatures.

## 0.1.0 - 2026-08-29

### Added

- Installable `atlas-core` npm CLI for durable single-host deployments: `npm install --global atlas-core`, followed by `atlas-core init` and `atlas-core start`.
- CLI operations including `stop`, `restart`, `status`, `logs`, `doctor`, and `version`.

### Changed

- The packaged deployment requires Node.js 24 or newer, Docker Compose 2.17.0 or newer, and a local Linux Docker daemon on an arm64 or x64 macOS or Linux host.
- The initial packaged deployment binds Core, PostgreSQL, and MinIO to loopback and does not configure public ingress; operators must manage any reverse proxy or tunnel separately.
- Production PostgreSQL and MinIO storage is durable and must be backed up and restored as a matched pair. CLI stop and package removal preserve those volumes, and the CLI never enables destructive startup mode or removes volumes.
- Releases use the manually dispatched `Release Atlas Core` workflow. The first approved run creates the reviewed release commit and immutable tag; publication continues from that tag and verifies the pinned image, npm integrity, signatures, and provenance.
