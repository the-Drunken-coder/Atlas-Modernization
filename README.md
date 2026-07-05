# Atlas Modernization

This workspace is the Atlas modernization repo: Core, Protocol, SDK, Command Interface, simulations, and project docs live here as separate modules that move together.

## What lives here

- **`Atlas_Core/`** — the core backend: the Go HTTP API, disposable runtime database/object-store layer, Docker setup, and command catalog.
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

Atlas Core treats resource tables and its configured MinIO bucket as scratch
runtime state. They are useful while the service is running, but they are not
systems of record and are not meant to be kept around. By default, startup drops
and recreates resource tables and clears the configured object bucket so the
running service always matches the current code. The `admin_records` table is
the narrow durable exception for operator credentials, sessions, login throttles,
and managed API key metadata.
