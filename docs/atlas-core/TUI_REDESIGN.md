# Atlas Core TUI redesign

The redesign is approved. [GitHub issue #359](https://github.com/the-Drunken-coder/Atlas-Modernization/issues/359) is the canonical implementation specification, and the [dated design decision](../design-decisions/2026-09-12-atlas-core-tui-redesign.md) records the durable architectural and update-policy choices.

## Approved interface

The TUI owns the terminal until exit. Its home screen is a compact deployment summary and an unfiltered vertical action list. Operations keep the interface mounted and show chronological progress, current phase, errors, safe cancellation, and cleanup. Success returns to the originating screen; failure remains visible with valid next steps.

The first version includes initialization, lifecycle, status, diagnostics, reset, admin password changes, CLI/Core updates, and current Plugin installation, status, enable, disable, and logs. Recovery, supervision, and independent Plugin update, rollback, uninstall, catalog refresh, and shared-key rotation remain direct-command-only.

The approved visual references are intentionally static:

- [Action-list home](../media/atlas-core-tui-redesign/action-list.svg)
- [Operation activity](../media/atlas-core-tui-redesign/operation.svg)
- [Live logs](../media/atlas-core-tui-redesign/logs.svg)

They preserve the selected look without making the local throwaway prototype or its branch an implementation dependency. They do not prove Ink rendering, subprocess control, terminal restoration, or deployment recovery.

## Interaction contract

- General lists use Up and Down, Enter, Escape, and visible shortcuts. The current main-menu text filter is intentionally removed. Mouse input is out of scope.
- During an operation, Escape requests cancellation and returns after cleanup. Ctrl-C requests cancellation and exits after cleanup. A step that cannot stop safely must say so and finish before cleanup.
- In logs, Left and Right change service. Up and Down pause following before scrolling one display line. Space toggles pause and follow. End jumps to the latest line and resumes follow. Escape leaves the viewer and closes its stream without affecting services.
- Log-viewer controls take precedence over general list navigation. Incoming lines remain bounded while paused. Oldest-line eviction preserves the paused viewport until its retained anchor is evicted.
- The primary target is 80 by 24 or larger. A single-column 40 by 24 layout is supported. Below that size, state and active work remain intact behind a resize message, with cancellation still available.

## Implementation boundary

[`application.ts`](../../surfaces/core-cli/src/application.ts) contains the current deployment implementation but imports operator contracts from [`terminal-ui.tsx`](../../surfaces/core-cli/src/terminal-ui.tsx) and writes terminal output directly. The rewrite moves typed inputs, results, progress, cancellation, and recovery outcomes into one internal headless manager used by direct commands, the TUI, and the fixture preview. Rendering and prompts remain in interface adapters. Subprocesses use controlled output streams rather than inheriting the terminal.

Preserve storage ownership, Docker engine identity, mutation locks, durable run intent, transaction recovery, Plugin compatibility checks, and password privacy. Do not add a public manager package, remote API, background mutation navigation, or generic workflow engine.

## Current and future backup behavior

The released CLI still requires `ATLAS_CORE_BACKUP_DIR` and a validated paired PostgreSQL and MinIO backup for Core updates. This planning change does not alter that runtime behavior.

[Issue #368](https://github.com/the-Drunken-coder/Atlas-Modernization/issues/368) will remove the prompt and mandatory receipt from future Core updates. A receipt-bearing journal retains paired-restore recovery. A journal without a receipt rejects restored recovery and offers only actions supported by its phase and evidence. After the target Core starts, that means exact-candidate retry, compatible forward recovery, or intentional reset. It never means starting the prior Core against migrated or uncertain storage.

## Tracking

The ten canonical implementation issues and their blockers are listed in the [issue index](tui-redesign-tickets/README.md). Repository-local ticket copies were removed so implementation status cannot drift from GitHub.
