The role of this file is to describe common mistakes and confusion points that agents might encounter as they work in this project.

If you ever encounter something in the project that surprises you, please alert the developer working with you and indicate that this is the case in the agent MD file to help prevent future agents from having the same issue.

The Go service module lives under **`Atlas_Core/`** (run `go test ./...` and `go run ./cmd/atlas_core` from that directory). The repo is multi-module, so choose the narrowest validation stack that matches the task:

```sh
git status --short --branch
git worktree list
(cd atlas_protocol && go run ./tools/check && go test ./...)
(cd Atlas_Core && go test ./...)
(cd atlas_sdk && npm run build && npm test)
git diff --check
```

The live Atlas Core API is hosted on the developer's Proxmox box, not in Cloudflare itself. Cloudflare Tunnel only exposes that Core service. If the live Core API is stale, unhealthy, or on the wrong protocol revision, tell the developer what needs to be reset or updated on the Proxmox host so they can restart it and pull changes there. Do not assume a local Docker tunnel replica is the production Core instance.

For docs-only changes, lightweight path and stale-link checks are usually enough; do not run the full stack unless the edit can affect generated artifacts, module wiring, or runtime behavior.

Codex-created worktrees may not be checked out on the PR branch even when they are inside this repository. If the local tree looks unexpectedly small or detached, run `git worktree list` and inspect the branch checkout before deciding the PR contents are missing.

Atlas Protocol planning/reference docs live under **`docs/atlas-protocol/`**. The old root-level `Atlas Protocol/` folder was intentionally moved there so the repository root has only one protocol-looking folder. Do not recreate `Atlas Protocol/`; update stale links to `docs/atlas-protocol/` instead. Before docs or layout edits, check for stale protocol paths:

```sh
test ! -d "Atlas Protocol"
! rg -n '\]\([^)]*Atlas( |%20|\\ )Protocol/' .
```

The lower-case **`atlas_protocol/`** is the buildable sibling module so Go imports and scripts have a stable path. Keep generated Go artifacts reusable through that sibling module; do not move the protocol source of truth under `Atlas_Core/internal/`.

The Atlas Protocol plan uses CUE, but `cue` may not be installed globally in new worktrees. Use the pinned toolchain path in `docs/atlas-protocol/IMPLEMENTATION_PREP.md` or the `atlas_protocol/tools/` wrappers instead of assuming a global `cue` binary:

```sh
(cd atlas_protocol && go run ./tools/generate)
(cd atlas_protocol && go run ./tools/check)
go run cuelang.org/go/cmd/cue@v0.16.1 version
```

When expressing "at least one of these optional fields" in Atlas Protocol CUE, prefer a concrete helper such as `struct.MinFields(1)` on a closed object. A disjunction of required/optional field variants can leave `cue vet` with incomplete optional-field values even when the JSON example looks valid.

The Atlas Protocol runtime validator uses `cuelang.org/go` against one embedded compiled schema. CUE values are not safe for concurrent shared evaluation here, so keep validation `Unify`/`Validate` calls behind the package-level mutex in `atlas_protocol/validator`.

This project is super greenfield. It has no users and no real data yet. Prefer the simplest correct long-term design over dirty compatibility shims, duplicated paths, or preserving old architecture just because it already exists. If replacing a subsystem leads to a simpler result, take the rebuild even when the process is more involved; if the quick simple fix is also the clean long-term answer, take that instead. Keep changes scoped to the request, and do not use greenfield status as permission for unrelated refactors.

Apply YAGNI aggressively: do not add extension points, configuration knobs, compatibility shims, generalized helpers, or data models for hypothetical future requirements. Build only what the current request and known architecture actually need.

Use the Single-Line Coding Principles for simple behavior: when a clear one-line expression, guard clause, or direct call solves the problem, prefer it over a named abstraction, branching helper, or orchestration layer. Split code only when doing so improves readability, error handling, or reuse that already exists.

When working on Atlas Core, Atlas Protocol, the SDK, or the command interface, do not copy audit-era shortcuts forward:

- In entity/task/object actions, avoid adding another hand-written JSON read/parse/mutate/validate/marshal/update pipeline or another string comparison list for promoted/excluded fields. Prefer a small shared helper or typed patch shape that owns merge, removal, promoted-field, and final-blob validation rules.
- In HTTP handlers, avoid repeated anonymous request structs for non-trivial payloads and avoid handler methods that orchestrate several domain steps. Prefer named request/response types where the shape is reused or complex, and push check-in-style workflows such as `EntityCheckin` into actions/services so handlers mostly parse, call one operation, and serialize.
- Keep protocol generators split by concern. If TypeScript generation grows, extract focused helpers and tests instead of expanding `atlas_protocol/tools/internal/artifacts/typescript.go` as a catch-all file.
- In the SDK cache/watch path, do not normalize type mismatches by stacking `as any` or broad casts. Prefer discriminated resource helpers or generic boundaries that keep the entity/task/object type mapping explicit.
- Treat ignored local outputs such as `node_modules/`, `dist/`, `storybook-static/`, `.wrangler/`, and `worker-configuration.d.ts` as disposable artifacts, not source. Treat `Atlas_Core/docker/.env` as local operator config; update `.env.example`, templates, or generators instead of citing a local `.env` as durable implementation.

Some guidance here is implementation-specific and may drift as Atlas changes. If current code, tests, or docs contradict this file, verify the source of truth before coding around stale guidance, then tell the developer what was stale.

Atlas Core's PostgreSQL database and configured MinIO bucket are disposable runtime state, not durable systems of record. The default startup path drops/recreates tables and clears the bucket; make docs, scripts, and reviews describe this as intentional scratch storage rather than something operators should keep around.

The Cloudflare-hosted Atlas command interface uses Worker code plus a static asset binding from `atlas_command_interface/dist/client`. Cloudflare's Git integration is configured with `main` as the production branch; PR/non-production branch builds use the Version command and do not update `https://atlasinterface.com`. Expect the public custom domain to stay on the last production deployment until the branch is merged to `main` or an explicit production deploy is run. Keep `atlas_command_interface/wrangler.jsonc`'s `build.command` generating the Vite client before upload so the static asset manifest is fresh when a production deploy happens.
