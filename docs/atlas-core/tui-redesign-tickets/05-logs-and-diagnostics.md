# 05: Embed logs and diagnostics

**What to build:** Inspect service logs and diagnostics inside the new interface while retaining direct-command access through the shared manager.

**Blocked by:** 02: Build the action-list home and service health screen.

**Status:** ready-for-agent

- [ ] Logs expose a controlled stream through the manager and never suspend the TUI or inherit terminal output.
- [ ] The viewer supports service selection, scrolling, pause/resume following, and jumping to latest output.
- [ ] Incoming output remains bounded while following or paused; long lines fit the viewport without overlapping the footer.
- [ ] Leaving logs closes the stream and releases subprocess resources without changing service lifecycle state.
- [ ] Diagnostics return structured results for in-TUI presentation and direct CLI formatting, including actionable failures.
- [ ] Fake operator/terminal and command-runner coverage verifies log lifecycle, service changes, bounded buffering, paused following, and diagnostic outcomes.
- [ ] The fixture preview demonstrates logs and diagnostics without Docker access.
