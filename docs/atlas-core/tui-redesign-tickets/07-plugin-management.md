# 07: Manage existing Plugins through the new interface

**What to build:** Inspect, enable, disable, and view logs for currently supported Plugins through the new TUI and shared manager.

**Blocked by:** 03: Run start, stop, and restart inside the TUI; 05: Embed logs and diagnostics.

**Status:** ready-for-agent

- [ ] Plugin status and enable/disable commands retain currently implemented capabilities and the documented deployment constraints.
- [ ] Enable/disable progress, cleanup, restoration, and recovery-required results are reported accurately inside the operation screen.
- [ ] Plugin logs reuse the controlled log-viewing flow, including cleanup when leaving.
- [ ] Direct Plugin commands consume the same manager operations and retain their command and exit behavior.
- [ ] Preserve mutation locks, durable disable intent, engine checks, and existing recovery behavior.
- [ ] Preserve the already-implemented independent release commands through the shared manager. Do not add new release capabilities or expand the agreed TUI screens implicitly.
- [ ] Use existing runner-backed Plugin tests and focused terminal scenarios to verify status, lifecycle, logs, cancellation, and recovery.
