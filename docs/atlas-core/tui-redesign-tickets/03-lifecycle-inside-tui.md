# 03: Run start, stop, and restart inside the TUI

**What to build:** Run routine lifecycle actions through the shared manager and keep progress, output, errors, and cancellation inside a dedicated TUI operation screen.

**Blocked by:** 02: Build the action-list home and service health screen.

**Status:** ready-for-agent

- [ ] Start, stop, and restart execute without redundant confirmations and expose typed progress and results to both CLI and TUI.
- [ ] The manager does not format terminal UI or prompt; command output is captured rather than allowed to take terminal ownership.
- [ ] Only one deployment mutation runs at a time; the operator cannot navigate away while it is active.
- [ ] Success returns to the originating screen with a short result; failure stays visible with accurate outcomes and next steps.
- [ ] Escape requests cancellation and return. Ctrl-C requests cancellation and exit. A necessary safe step and cleanup finish before return or exit; the screen explains the delay.
- [ ] Terminal loss and shrinking below minimum size do not bypass cleanup. Cancellation remains available below the size threshold.
- [ ] Preserve existing data retention, ownership, locking, and recovery behavior. Do not report cancellation or restoration unless that is the actual outcome.
- [ ] Existing runner-backed tests and focused terminal tests cover progress ordering, success, failure, safe cancellation, and shell restoration.
