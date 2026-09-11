# Issue tracker

Atlas uses two complementary work-tracking surfaces.

## GitHub Issues: persistent work

GitHub Issues are the canonical surface for product requests, reported bugs, feature specifications, agent briefs, implementation tickets, and Wayfinder maps. Use the `gh` CLI from this checkout; it infers `the-Drunken-coder/Atlas-Modernization` from `origin`.

- **Create:** `gh issue create --title "..." --body "..."`
- **Read:** `gh issue view <number> --comments`
- **List:** `gh issue list --state open --json number,title,body,labels,comments`
- **Comment:** `gh issue comment <number> --body "..."`
- **Apply a label:** `gh issue edit <number> --add-label "..."`
- **Close:** `gh issue close <number> --comment "..."`

Pull requests are not a request surface for triage. A named pull request may still be inspected when the task requires it.

### When a skill says "publish to the issue tracker"

Create a GitHub Issue. `$matt-to-spec` publishes the active specification there, `$matt-to-tickets` creates dependency-aware child work items there, and `$matt-wayfinder` creates a map issue with child decision tickets.

### Wayfinding operations

- **Map:** create one issue labelled `wayfinder:map` containing the destination, notes, decisions so far, unresolved fog, and out-of-scope boundary.
- **Child ticket:** create an issue labelled with one `wayfinder:<type>` label (`research`, `prototype`, `grilling`, or `task`) and associate it with the map as a GitHub sub-issue.
- **Blocking:** use GitHub's native issue dependency where available. Otherwise record `Blocked by: #<number>` in the child body.
- **Frontier:** an open, unassigned child with no open blockers is ready to work.

## `docs/problems/`: verified temporary defects

`docs/problems/` is an internal, short-lived ledger for defects discovered during review, testing, or active implementation. Follow `_EXAMPLE_PROBLEM_.md`: one dated report per root cause, updated when evidence drifts, then deleted after the report is invalidated or its fix is verified.

Use the problem-report skills for this lifecycle:

- `$dcs:review-to-problems` investigates review findings and writes only confirmed reports.
- `$problems-to-plan` turns selected current reports into a read-only fix plan.
- `$problems-to-fixes` revalidates reports, implements verified fixes, and retires reports when the repository lifecycle permits it.
- `$prune-fixed-problems` removes only parent-verified reports whose failures are fixed.

Do not use a temporary problem report as a replacement for a persistent specification, request, or decision ticket.
