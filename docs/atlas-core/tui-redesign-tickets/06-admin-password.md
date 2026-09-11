# 06: Change the admin password inside the TUI

**What to build:** Change the admin password through private input and the shared operation flow, with in-TUI progress and accurate recovery outcomes.

**Blocked by:** 03: Run start, stop, and restart inside the TUI.

**Status:** ready-for-agent

- [ ] Password entry remains masked and is never exposed in command arguments, progress events, diagnostic output, or logs.
- [ ] Preserve the existing fixed admin account, password validation, and running-versus-stopped application behavior.
- [ ] Prompts belong to the interface adapter; the shared manager performs the actual configuration change for both direct CLI and TUI.
- [ ] Applying the change, cancellation, and any recovery remain inside the TUI without acknowledgement-only pauses.
- [ ] Preserve existing fail-closed behavior when prior configuration cannot be restored safely.
- [ ] Focused tests cover private input, validation, successful application, cancellation, and recovery results.
