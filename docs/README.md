# Atlas Modernization — documentation index

_Revision: 2026-08-27_

This is the single entry point for project documentation. Docs are split into **project-level**
(this `docs/` tree, spanning every package) and **package-level** (each package's own `docs/`).

## Project-level docs (here)

| Location | What it holds | Use it when… |
| --- | --- | --- |
| [`docs/atlas-change-feed/`](atlas-change-feed/) | Change feed design: websocket push contract, subscription filters, consumption rules, simulation-testing approach. | "How do clients learn about writes without polling?" |
| [`docs/atlas-plugins/`](atlas-plugins/) | Plugin architecture: operations, datastreams, external sources, isolation, and Core ownership. | "How does Atlas add external-data and extension capabilities?" |
| [`docs/atlas-protocol/`](atlas-protocol/) | Atlas Protocol design decisions and reference docs. | "Why is the protocol shaped this way?" |
| [`docs/atlas-sdk/`](atlas-sdk/) | Atlas SDK design: client architecture, sync engine/cache, unified reads, testing, known gaps. | "How do services talk to Atlas Core?" |
| [`docs/design-decisions/`](design-decisions/) | Durable architectural/implementation choices across the whole project (Atlas Core, Atlas Protocol, Atlas SDK, …). | "What did we decide, and why?" |
| [`docs/problems/`](problems/) | Short-lived agent-to-agent notes on active blockers (minutes to a day or two). Spans all packages. | "What is broken right now on this branch?" |

Start templates: [`design-decisions/_EXAMPLE_DESIGN_DECISION_.md`](design-decisions/_EXAMPLE_DESIGN_DECISION_.md),
[`problems/_EXAMPLE_PROBLEM_.md`](problems/_EXAMPLE_PROBLEM_.md).

## Packages

| Package | Docs | What it is |
| --- | --- | --- |
| `services/core/` | [`services/core/docs/`](../services/core/docs/README.md) | The Go HTTP API: handlers, actions, durable production database/storage, and explicit development scratch mode. Operational reference (pagination, errors, security, database workflow, entity/task/object shapes). |
| `packages/protocol/` | [`packages/protocol/README.md`](../packages/protocol/README.md) and [`docs/atlas-protocol/`](atlas-protocol/) | Buildable Atlas Protocol module: JSON Schema source, generated contracts, validators, examples, tooling, and planning/reference docs. |
| `packages/sdk/` | [`docs/atlas-sdk/`](atlas-sdk/) | TypeScript/JavaScript Atlas SDK package: typed client, optional sync engine, CLI, package metadata, and Node/browser test suites. |
| `packages/fieldlink/` | [`packages/fieldlink/docs/`](../packages/fieldlink/docs/README.md) | MeshCore transport, registered FieldLink messages, radio adapter, and hardware harness. |
| `edge/asset/` | [`edge/asset/README.md`](../edge/asset/README.md) | Reserved Asset role. No implementation exists yet. |
| `edge/gateway/` | [`edge/gateway/README.md`](../edge/gateway/README.md) | Reserved Gateway role. No implementation exists yet. |
| `edge/gateway/` | [`edge/gateway/README.md`](../edge/gateway/README.md) | Field Gateway ownership and dependency rules. No implementation exists yet. |
| `surfaces/command-interface/` | [`surfaces/command-interface/README.md`](../surfaces/command-interface/README.md) | Atlas Command interface: Cloudflare Pages-hosted map console. |
| `simulations/` | [`simulations/README.md`](../simulations/README.md) | Local simulation workbench for running trusted scenario scripts against Atlas Core through the SDK. |
| `tests/` | Root test scripts | Checks that compose more than one top-level module. |

Use **`services/core/docs/`** when the question is "how does this API behave?"

## Other root files

- **`AGENTS.md`** — hard constraints and recurring agent gotchas for the whole repo.
- **`CONTEXT.md`** — canonical Atlas domain terms and distinctions.
- **`README.md`** — project overview and map.
