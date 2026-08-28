# Agent guidance

Keep this file limited to durable, repository-wide constraints that are easy to miss from code or documentation. When the project surprises you, tell the developer and add a concise note here only if the lesson is likely to recur. Put subsystem behavior in its nearest README or design decision, code-specific reasoning beside the code, and temporary blockers in `docs/problems/`.

## Working principles

- Atlas is greenfield and has no users or production data yet. Prefer the simplest correct long-term design over compatibility shims, duplicated paths, or preserving an awkward implementation.
- Measure twice, cut once. Understand the problem, constraints, and current behavior before building; cleverness is often what gets written when the problem is not yet understood.
- Fight for the obvious solution. Push back when a simpler path meets the real need, even when the requested or existing approach is more elaborate.
- During planning, do not be afraid to propose a seemingly insane or “boil the ocean” solution when it is genuinely the cleanest answer. Explain the scope and tradeoffs, and get the user's approval before expanding implementation beyond the request.
- Apply YAGNI aggressively. The biggest simplicity win is refusing to solve a problem that we do not have; do not add extension points, configuration, abstractions, or data models for hypothetical requirements.
- Good code is the simplest thing that delivers the required functionality and performance. Trade away neither, and bolt on nothing unnecessary.
- Prefer a direct expression, guard clause, or call when it is clearer than a helper. Split code only when it improves readability, error handling, or reuse that already exists.
- Keep changes scoped. Greenfield status is not permission for unrelated refactors.
- Treat current documentation as an explicit constraint. When a request conflicts with it, cite the exact conflict and ask whether to preserve or supersede the documented direction. When the user chooses a new direction, update or supersede every affected document and design decision in the same change.
- For UI work, ask targeted questions when selection, focus, hover, keyboard, or pointer behavior is ambiguous; confirm the user-visible precedence instead of guessing.
- Treat ignored build outputs and local configuration as disposable. Update source, examples, templates, or generators rather than `node_modules/`, `dist/`, `storybook-static/`, `.wrangler/`, `worker-configuration.d.ts`, or `services/core/docker/.env`.

## Repository boundaries

- This is a multi-module repository. `services/core/` and `packages/protocol/` are separate Go modules; the SDK, FieldLink, command interface, and simulations are npm workspaces sharing the root lockfile. Use Node 24 from the root `.nvmrc`, install from the repository root, and consume workspace packages through their public exports.
- Atlas Protocol's source of truth is `packages/protocol/schema/jsonschema/atlas.schema.json`. The authored Go API remains in `packages/protocol/generated/go/atlasprotocol/types.go`; regenerate artifacts with `go run ./tools/generate` from `packages/protocol/`. Planning and reference docs belong in `docs/atlas-protocol/`, never a root `Atlas Protocol/` directory.
- `services/` is centrally hosted software, `surfaces/` is operator-facing software, `edge/` is reserved for field-deployed software, and `packages/` is reusable code. Packages must not import services, surfaces, or edge modules. `edge/asset` and `edge/gateway` intentionally contain only role READMEs; do not add executable code there until their architectures are approved.
- One logical Asset has one Asset Host. Autopilots, sensors, radios, and other attached controllers are peripherals of that host, not additional Atlas compute nodes.
- FieldLink owns MeshCore transport behavior and its hardware harness. It does not own Core access, Asset behavior, Gateway synchronization, task execution, or deployment policy.
- Keep request parsing in HTTP handlers, orchestration in actions/services, and wire shapes in named types when non-trivial. Reuse the existing typed patch and resource helpers instead of adding parallel JSON mutation pipelines, promoted-field lists, or broad TypeScript casts.
- The command interface is a static Cloudflare Pages/Vite app whose browser SDK calls Atlas Core directly. Do not recreate the retired Worker proxy or its runtime config/auth/API routes; see `surfaces/command-interface/README.md`.

## Safety

- Production Atlas Core storage is durable; development Compose is intentionally destructive scratch storage. Never run scratch mode or an older destructive stack against retained data. Follow `services/core/docs/DATABASE_WORKFLOW.md` and `services/core/docs/DEPLOYMENT_RUNBOOK.md`.
- Simulations target loopback Core by default. Deployed runs require the explicit safeguards documented in `simulations/README.md`; never bypass their confirmation, target identity, credential, or cleanup-ledger rules.

## Workflow and validation

Start by confirming the checkout:

```sh
git status --short --branch
git worktree list
```

Codex worktrees can be detached or checked out on a different branch than their directory suggests. Verify branch ownership before editing.

Use the narrowest relevant checks and follow `.github/workflows/ci.yml` or the package README for the full package-specific ladder:

```sh
(cd packages/protocol && go run ./tools/check && go test ./...)
(cd services/core && go test ./...)
npm ci
npm run lint --workspace <package>
npm run format:check --workspace <package>
npm test --workspace <package>
npm run build:<workspace>
npm run check --workspace atlas-fieldlink
git diff --check
```

For documentation-only changes, check affected links and paths plus `git diff --check`; do not run the full stack unless the edit affects generated artifacts, module wiring, or runtime behavior.
