# Atlas Modernization — documentation index

_Revision: 2026-06-12_

This is the single entry point for project documentation. Docs are split into **project-level**
(this `docs/` tree, spanning every package) and **package-level** (each package's own `docs/`).

## Project-level docs (here)

| Location | What it holds | Use it when… |
| --- | --- | --- |
| [`docs/atlas-change-feed/`](atlas-change-feed/) | Change feed planning: websocket push contract, subscription filters, simulation-testing approach, open questions. | "How do clients learn about writes without polling?" |
| [`docs/atlas-protocol/`](atlas-protocol/) | Atlas Protocol planning, implementation prep, and goals/reference docs. | "Why is the protocol shaped this way, and what remains planned?" |
| [`docs/atlas-sdk/`](atlas-sdk/) | Atlas SDK planning: client architecture, sync engine/cache, unified reads, build phases. | "How should services talk to Atlas Core, and what is the SDK going to be?" |
| [`docs/design-decisions/`](design-decisions/) | Durable architectural/implementation choices across the whole project (Atlas Core, Atlas Protocol, …). | "What did we decide, and why?" |
| [`docs/problems/`](problems/) | Short-lived agent-to-agent notes on active blockers (minutes to a day or two). Spans all packages. | "What is broken right now on this branch?" |

Start templates: [`design-decisions/_EXAMPLE_DESIGN_DECISION_.md`](design-decisions/_EXAMPLE_DESIGN_DECISION_.md),
[`problems/_EXAMPLE_PROBLEM_.md`](problems/_EXAMPLE_PROBLEM_.md).

## Packages

| Package | Docs | What it is |
| --- | --- | --- |
| `Atlas_Core/` | [`Atlas_Core/docs/`](../Atlas_Core/docs/README.md) | The Go HTTP API: handlers, actions, disposable runtime database/storage. Operational reference (pagination, errors, security, database workflow, entity/task/object shapes). |
| `atlas_protocol/` | [`atlas_protocol/README.md`](../atlas_protocol/README.md) and [`docs/atlas-protocol/`](atlas-protocol/) | Buildable Atlas Protocol module: CUE source, generated contracts, validators, examples, tooling, and planning/reference docs. |

Use **`Atlas_Core/docs/`** when the question is "how does this API behave?"

## Other root files

- **`AGENTS.md`** — hard constraints and recurring agent gotchas for the whole repo.
- **`README.md`** — project overview and map.
