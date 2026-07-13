# Atlas Modernization

This workspace is the Atlas modernization repo: Core, Protocol, SDK, asset runtime, Command Interface, simulations, and project docs live here as separate modules that move together.

## JavaScript toolchain

Active development and CI use Node 24 LTS, which is also the minimum declared runtime for every Node package. The root `.nvmrc` is the version source for local tools and GitHub Actions; the command interface mirrors it inside its Cloudflare Pages build root. Each independent package rejects installs on older runtimes through its own `.npmrc`.

The Node packages remain independent but share one root lockfile. Install and run their workspace commands from the repository root; for example:

```bash
nvm use
npm ci
npm run lint --workspace @the-drunken-coder/atlas-command-interface
npm run format:check --workspace @the-drunken-coder/atlas-command-interface -- --since=origin/main
```

Linting covers each package in full. Formatting is checked only for JavaScript/TypeScript files changed from the selected base so adopting the gate does not rewrite the existing codebase.

## What lives here

- **`Atlas_Core/`** — the core backend: the Go HTTP API, durable production database/object-store layer, Docker setup, and command catalog.
- **`atlas_protocol/`** — the buildable Atlas Protocol module: JSON Schema source, generated contracts, validators, examples, and protocol tooling.
- **`atlas_sdk/`** — the TypeScript/JavaScript Atlas SDK package: typed client, optional sync engine, CLI, and Node/browser test suites.
- **`atlas_asset_runtime/`** — the TypeScript/Node runtime for check-in-driven asset telemetry and command handling through the SDK.
- **`atlas_command_interface/`** — Atlas Command interface: a Cloudflare Pages/Vite map console plus reusable command-model helpers.
- **`atlas_simulations/`** — local Atlas simulation workbench: trusted scenario scripts, server-side SDK clients, and a browser UI for running local simulation runs.
- **`docs/`** — project-level documentation that spans packages, including Atlas Protocol planning/reference docs in [`docs/atlas-protocol/`](docs/atlas-protocol/) and Atlas SDK design docs in [`docs/atlas-sdk/`](docs/atlas-sdk/).

## JavaScript workspace

The SDK, asset runtime, command interface, and simulations are npm workspaces with one root lockfile. Use Node.js 24 and install their dependencies once from the repository root:

```bash
npm ci
npm run build
```

The asset runtime declares `@the-drunken-coder/atlas-sdk` as a normal dependency and consumes only its public exports. Simulations use the runtime for asset behavior while retaining direct SDK access for scenario orchestration. Root scripts build those dependencies in order so a clean checkout exercises the same package boundaries and built artifacts that published packages will expose.

Useful focused commands are `npm run build:sdk`, `npm run build:asset-runtime`, `npm run build:command-interface`, `npm run build:simulations`, `npm run dev:command-interface`, `npm run dev:simulations`, and `npm run dev:simulations-server`.

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
