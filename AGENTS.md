The role of this file is to describe common mistakes and confusion points that agents might encounter as they work in this project.

If you ever encounter something in the project that surprises you, please alert the developer working with you and indicate that this is the case in the agent MD file to help prevent future agents from having the same issue.

For UI work, ask the developer targeted behavior questions when interaction states or precedence are ambiguous. Confirm the exact user-visible behavior instead of guessing, especially when selection, focus, hover, keyboard, and pointer states can conflict; these questions help the developer describe the intended experience.

Connection-error details may receive arbitrary client or server error text. Sanitization must cover structured fields, URL userinfo, query credentials, and bare bearer tokens before any message reaches the UI.

In `AtlasProvider`, only a failure from `dataSource.start()` is a recoverable Atlas Core connection error. Data-source construction, watch registration, and post-start snapshot failures are fatal interface initialization errors.

The SDK sync engine can receive delayed recovery, feed event, error, or close callbacks from an earlier lifecycle generation; guard that generation before mutating shared recovery-operation, status, or snapshot state across stop/start.

The Go service module lives under **`atlas_core/`** (run `go test ./...` and `go run ./cmd/atlas_core` from that directory). The repo is multi-module, so choose the narrowest validation stack that matches the task:

The handlers package already uses `handler_query.go` for full-dataset and changed-since HTTP handlers. Put shared query-parameter parsing in `handler_query_parsing.go`; do not overwrite or repurpose the existing handler file during structural splits.

```sh
git status --short --branch
git worktree list
(cd atlas_protocol && go run ./tools/check && go test ./...)
(cd atlas_core && go test ./...)
npm ci
npm run build:sdk && npm test --workspace @the-drunken-coder/atlas-sdk
npm run build:asset-runtime && npm run typecheck --workspace @the-drunken-coder/atlas-asset-runtime && npm test --workspace @the-drunken-coder/atlas-asset-runtime
npm run build:command-interface && npm test --workspace @the-drunken-coder/atlas-command-interface
npm run build:simulations && npm test --workspace @the-drunken-coder/atlas-simulations
git diff --check
```

The SDK, asset runtime, command interface, and simulations are npm workspaces with one root `package-lock.json`. Install from the repository root with Node 24 LTS from `.nvmrc`; `npm ci` builds the SDK and asset runtime packages through the root lifecycle so direct consumer typecheck, test, and build commands can resolve their public `dist/` exports without a separate preparatory command. Do not restore per-package lockfiles, deep source imports, or source aliases that bypass public exports.

The root `.nvmrc` and package engines are the Node version source of truth: they currently require Node 24, despite stale docs that previously said Node 26. The first asset-runtime migration is an API proving ground, not an extraction of an existing generic loop: current simulations directly performed check-ins and did not contain repeated handshake, reconnect, task-dispatch, or feed-consumption machinery. Do not preserve or claim behavior that was never there.

Biome 2.5.3's type-aware `noFloatingPromises` and `noMisusedPromises` rules are enabled for all four JavaScript workspaces through package-local configurations with the `types` domain set to `recommended`. Keep each lint script's explicit `--config-path biome.json`: without it, Biome resolves the repository-root configuration and silently skips the package-local type-aware rules.

Biome 2.5.3 can panic in its module resolver when a newly split, shorter `MapView` test uses named imports from the much larger `MapView.test-harness.tsx`. Use a namespace import for that harness instead of adding a lint exemption; the equivalent named import previously produced an out-of-bounds resolver index.

For the packed CLI smoke under npm 11, assert that installation created `node_modules/.bin/atlas`, then run the installed `bin.atlas` module with Node. Alias-only `npx --no-install atlas ...` and `npm exec -- atlas ...` invocations are rejected as unsupported `npm exec` usage in this harness.

The live Atlas Core API is hosted on the developer's Proxmox box, not in Cloudflare itself. Cloudflare Tunnel only exposes that Core service. If the live Core API is stale, unhealthy, or on the wrong protocol revision, tell the developer what needs to be reset or updated on the Proxmox host so they can restart it and pull changes there. Do not assume a local Docker tunnel replica is the production Core instance.

