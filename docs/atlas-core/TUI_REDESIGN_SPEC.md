## Problem Statement

The Atlas Core terminal interface feels awkward, interrupts the operator with confirmations and acknowledgement pauses, and hands terminal control away when deployment commands run. Its rendering, navigation, operation orchestration, and contracts are coupled. The deployment implementation writes terminal output directly and imports contracts from the TUI, making changes harder to isolate.

The operator wants a clean, full-screen action list that remains present through operations and logs, plus a backend that is straightforward to extend and upgrade. Atlas data may be intentionally discarded through occasional resets. Backups are not part of the current product scope and must not be prerequisites for updates.

## Solution

Extract and polish the shared, typed, headless deployment manager, then rewrite the TUI on Ink and React using the approved action-list design. Keep direct commands available through an adapter over the same manager. All TUI progress, errors, logs, confirmations, and cleanup stay inside the interface until the operator exits.

Use a compact deployment summary and a vertical action list without filtering. Routine actions execute immediately. Reset retains one explicit confirmation; Core updates show release review and one Update action with no backup acknowledgement.

## User Stories

1. As an operator, I want Atlas to occupy the terminal viewport, so that I can operate it without switching between disconnected interfaces.
2. As an operator, I want the shell restored when I exit, so that normal terminal use resumes cleanly.
3. As an operator, I want a compact deployment summary, so that I can see whether Atlas is running before choosing an action.
4. As an operator, I want a short action list without search or filtering, so that navigation stays simple.
5. As an operator, I want arrows, Enter, Escape, and visible shortcuts, so that controls behave predictably.
6. As an operator, I want to initialize a deployment, so that I can get Atlas running from a new installation.
7. As an operator, I want to start, stop, and restart Atlas, so that I can control its lifecycle.
8. As an operator, I want routine actions to execute without redundant confirmation, so that the interface respects my intent.
9. As an operator, I want current progress and output on a dedicated operation screen, so that I can understand what Atlas is doing.
10. As an operator, I want deployment mutations serialized, so that conflicting actions cannot run together.
11. As an operator, I want successful operations to return to the previous screen with a short result, so that I can continue without acknowledgement pauses.
12. As an operator, I want failures to remain visible with useful next steps, so that I can investigate before dismissing them.
13. As an operator, I want Escape to request safe cancellation, so that I can return after cleanup finishes.
14. As an operator, I want Ctrl-C to request cancellation and exit after cleanup, so that exiting does not abandon recoverable work.
15. As an operator, I want an explanation when a step must finish before cancellation, so that waiting does not look like a frozen interface.
16. As an operator, I want errors to distinguish failure, restoration, and recovery requirements, so that I know the deployment's actual condition.
17. As an operator, I want service health and resource information, so that I can inspect Core, Source Gateway, PostgreSQL, and MinIO.
18. As an operator, I want embedded service logs, so that log inspection never drops me out of the TUI.
19. As an operator, I want to change the selected log service, so that I can investigate related components.
20. As an operator, I want to scroll and pause following logs, so that incoming output does not displace what I am reading.
21. As an operator, I want to resume following the latest logs, so that I can return to current activity.
22. As an operator, I want leaving logs to stop that stream without stopping services, so that observation is separate from lifecycle control.
23. As an operator, I want bounded log buffering, so that a long session does not consume unlimited memory.
24. As an operator, I want Plugin status, enable, disable, and logs, so that existing Plugin management remains available.
25. As an operator, I want to change the admin password without exposing it in output or process arguments, so that configuration remains private.
26. As an operator, I want diagnostics inside the TUI, so that troubleshooting uses the same interface.
27. As an operator, I want to review available releases and choose CLI-only or CLI-and-Core updates, so that update scope is explicit.
28. As an operator, I want updates without backup prerequisites, so that the workflow matches how I run Atlas.
29. As an operator, I want one explicit reset confirmation naming the data being deleted, so that an intentional wipe is distinguishable from routine maintenance.
30. As an operator, I want resize handling that preserves selection and operation state, so that changing terminal dimensions does not disrupt work.
31. As an operator, I want a usable 40-by-24 layout and efficient use of larger terminals, so that a small display remains practical.
32. As an operator, I want a resize message below supported dimensions while safe cancellation remains available, so that shrinking the terminal does not strand an operation.
33. As a script author, I want the existing direct commands and exit behavior, so that the TUI rewrite does not force interactive use.
34. As a maintainer, I want operation behavior independent of Ink, so that changing presentation does not require rewriting deployment logic.
35. As a maintainer, I want typed inputs, results, progress, and cancellation, so that adding a capability has a clear contract.
36. As a maintainer, I want separate screens and controlled external dependencies, so that improvements remain localized and easy to simulate.
37. As a maintainer, I want a fixture preview without deployment access, so that interface changes can be reviewed safely and quickly.

## Implementation Decisions

