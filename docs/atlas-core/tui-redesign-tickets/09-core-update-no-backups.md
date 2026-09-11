# 09: Update Core without backup prerequisites

**What to build:** Review and perform a CLI-and-Core update through one explicit Update action, without backup acknowledgement in either interface.

**Blocked by:** 08: Update the CLI without surrendering terminal control.

**Status:** ready-for-agent

- [ ] Release review identifies the target version and CLI-and-Core scope; it does not prompt for or require a backup.
- [ ] Remove backup acknowledgement prerequisites from both direct CLI and TUI. Update conflicting operator documentation and deployment guidance in the same change.
- [ ] Preserve existing version rechecks, digest-pinned images, enabled-Plugin compatibility checks, storage ownership, and update safety behavior.
- [ ] Running deployments are updated according to existing health checks; stopped deployments remain stopped. Ordinary updates do not intentionally wipe data.
- [ ] Cross-version command handoff remains controlled by the manager/adapter boundary and never hands terminal output ownership away from the TUI.
- [ ] Failures preserve accurate recorded state and expose recovery requirements rather than promising that schema migrations can be reversed.
- [ ] Runner-backed update tests and terminal scenarios cover review, handoff, stopped/running behavior, failure, and progress. No backup workflow is added.
- [ ] Remove current backup-receipt gating as well as prompts, without bypassing transaction ownership or inventing evidence of a backup. Preserve explicit recovery commands and report when forward recovery or intentional reset is required.
