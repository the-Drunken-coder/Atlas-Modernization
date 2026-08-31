# Changelog

Atlas Core release notes are listed newest first. The manual release workflow writes each new section from the
verified commit history with OpenCode Go, then pauses for approval before publishing.

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
