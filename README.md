# Atlas Modernization

This workspace is focused on modernizing the ATLAS Core backend.

## What lives here

- **`Atlas_Core/`** — the core backend: the Go HTTP API, database layer, Docker setup, and command catalog.
- **`Atlas_Protocol/`** — foundational contract layer (direction, not yet built): one definition of the data model and its verification, meant to be projected into Go, TypeScript, and the database. See [`Atlas_Protocol/index.html`](Atlas_Protocol/index.html).
- **`docs/`** — project-level documentation that spans packages.

## Agent guidance

- **`AGENTS.md`** — hard constraints, commands, and recurring gotchas for agents working in this repo.
- **`docs/README.md`** — the documentation index (project-level + per-package).
- **`docs/design-decisions/`** — durable architectural decisions across the project.
- **`docs/problems/`** — short-lived blockers between agent sessions (see `_EXAMPLE_PROBLEM_.md`).