Atlas Core production object-size settings must be passed through `atlas_core/docker/docker-compose.production.yml`; keep `MAX_UPLOAD_SIZE_MB` and `MAX_VIEW_SIZE_MB` aligned with `atlas_core/docker/.env.example`. Development Compose intentionally leaves those environment variables unset so a custom `ATLAS_CORE_SETTINGS_FILE` can own the limits.

For docs-only changes, lightweight path and stale-link checks are usually enough; do not run the full stack unless the edit can affect generated artifacts, module wiring, or runtime behavior.

Run the launcher Python tests with the three commands in `.github/workflows/ci.yml` rather than broad `unittest discover`: `atlas_core/scripts/test_api_manual.py` is an operator script whose filename matches discovery but imports the optional `requests` package and is not part of the unit-test suite.

Codex-created worktrees may not be checked out on the PR branch even when they are inside this repository. If the local tree looks unexpectedly small or detached, run `git worktree list` and inspect the branch checkout before deciding the PR contents are missing.

On case-insensitive macOS filesystems, an older worktree can physically retain the historical `Atlas_Core` spelling even though Git canonically tracks `atlas_core/`. Normalize it through an explicit temporary directory name and verify `git status` remains clean; never commit or recreate the uppercase path.

Atlas Protocol planning/reference docs live under **`docs/atlas-protocol/`**. The old root-level `Atlas Protocol/` folder was intentionally moved there so the repository root has only one protocol-looking folder. Do not recreate `Atlas Protocol/`; update stale links to `docs/atlas-protocol/` instead. Before docs or layout edits, check for stale protocol paths:

```sh
test ! -d "Atlas Protocol"
! rg -n '\]\([^)]*Atlas( |%20|\\ )Protocol/' .
```

The lower-case **`atlas_protocol/`** is the buildable sibling module so Go imports and scripts have a stable path. Keep the reusable Go package in that sibling module; do not move the protocol source of truth under `atlas_core/internal/`.

Atlas Protocol uses draft 2020-12 JSON Schema as its source of truth in **`atlas_protocol/schema/jsonschema/atlas.schema.json`**. The protocol tools compile that bundle, validate examples, structurally check the authored Go API in `generated/go/atlasprotocol/types.go`, and regenerate Go validators/revision metadata plus TypeScript artifacts:

```sh
(cd atlas_protocol && go run ./tools/generate)
(cd atlas_protocol && go run ./tools/check)
```

Do not recreate `atlas_protocol/generated/jsonschema/`; schema details belong in the canonical bundle. The Atlas Protocol runtime validator uses `github.com/santhosh-tekuri/jsonschema/v6` against compiled schema definitions and preserves a few narrow semantic checks, such as GeoJSON polygon ring closure and total polygon position limits.

Protocol generation updates the revision artifacts but does not rewrite `atlas_protocol/examples/feed/server/handshake.json`. After a schema revision change, align that example's `protocol_revision` with `atlas_protocol/generated/revision.txt` before running the protocol tests.

This project is super greenfield. It has no users and no real data yet. Prefer the simplest correct long-term design over dirty compatibility shims, duplicated paths, or preserving old architecture just because it already exists. If replacing a subsystem leads to a simpler result, take the rebuild even when the process is more involved; if the quick simple fix is also the clean long-term answer, take that instead. Keep changes scoped to the request, and do not use greenfield status as permission for unrelated refactors.

Apply YAGNI aggressively: do not add extension points, configuration knobs, compatibility shims, generalized helpers, or data models for hypothetical future requirements. Build only what the current request and known architecture actually need.

Use the Single-Line Coding Principles for simple behavior: when a clear one-line expression, guard clause, or direct call solves the problem, prefer it over a named abstraction, branching helper, or orchestration layer. Split code only when doing so improves readability, error handling, or reuse that already exists.

When working on Atlas Core, Atlas Protocol, the SDK, or the command interface, do not copy audit-era shortcuts forward:

