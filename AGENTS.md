# Agent guidance

Keep only durable, non-obvious repository constraints here; report surprises and record recurring lessons. Put subsystem behavior in nearby READMEs or design decisions, code reasoning beside code, and temporary blockers in `docs/problems/`.

## Working principles

- Atlas is greenfield, with no users or production data. Understand affected behavior and constraints, then choose the simplest design meeting required functionality and performance. Avoid compatibility shims, duplicated paths, speculative abstractions, and unrelated refactors. Prefer direct code unless helpers improve clarity, error handling, or existing reuse.
- Challenge unnecessary complexity. During planning, propose broader alternatives with scope and tradeoffs, but obtain approval before expanding implementation scope.
- Treat documentation as a constraint. Cite conflicts and ask whether to preserve or supersede the documented direction. Update every affected document and design decision when direction changes.
- Ask about ambiguous UI selection, focus, hover, keyboard, or pointer behavior; confirm user-visible precedence.
- Edit source, examples, templates, or generators, not disposable outputs/configuration: `node_modules/`, `dist/`, `storybook-static/`, `.wrangler/`, `worker-configuration.d.ts`, or `services/core/docker/.env`.

## Repository boundaries

- `services/core/` and `packages/protocol/` are separate Go modules. npm workspaces share the root lockfile; use Node 24 from `.nvmrc`, install at the root, and consume public package exports.
- Protocol source of truth: `packages/protocol/schema/jsonschema/atlas.schema.json`. The authored Go API is `packages/protocol/generated/go/atlasprotocol/types.go`; regenerate with `go run ./tools/generate` in `packages/protocol/`. Protocol docs belong in `docs/atlas-protocol/`.
- `services/` hosts central software, `surfaces/` operator software, `edge/` field software, and `packages/` reusable code. Packages must not import the other three. `edge/asset` is the first supported Asset Host. Keep `edge/gateway` README-only until its architecture is approved.
- One logical Asset has one Asset Host; attached controllers, autopilots, sensors, and radios are peripherals, not Atlas compute nodes.
- Parse requests in HTTP handlers, orchestrate in actions/services, and name non-trivial wire types. Reuse typed patch/resource helpers instead of parallel JSON mutation pipelines, promoted-field lists, or broad TypeScript casts.
- The command interface is static Cloudflare Pages/Vite; its browser SDK calls Core directly. Never recreate the Worker proxy or runtime config/auth/API routes. For interface work, read `surfaces/command-interface/README.md`.

## Safety

- Core production storage is durable; development Compose is destructive scratch storage. Never run scratch mode or older destructive stacks against retained data. For database/deployment work, follow `services/core/docs/DATABASE_WORKFLOW.md` and `services/core/docs/DEPLOYMENT_RUNBOOK.md`.
- Simulations default to loopback Core. For deployed runs, follow `simulations/README.md`; never bypass confirmation, target identity, credential, or cleanup-ledger safeguards.

## Workflow and validation

- Start with `git status --short --branch` and `git worktree list`; verify branch ownership before editing. Directory names may misrepresent the checkout.
- Run the narrowest relevant checks from `.github/workflows/ci.yml` or the package README, plus `git diff --check`.
- For documentation-only changes, check links, paths, and whitespace. Broaden checks only if generated artifacts, module wiring, or runtime behavior are affected.

## Task guidance

- Tracking work: `docs/agents/issue-tracker.md`. Use GitHub Issues for persistent work and `docs/problems/` for verified temporary defects.
- Triaging issues: `docs/agents/triage-labels.md` defines canonical labels.
- Domain documentation: follow `docs/agents/domain.md` for Atlas's multiple contexts.
- Planning, implementation, or defects: choose the applicable workflow in `docs/agents/workflow.md`.
