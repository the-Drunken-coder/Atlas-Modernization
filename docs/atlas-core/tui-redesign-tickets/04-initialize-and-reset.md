# 04: Initialize and explicitly reset deployments

**What to build:** Initialize a new deployment or intentionally reset an existing one through the shared operation flow without leaving the TUI.

**Blocked by:** 03: Run start, stop, and restart inside the TUI.

**Status:** ready-for-agent

- [ ] Initialization works from the uninitialized state through manager, CLI, TUI, and fixture preview.
- [ ] Reset presents one explicit confirmation identifying the deployment data and credentials being deleted; cancellation before confirmation changes nothing.
- [ ] Reset and initialization keep all progress and errors inside the TUI and use the agreed cleanup and completion behavior.
- [ ] Preserve existing resource ownership, engine identity, and initialization protections; do not adopt unmatched retained resources.
- [ ] Ordinary stop/start and restart preserve their existing data-retention behavior. No automatic or scheduled wiping is added.
- [ ] Focused behavior tests cover fresh setup, refusal of unsafe initialization/reset, confirmation cancellation, and completion.
