The role of this file is to describe common mistakes and confusion points that agents might encounter as they work in this project.

If you ever encounter something in the project that surprises you, please alert the developer working with you and indicate that this is the case in the agent MD file to help prevent future agents from having the same issue.

The Go service module lives under **`Atlas_Core/`** (run `go test ./...` and `go run ./cmd/atlas_core` from that directory).

Codex-created worktrees may not be checked out on the PR branch even when they are inside this repository. If the local tree looks unexpectedly small or detached, run `git worktree list` and inspect the branch checkout before deciding the PR contents are missing.

`Atlas Protocol/` is currently a planning/documentation folder, not an implemented module. The implementation prep pass chose lower-case `atlas_protocol/` as the future buildable sibling module so Go imports and scripts do not fight the space in the docs folder name. If you turn it into generated code that Atlas Core imports, keep the generated Go artifacts reusable through that sibling module; do not move the protocol source of truth under `Atlas_Core/internal/`.

The Atlas Protocol plan uses CUE, but `cue` may not be installed globally in new worktrees. Use the pinned toolchain path in `Atlas Protocol/IMPLEMENTATION_PREP.md` or the future `atlas_protocol/tools/` wrappers instead of assuming a global `cue` binary.

When expressing "at least one of these optional fields" in Atlas Protocol CUE, prefer a concrete helper such as `struct.MinFields(1)` on a closed object. A disjunction of required/optional field variants can leave `cue vet` with incomplete optional-field values even when the JSON example looks valid.

This project is super greenfield. It has no users and no real data yet. You can remove things, add things, and reshape the codebase without worrying about backwards compatibility, migrations for existing deployments, or preserving old behavior for callers that do not exist yet. Prefer breaking changes over compatibility shims: backwards compatibility in early development tends to accumulate technical debt and bloat.
