# Atlas Modernization — documentation index

_Revision: 2026-06-04_

This is the single entry point for project documentation. Docs are split into **project-level**
(this `docs/` tree, spanning every package) and **package-level** (each package's own `docs/`).

## Project-level docs (here)

| Location | What it holds | Use it when… |
| --- | --- | --- |
| [`docs/design-decisions/`](design-decisions/) | Durable architectural/implementation choices across the whole project (Atlas Core, Atlas Protocol, …). | "What did we decide, and why?" |
| [`docs/problems/`](problems/) | Short-lived agent-to-agent notes on active blockers (minutes to a day or two). Spans all packages. | "What is broken right now on this branch?" |

Start templates: [`design-decisions/_EXAMPLE_DESIGN_DECISION_.md`](design-decisions/_EXAMPLE_DESIGN_DECISION_.md),
[`problems/_EXAMPLE_PROBLEM_.md`](problems/_EXAMPLE_PROBLEM_.md).

## Packages

| Package | Docs | What it is |
| --- | --- | --- |
| `Atlas_Core/` | [`Atlas_Core/docs/`](../Atlas_Core/docs/README.md) | The Go HTTP API: handlers, actions, database, storage. Operational reference (pagination, errors, security, database workflow, entity/task/object shapes). |
| `Atlas_Protocol/` | [`Atlas_Protocol/index.html`](../Atlas_Protocol/index.html) | Foundational contract layer (direction, not yet built): one definition of the data model + verification, projected into Go/TS/DB. |

Use **`Atlas_Core/docs/`** when the question is "how does this API behave?"

## Other root files

- **`AGENTS.md`** — hard constraints and recurring agent gotchas for the whole repo.
- **`README.md`** — project overview and map.
