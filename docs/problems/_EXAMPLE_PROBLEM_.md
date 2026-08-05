# Problem Template

Each active entry under `docs/problems/` is a short-lived note for agent-to-agent reference, spanning any Atlas package (Atlas Core, Atlas Protocol, Atlas SDK, …). Most are resolved in minutes. Delete a note when its issue is fixed or invalidated, update it when its evidence drifts, and move durable decisions or guidance to their proper documentation. Use this template to keep the format consistent:

1. **Time & Date:** [UTC timestamp or local time zone timestamp]
2. **Name:** [One-line summary identifier]
3. **Issue:** [Short description of the observable problem]
4. **Severity:** [S1–S5 label from **Severity Levels** below]
5. **Location:** [Service/component and specific file/folder path associated with the issue]
6. **Expected:** [What should happen]
7. **Actual:** [What happens instead]
8. **Reproduction:** [Numbered steps, or "single command / test name" when that's enough]
9. **Notes:** [Optional — investigation hints, error snippets, links; skip if empty]

## What belongs here

- Problems hit while building, testing, or debugging — logged so the next agent session can pick up context quickly.
- Keep active notes current when code paths, evidence, scope, or severity change.
- Delete resolved, abandoned, or invalidated notes; Git history is the reference for closed problems.

### What does not belong here

- **Recurring agent confusion** → `AGENTS.md` (after you've seen the same gotcha more than once).
- **Architectural decisions** → `docs/design-decisions/`.
- **How the system is supposed to work** → specs under the relevant package's docs (e.g. `atlas_core/docs/`).

### Severity Levels

- **S1 (Blocker):** Wrong data, security issue, or completely blocks the current task (dev, CI, or local stack won't run).
- **S2 (Major):** Core path broken with no reasonable workaround.
- **S3 (Moderate):** Broken edge case or painful workaround exists.
- **S4 (Minor):** Annoyance, docs drift, flaky test — task can continue.
- **S5 (Note):** Worth recording for the next agent; no real impact on the current work.

### Example

1. **Time & Date:** 2026-05-23T14:30:00Z
2. **Name:** Changed-since query drops cursor on page two
3. **Issue:** Second page of `GET /queries/changed-since` repeats events when its cursor is not forwarded
4. **Severity:** S2 (Major)
5. **Location:** `atlas_core/internal/api/handlers/handler_query.go`, `atlas_core/internal/actions/query_actions.go`
6. **Expected:** `GET /queries/changed-since` returns globally ordered events after `since_version` with stable cursor continuation
7. **Actual:** Repeating the first request repeats events when `next_cursor` is not passed back as `cursor`
8. **Reproduction:**
   1. Create or update several entities through successive committed writes so the change clock assigns increasing versions
   2. Call `GET /queries/changed-since?since_version=...&limit=1`
   3. Request the next page without `cursor=<next_cursor>` from the first response body
9. **Notes:** See `atlas_core/docs/PAGINATION.md`; compare handler validation vs `query_actions.go` cursor assembly.

### File naming

- Keep `_EXAMPLE_PROBLEM_.md` as the style guide; do not edit it for real incidents.
- Add one markdown file per issue, named `YYYY-MM-DD-short-slug.md` (e.g., `2026-05-23-changed-since-cursor.md`).
