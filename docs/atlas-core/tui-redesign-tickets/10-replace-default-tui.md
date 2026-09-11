# 10: Make the new TUI the default and retire the old implementation

**What to build:** Switch normal interactive Atlas Core usage to the complete new TUI, remove superseded code, and verify the installable package and fixture preview.

**Blocked by:** 04: Initialize and explicitly reset deployments; 05: Embed logs and diagnostics; 06: Change the admin password inside the TUI; 07: Manage existing Plugins through the new interface; 09: Update Core without backup prerequisites.

**Status:** ready-for-agent

- [ ] The default interactive entrypoint covers all existing capabilities through the shared manager and approved action-list design.
- [ ] Remove obsolete rendering paths, transitional development entrypoints, and UI-owned manager contracts. Keep the throwaway browser prototype out of the implementation merge.
- [ ] Direct command names, options, and exit behavior remain supported, except for the explicitly removed backup acknowledgement.
- [ ] The fixture preview uses the shared manager contract and demonstrates normal, busy, cancellation, error, logs, and confirmation states without deployment access.
- [ ] Perform real-terminal checks at 40 by 24, 80 by 24, and larger dimensions, including resizing during work, long output, input loss, and shell restoration.
- [ ] Run the relevant package checks and packaged-install smoke validation. Do not treat the browser prototype as evidence of real process safety.
- [ ] Update operator documentation to match final controls, cancellation, updates, and the backup-free scope.
