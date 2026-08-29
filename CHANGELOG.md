# Changelog

Atlas Core release notes are listed newest first. The manual release workflow writes each new section from the
verified commit history with OpenCode Go, then pauses for approval before publishing.

## 0.1.0 - 2026-08-29

### Added

- Installable `atlas-core` npm CLI for durable single-host deployments: `npm install --global atlas-core`, followed by `atlas-core init` and `atlas-core start`.
- CLI operations including `stop`, `restart`, `status`, `logs`, `doctor`, and `version`.

### Changed

- The packaged deployment requires Node.js 24 or newer, Docker Compose 2.17.0 or newer, and a local Linux Docker daemon on an arm64 or x64 macOS or Linux host.
- The initial packaged deployment binds Core, PostgreSQL, and MinIO to loopback and does not configure public ingress; operators must manage any reverse proxy or tunnel separately.
- Production PostgreSQL and MinIO storage is durable and must be backed up and restored as a matched pair. CLI stop and package removal preserve those volumes, and the CLI never enables destructive startup mode or removes volumes.
- Releases use the manually dispatched `Release Atlas Core` workflow. The first approved run creates the reviewed release commit and immutable tag; publication continues from that tag and verifies the pinned image, npm integrity, signatures, and provenance.
