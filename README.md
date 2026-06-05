# Atlas Modernization

This workspace is focused on modernizing the ATLAS Core backend.

## What lives here

- **`Atlas_Core/`** — the core backend: the Go HTTP API, database layer, Docker setup, and command catalog.
- **`atlas_protocol/`** — the buildable Atlas Protocol module: CUE source, generated contracts, validators, examples, and protocol tooling.
- **`docs/`** — project-level documentation that spans packages, including Atlas Protocol planning/reference docs in [`docs/atlas-protocol/`](docs/atlas-protocol/).

## Agent guidance

- **`AGENTS.md`** — hard constraints, commands, and recurring gotchas for agents working in this repo.
- **`docs/README.md`** — the documentation index (project-level + per-package).
- **`docs/design-decisions/`** — durable architectural decisions across the project.
- **`docs/problems/`** — short-lived blockers between agent sessions (see `_EXAMPLE_PROBLEM_.md`).
