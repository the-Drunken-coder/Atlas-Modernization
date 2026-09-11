# Atlas Core TUI redesign

Design agreed. The user requested a throwaway prototype as the next step, before production implementation. The baseline is commit `b6e622a9`.

## Settled direction

- Extract and polish the existing local deployment manager, then replace the TUI from scratch.
- The direct CLI and TUI share a typed, headless manager with structured results and progress. Its contracts do not depend on terminal rendering, prompts, React, or Ink.
- Preserve the current capabilities and deployment safety and recovery behavior. Fix verified behavioral problems during extraction. Additional deployment features need a separate scope decision.
- Keep operations and their output inside the TUI. Running a process must not suspend the interface and send the user into a separate terminal flow.
- The TUI owns the full terminal viewport for the session, including progress, logs, errors, and cleanup. On exit it restores the shell. The user's references are the immersive terminal interfaces of Codex, Claude Code, and OpenCode; this does not imply a conversational interface.
- Routine actions execute immediately. Reset retains one explicit confirmation. Core updates show version review with one explicit Update action, without backup acknowledgement. Remove acknowledgement-only pauses such as "Press Enter to return."
- Backups are outside the current product scope. The user expects occasional intentional wipes and restarts and does not want backup workflows or prerequisites. This supersedes the earlier agreement to retain backup acknowledgement. Ordinary stop/start and restart retain their existing data behavior; this change does not authorize automatic wiping.
- Deployment-changing operations keep the user on a dedicated operation screen until completion. Navigation to other screens while a mutation runs is not needed. Progress and output remain visible inside the TUI.
- Logs use an embedded live viewer with service selection, scrolling, and pause/resume following. Retain a bounded output buffer. Leaving the viewer stops following logs without affecting services.
- Successful operations return automatically to the previous screen with a short result message. Failures remain visible with the error and available next steps.
- During an operation, Escape requests safe cancellation and returns after cleanup. Ctrl-C requests safe cancellation and exits after cleanup. If the current step cannot safely stop, explain that and finish it before returning or exiting.
- Design primarily for terminals of 80 columns by 24 rows or larger, with a usable single-column layout down to 40 columns. Below supported dimensions, display a resize message without losing state.
- Keyboard controls come first: consistent arrows, Enter, Escape, and visible shortcuts. Mouse support is outside the initial scope.
- Use Ink and React for the rewrite. The user delegated library selection without a preference for Ink. Ink supports full-screen ownership, resize handling, and incremental rendering within Atlas's existing Node 24 runtime. The current interruptions come from explicitly suspending the renderer and letting subprocesses own terminal output. OpenTUI was considered, but its native renderer adds runtime and distribution requirements without a demonstrated benefit for the selected action-list design.
- Make layout and interaction predictable, including resizing and long output. Overlapping UI and broken navigation are explicit acceptance concerns.
- Present distinct static mocks for selection before implementing real UI components.
- The user selected layout B, the action list. Home shows a compact deployment summary and a vertical list of actions. There is no filtering or search: the action count does not justify it. Service health, logs, Plugins, configuration, updates, and diagnostics have dedicated screens. Operation progress uses a chronological activity view with the current phase visible.
- The smallest expected physical display is roughly phone-sized, but the TUI will never be used on a phone. Do not introduce phone orientation, touch, or on-screen keyboard requirements. The agreed minimum is 40 by 24 terminal cells.

## Current implementation

[`application.ts`](../../surfaces/core-cli/src/application.ts) contains the shared deployment implementation but imports its operator contract from [`terminal-ui.tsx`](../../surfaces/core-cli/src/terminal-ui.tsx) and writes terminal output directly. The TUI combines screen rendering, navigation, progress, and cancellation. The fixture preview also imports the TUI-owned contracts.

The extraction must preserve the existing storage ownership, mutation locking, rollback, and recovery rules. Independent Plugin releases, recovery, and supervision are implemented on the PR base. Preserve those existing direct-command capabilities while adapting the manager; new UI workflows beyond the agreed screens remain outside this plan.

## Agreed implementation direction

- Support 40 columns by 24 rows as the minimum, with 80 by 24 and larger as the primary target. Use the full available viewport and scroll overflowing content between a fixed header and footer. Below the minimum, retain state and show the required dimensions; active operations continue safely and cancellation remains available.
- Keep the headless manager internal to the existing package. Both CLI and TUI call the same operations. Move shared contracts out of the rendering module. Use typed inputs, results, progress events, and cancellation signals; route child-process output through controlled streams instead of inherited terminal output. Keep presentation and confirmation prompts in the interface adapters. The manager still enforces required explicit acknowledgements and deployment safeguards.
- Preserve direct command names, options, and exit behavior. Human-readable output may improve as it moves into the CLI adapter. Do not add a public manager package, remote API, or generic workflow framework.
- Extract the manager and establish equivalent behavior first. Then replace the TUI with the selected action-list design. Update the fixture preview to use the shared headless contract.
- Validate storage ownership, locking, recovery, cancellation, and direct-command behavior with the relevant existing tests. Test the new TUI's operation transitions, cleanup, log buffering, input precedence, resize behavior, and terminal restoration. Check representative states at 40 by 24, 80 by 24, and a larger viewport, including long output and errors. Use the in-memory preview for visual checks without operating a real deployment.

The current [CLI README](../../surfaces/core-cli/README.md) describes the still-implemented backup acknowledgement requirement. The user has superseded that requirement for the redesign. Remove it from both CLI and TUI when implementing the redesign, and update the README and affected deployment guidance at the same time. Reset confirmation remains agreed. The prototype already omits backup acknowledgement; production behavior has not changed.

## Throwaway flow prototype

Primary source: branch `codex/prototype-core-tui-flow`, artifact `tui-flow.prototype.html`. The prototype is intentionally excluded from this documentation PR; it has no dependencies or server. The synthesized spec is in [TUI_REDESIGN_SPEC.md](TUI_REDESIGN_SPEC.md). The approved implementation slices are in [the ticket index](tui-redesign-tickets/README.md).

The prototype asks whether the selected action-list flow feels right through success, cancellation, errors, logs, reset, and updates. It uses a pure in-memory transition model, free-play controls, and guided walkthroughs. The viewport selector approximates terminal sizes; it does not validate Ink rendering, actual terminal sizing, subprocess behavior, shell restoration, or deployment recovery. Password entry is omitted.

The user approved the prototype look. Flow demonstrations remain illustrative rather than proof of deployment correctness. Preserve this prototype on its throwaway branch and carry only validated decisions into the eventual implementation. Script syntax was checked with `node --check`; the browser security policy blocked local-file inspection, so visual behavior has not been verified through browser tooling.

The documentation PR was refreshed against main at `ecf0a25d`. The earlier baseline inventory is historical. Existing independent Plugin management, recovery, and supervision commands must remain supported; backup receipt prerequisites are included in the requested removal of backup gating.
