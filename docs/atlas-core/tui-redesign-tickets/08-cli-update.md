# 08: Update the CLI without surrendering terminal control

**What to build:** Check available releases, review the CLI-only update, and perform it through the shared manager while the TUI retains terminal ownership.

**Blocked by:** 03: Run start, stop, and restart inside the TUI.

**Status:** ready-for-agent

- [ ] Release lookup and review show installed and available versions, with explicit CLI-only scope.
- [ ] Npm and other update subprocess output is captured for progress; the TUI stays mounted throughout the operation.
- [ ] Preserve existing version rechecks, installation constraints, and direct update command behavior.
- [ ] CLI-only updates leave the running Core deployment, credentials, and stores unchanged.
- [ ] Update success, failure, and cancellation use the agreed operation outcomes; do not claim an already-completed package installation was undone.
- [ ] Fake runner and terminal tests verify lookup, review, subprocess output ownership, completion, and failures.
