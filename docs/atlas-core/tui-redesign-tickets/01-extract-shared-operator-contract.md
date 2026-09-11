# 01: Extract the shared operator contract

**What to build:** Keep the existing CLI, TUI, and fixture preview working through a shared operator contract owned outside terminal rendering. This is the preparatory refactor for the approved redesign.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Shared inputs, results, and operator types no longer belong to a React or Ink module; all existing consumers use the same contract.
- [ ] Existing commands, menu behavior, preview scenarios, and exit behavior remain equivalent.
- [ ] Reuse the existing fake command runner and injected operator/terminal test boundaries. Verify externally observable behavior rather than helper structure.
- [ ] Do not introduce a public package, remote service, generic workflow engine, or unrelated refactors.
- [ ] The relevant package type checks, tests, and build pass.