- Keep the headless manager internal to the existing Atlas Core CLI package. Do not add another service or publicly versioned manager package.
- Move shared contracts out of the rendering module. The manager must not depend on React, Ink, terminal dimensions, prompts, or screen state.
- Separate CLI parsing and text presentation from manager orchestration. Reuse existing command-runner and operator injection boundaries instead of creating parallel abstractions.
- Use typed operation inputs, results, progress events, and cancellation signals. Keep display formatting in interface adapters. Preserve useful external diagnostic output without allowing subprocesses to take terminal ownership.
- Separate operation lifetime from rendering lifetime. Keep the TUI mounted through subprocess work, update handoffs, output streaming, errors, and cleanup.
- Preserve existing locks, ownership checks, recovery, and password handling. Backend extensibility does not require weakening these protections.
- Preserve direct command names, options, and exit behavior except for the explicitly removed backup acknowledgement. Human-readable formatting may improve.
- Build separate screens around the approved action-list home. Use chronological operation activity with the current phase visible. No background screen navigation during a mutation.
- Success returns automatically to the originating screen. Failure remains visible. Do not add an acknowledgement-only completion screen.
- Escape requests cancellation and return; Ctrl-C requests cancellation and exit. Finish any necessary safe step and cleanup before completing that request. Report actual outcomes rather than assuming every cancellation restores prior state.
- Log viewing supports service selection, scrolling, pause/resume following, latest-output navigation, and bounded buffering. Leaving releases the log stream.
- Use Ink and React within the existing Node 24 package contract. Rendering-library replacement remains possible through the headless boundary.
- Target 80-by-24 terminals and larger, with 40-by-24 minimum. Use a fixed header/footer and scrolling content. Below the minimum, preserve state and show a resize message while active operations and cancellation remain functional.
- No mouse requirement, phone layout, decorative animation, or action filtering. A phone-sized physical display was a size analogy, not a phone-use requirement.
- Retain one destructive reset confirmation. Combine Core release review and execution into one Update action. Remove backup prompts and prerequisites in both direct CLI and TUI, updating conflicting deployment guidance in the implementation change.
- Keep ordinary stop/start, restart, and update data-retention behavior unchanged. Occasional intentional resets are supported; the conversation did not authorize automatic data deletion.
- First establish the headless boundary and equivalent deployment behavior, then rewrite the real TUI. Reuse the shared contract for the in-memory preview.
- Extend through focused operations and screens rather than a generic workflow engine, extension registry, or speculative configuration system.

## Testing Decisions

- Agreed principal seam: the shared headless manager contract. Reuse the existing fake command runner to exercise deployment behavior and the fake operator/terminal to exercise presentation. The user explicitly confirmed these existing boundaries.
- Test externally observable behavior: operation results, progress ordering, cancellation completion, process/output ownership, exit behavior, and resulting deployment state. Avoid assertions about internal helper structure or mirroring the implementation.
- Existing prior art includes command-runner-backed deployment tests, injected-operator terminal interaction tests, fixture preview tests, and packaged-install smoke checks.
- Preserve meaningful coverage of initialization, storage ownership, mutation locks, start/stop/restart, reset, password changes, updates, Plugin recovery, and cancellation. Backup policy changes should update the affected behavior tests.
- Exercise successful return to the previous screen, persistent failure output, safe cancellation, cleanup before exit, terminal input loss, and update subprocess handoff without suspending the TUI.
- Exercise bounded log buffering, pausing while output arrives, resuming following, service changes, and stream cleanup when leaving.
- Review representative normal, busy, error, log, and confirmation screens at 40-by-24, 80-by-24, and larger sizes, including long output and resizing during work. Verify that headers, footers, and content do not overlap.
- Verify real terminal entry and restoration with the fixture preview. The browser prototype does not establish Ink rendering or process safety.
- Run the package's relevant checks and package-build validation for implementation changes. Do not add tests to the throwaway prototype.

## Out of Scope

- Backup creation, restoration workflows, backup reminders, and backup acknowledgement prerequisites.
- Automatic wiping, scheduled resets, or changing ordinary restart persistence.
- Remote management, a new daemon, public operator API, or a separately published manager package.
- New Plugin, recovery, or supervision capabilities beyond those already implemented on the implementation baseline.
- Background navigation or concurrent deployment mutations.
- Phone-specific input, touch, mouse support, search, and filtering.
- A generic workflow framework or extensibility platform.
- Copying the browser prototype into production or claiming that simulated recovery validates real deployment safety.

## Further Notes

The user approved layout B and subsequently said they loved the prototype's look. The prototype is the visual and interaction reference, not production code. Keep it on the local throwaway branch `codex/prototype-core-tui-flow`; the initial capture is commit `a8ff8da8`. Later local edits remove backup acknowledgement. The prototype remains local and excluded from this PR; the requirements in this spec are sufficient to implement without access to it.

The baseline inspected for the design was `b6e622a9`. Recheck the implementation checkout before editing, especially Plugin capabilities that may have changed independently.

The data-retention clarification was not explicitly answered. This spec conservatively retains existing restart behavior and scopes data deletion to explicit reset; it does not treat that as a new user decision.

The approved tickets are included as repository planning documents. Their ready-for-agent status describes intended triage; they have not been published as GitHub issues. Start each ticket only when its blockers are complete.

PR-base refresh: main at `ecf0a25d` already implements independent Plugin lifecycle, supervision, recovery commands, and backup receipts. Preserve current direct-command coverage. Removing backup prerequisites must include receipt gating and replacement guards that do not assert a backup exists; retain transaction journaling, ownership checks, and honest recovery outcomes. Explicit restore-recovery commands remain supported for existing callers, but this plan adds no backup workflow.
