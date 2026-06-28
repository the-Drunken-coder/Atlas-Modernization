# Atlas Modernization — documentation index

_Revision: 2026-06-20_

This is the single entry point for project documentation. Docs are split into **project-level**
(this `docs/` tree, spanning every package) and **package-level** (each package's own `docs/`).

## Project-level docs (here)

| Location | What it holds | Use it when… |
| --- | --- | --- |
| [`docs/atlas-change-feed/`](atlas-change-feed/) | Change feed design: websocket push contract, subscription filters, consumption rules, simulation-testing approach. | "How do clients learn about writes without polling?" |
| [`docs/atlas-protocol/`](atlas-protocol/) | Atlas Protocol design decisions, bootstrap-era implementation prep, and reference docs. | "Why is the protocol shaped this way?" |
| [`docs/atlas-sdk/`](atlas-sdk/) | Atlas SDK design: client architecture, sync engine/cache, unified reads, testing, known gaps. | "How do services talk to Atlas Core?" |
| [`docs/design-decisions/`](design-decisions/) | Durable architectural/implementation choices across the whole project (Atlas Core, Atlas Protocol, Atlas SDK, …). | "What did we decide, and why?" |
| [`docs/problems/`](problems/) | Short-lived agent-to-agent notes on active blockers (minutes to a day or two). Spans all packages. | "What is broken right now on this branch?" |

Start templates: [`design-decisions/_EXAMPLE_DESIGN_DECISION_.md`](design-decisions/_EXAMPLE_DESIGN_DECISION_.md),
[`problems/_EXAMPLE_PROBLEM_.md`](problems/_EXAMPLE_PROBLEM_.md).

## Packages

| Package | Docs | What it is |
| --- | --- | --- |
| `Atlas_Core/` | [`Atlas_Core/docs/`](../Atlas_Core/docs/README.md) | The Go HTTP API: handlers, actions, disposable runtime database/storage. Operational reference (pagination, errors, security, database workflow, entity/task/object shapes). |
| `atlas_protocol/` | [`atlas_protocol/README.md`](../atlas_protocol/README.md) and [`docs/atlas-protocol/`](atlas-protocol/) | Buildable Atlas Protocol module: CUE source, generated contracts, validators, examples, tooling, and planning/reference docs. |
| `atlas_sdk/` | [`docs/atlas-sdk/`](atlas-sdk/) | TypeScript/JavaScript Atlas SDK package: typed client, optional sync engine, CLI, package metadata, and Node/browser test suites. |
| `atlas_command_interface/` | [`atlas_command_interface/README.md`](../atlas_command_interface/README.md) | Atlas Command interface plumbing: Worker proxy/API routes and reusable command-model helpers. |
| `atlas_simulations/` | [`atlas_simulations/README.md`](../atlas_simulations/README.md) | Local simulation workbench for running trusted scenario scripts against Atlas Core through the SDK. |

Use **`Atlas_Core/docs/`** when the question is "how does this API behave?"

## Other root files

- **`AGENTS.md`** — hard constraints and recurring agent gotchas for the whole repo.
- **`README.md`** — project overview and map.
