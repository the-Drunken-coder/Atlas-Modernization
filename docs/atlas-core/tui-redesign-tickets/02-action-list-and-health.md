# 02: Build the action-list home and service health screen

**What to build:** Provide the approved full-screen action-list home and service-health screen in a runnable development entrypoint. The existing default TUI remains available while the new interface gains capability.

**Blocked by:** 01: Extract the shared operator contract.

**Status:** ready-for-agent

- [ ] Home has a compact deployment summary and vertical action list with no filtering or search, matching the approved prototype direction.
- [ ] Current service health and resource details flow through the headless manager into both direct status commands and the new screen.
- [ ] Keyboard navigation uses consistent arrows, Enter, Escape, and visible shortcuts; no mouse or phone-specific behavior is required.
- [ ] Use the available terminal viewport, support 40 by 24 minimum, and optimize for 80 by 24 and larger. Header, footer, and scrolling content do not overlap.
- [ ] Resizing preserves state; below minimum dimensions, show the required size. Exiting restores the shell.
- [ ] The fixture preview demonstrates stopped, running, degraded, and uninitialized states without deployment access.
- [ ] Focused manager and terminal tests cover status results, navigation, resizing, and terminal entry/exit.
