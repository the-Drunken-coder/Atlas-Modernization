The role of this file is to describe common mistakes and confusion points that agents might encounter as they work in this project.

If you ever encounter something in the project that surprises you, please alert the developer working with you and indicate that this is the case in the agent MD file to help prevent future agents from having the same issue.

The Go service module lives under **`Atlas_Core/`** (run `go test ./...` and `go run ./cmd/atlas_core` from that directory).

This project is super greenfield. It has no users and no real data yet. You can remove things, add things, and reshape the codebase without worrying about backwards compatibility, migrations for existing deployments, or preserving old behavior for callers that do not exist yet. Prefer breaking changes over compatibility shims: backwards compatibility in early development tends to accumulate technical debt and bloat.
