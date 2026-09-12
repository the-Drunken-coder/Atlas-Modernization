# Atlas Core TUI redesign specification

[GitHub issue #359](https://github.com/the-Drunken-coder/Atlas-Modernization/issues/359) is the canonical specification. It owns required behavior, the headless manager contract, log control precedence, future no-backup recovery semantics, test acceptance, scope, and the implementation issue graph.

Repository documentation preserves only the durable context that must remain discoverable with the code:

- [Approved design and static references](TUI_REDESIGN.md)
- [Architectural and update-policy decision](../design-decisions/2026-09-12-atlas-core-tui-redesign.md)
- [Canonical implementation issue index](tui-redesign-tickets/README.md)

The plan was refreshed against `ae875bca` after PRs #346 and #348 merged. The current runtime still requires backup confirmation and `ATLAS_CORE_BACKUP_DIR` for a Core update. Issue #368 owns the future behavior change.
