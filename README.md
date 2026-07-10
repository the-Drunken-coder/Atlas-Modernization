# Atlas Modernization

This workspace is the Atlas modernization repo: Core, Protocol, SDK, Command Interface, simulations, and project docs live here as separate modules that move together.

## What lives here

- **`Atlas_Core/`** — the core backend: the Go HTTP API, durable production database/object-store layer, Docker setup, and command catalog.
- **`atlas_protocol/`** — the buildable Atlas Protocol module: JSON Schema source, generated contracts, validators, examples, and protocol tooling.
- **`atlas_sdk/`** — the TypeScript/JavaScript Atlas SDK package: typed client, optional sync engine, CLI, and Node/browser test suites.
- **`atlas_command_interface/`** — Atlas Command interface: a Cloudflare Pages/Vite map console plus reusable command-model helpers.
- **`atlas_simulations/`** — local Atlas simulation workbench: trusted scenario scripts, server-side SDK clients, and a browser UI for running local simulation runs.
- **`docs/`** — project-level documentation that spans packages, including Atlas Protocol planning/reference docs in [`docs/atlas-protocol/`](docs/atlas-protocol/) and Atlas SDK design docs in [`docs/atlas-sdk/`](docs/atlas-sdk/).

## Agent guidance

- **`AGENTS.md`** — hard constraints, commands, and recurring gotchas for agents working in this repo.
- **`docs/README.md`** — the documentation index (project-level + per-package).
- **`docs/design-decisions/`** — durable architectural decisions across the project.
- **`docs/problems/`** — short-lived blockers between agent sessions (see `_EXAMPLE_PROBLEM_.md`).

## Runtime storage posture

Atlas Core preserves resource tables, `admin_records`, schema migration history,
and the configured MinIO bucket in production. Startup applies ordered
transactional migrations and rejects ledger/catalog drift before readiness.
Development Compose retains an explicit scratch mode that migrates/verifies the
schema, clears resource rows and MinIO, and preserves local `admin_records` plus
migration history.
