# Atlas Modernization

This workspace is the Atlas monorepo. Hosted services, operator surfaces, field software, reusable packages, simulations, cross-system tests, and project docs move together without sharing ownership.

## JavaScript toolchain

Active development and CI use Node 24 LTS, which is also the minimum declared runtime for every Node package. The root `.nvmrc` is the version source for local tools and GitHub Actions; the command interface mirrors it inside its Cloudflare Pages build root. Each independent package rejects installs on older runtimes through its own `.npmrc`.

The Node packages remain independent but share one root lockfile. Install and run their workspace commands from the repository root; for example:

```bash
nvm use
npm ci
npm run lint --workspace @the-drunken-coder/atlas-command-interface
npm run format:check --workspace @the-drunken-coder/atlas-command-interface
```

Linting and formatting checks cover each selected package in full, matching the commands run by CI.

## Repository map

- `services/core/` contains the hosted Go control plane, durable storage integration, and deployment files.
- `surfaces/core-cli/` contains the published `atlas-core` npm CLI for one durable single-host deployment.
- `surfaces/command-interface/` contains the operator-facing Cloudflare Pages/Vite application.
- `edge/asset/` reserves the field Asset role. It contains only a README while the Asset architecture is being designed.
- `edge/gateway/` reserves the field Gateway role. It contains only a README while the Gateway architecture is being designed.
- `packages/protocol/` contains the Atlas schema, generated contracts, validators, examples, and protocol tools.
- `packages/sdk/` contains the TypeScript/JavaScript Atlas client, sync engine, and CLI.
- `packages/fieldlink/` contains FieldLink's MeshCore transport, registered messages, radio adapter, and hardware harness. FieldLink is one communication method, not the Asset architecture.
- `simulations/` contains the local simulation workbench.
- `tests/` contains checks that cross top-level ownership lines.
- `docs/` contains project-wide documentation and design decisions.

## JavaScript workspace

The SDK, FieldLink, Atlas Core CLI, command interface, and simulations are npm workspaces with one root lockfile. Use Node.js 24 and install their dependencies once from the repository root:

```bash
npm ci
npm run build
```

Simulations use the SDK directly. FieldLink remains independent of Core, the SDK, and Asset policy. No Asset or Gateway implementation currently exists under `edge/`.

Useful focused commands are `npm run build:sdk`, `npm run build:fieldlink`, `npm run build:core-cli`, `npm run build:command-interface`, `npm run build:simulations`, `npm run dev:command-interface`, `npm run dev:simulations`, and `npm run dev:simulations-server`.

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