- In entity/task/object actions, avoid adding another hand-written JSON read/parse/mutate/validate/marshal/update pipeline or another string comparison list for promoted/excluded fields. Prefer a small shared helper or typed patch shape that owns merge, removal, promoted-field, and final-blob validation rules.
- In HTTP handlers, avoid repeated anonymous request structs for non-trivial payloads and avoid handler methods that orchestrate several domain steps. Prefer named request/response types where the shape is reused or complex, and push check-in-style workflows such as `EntityCheckin` into actions/services so handlers mostly parse, call one operation, and serialize.
- Keep protocol generators split by concern. If TypeScript generation grows, extract focused helpers and tests instead of expanding `atlas_protocol/tools/internal/artifacts/typescript.go` as a catch-all file.
- In the SDK cache/watch path, do not normalize type mismatches by stacking `as any` or broad casts. Prefer discriminated resource helpers or generic boundaries that keep the entity/task/object type mapping explicit.
- Treat ignored local outputs such as `node_modules/`, `dist/`, `storybook-static/`, `.wrangler/`, and `worker-configuration.d.ts` as disposable artifacts, not source. Treat `atlas_core/docker/.env` as local operator config; update `.env.example`, templates, or generators instead of citing a local `.env` as durable implementation.

Some guidance here is implementation-specific and may drift as Atlas changes. If current code, tests, or docs contradict this file, verify the source of truth before coding around stale guidance, then tell the developer what was stale.

`atlas_simulations` must default to loopback Core only. Do not hard-code or automatically offer a deployed Core endpoint: deployed runs require `ATLAS_SIM_ENABLE_DEPLOYED=true`, an explicit non-loopback HTTPS `ATLAS_DEPLOYED_BASE_URL`, and per-run UI/server confirmation. Its restart cleanup ledger stores target identity and run-owned resource IDs but never API keys; recovered cleanup must use current credentials and the exact recorded target URL. Core-generated `command-*` task IDs are allowed only for local runs because they cannot be ledgered before mutation.

Atlas Core production storage is durable. The default startup path applies ordered PostgreSQL migrations, verifies the applied migration ledger and application-schema catalog fingerprint, and preserves the configured MinIO bucket. Durable startup requires that bucket to already exist and fails rather than recreating it; production Compose waits for `minio-init` so clean deployments still provision it before Core starts. `admin_records` is part of that durable database and must be included in backup/restore operations alongside resources, tombstones, the deletion outbox, sequences, and migration metadata. `DATABASE_RECREATE_ON_STARTUP=true` remains an explicit development/test scratch mode: it first migrates/verifies the schema, then truncates disposable resource rows, resets change versions, preserves `admin_records` plus migration history, and clears the configured bucket. Keep development Compose explicitly in scratch mode, production Compose explicitly durable, and the launcher notice aligned with the selected Compose mode; the two Compose files previously hard-coded destructive startup even when the launcher claimed otherwise. The release that introduced migration v1 is the durable rollback floor: never start an older destructive image/Compose stack against retained or restored state.

The Cloudflare-hosted Atlas command interface is a static Vite app intended for Cloudflare Pages, not a Worker proxy. Local development should be able to run with only local Core plus Vite: `python3 atlas_core/scripts/atlas.py --dev` and `npm run dev:command-interface`. The browser reads `VITE_ATLAS_CORE_BASE_URL` at build/dev time, defaulting to `http://127.0.0.1:8000` during Vite dev and `https://api.atlasinterface.com` for production/preview builds. Keep `atlas_command_interface/wrangler.jsonc` as a Pages config with `pages_build_output_dir`, not Worker `main`/`assets` routes. Cloudflare Pages must install from the repository root and run `npm run build:command-interface` so the workspace SDK is built before Vite. If old docs mention `/api/config`, `/api/auth/me`, `/atlas/*`, or `/maps/*` Worker routes for the command interface, treat them as stale and update them rather than recreating the Worker. Cloudflare Tunnel still exposes the Proxmox-hosted Core service; Pages only hosts static UI assets.

`wrangler pages dev` can otherwise select today's compatibility date even when that date is newer than its bundled `workerd` runtime. Keep the explicit supported `compatibility_date` in `atlas_command_interface/wrangler.jsonc` so local Pages and `_headers` validation starts deterministically.

The four Node packages share the root npm workspace and lockfile. Keep the active development/CI version in the root `.nvmrc`; the command-interface `.nvmrc` mirrors it for tooling that inspects the package directory.
