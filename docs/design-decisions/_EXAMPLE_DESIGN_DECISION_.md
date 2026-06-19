# Design Decision Template

Each entry under `docs/design-decisions/` records a durable architectural or implementation choice for the Atlas project as a whole — Atlas Core, Atlas Protocol, Atlas SDK, and any other package in this repo. Use this template to keep the format consistent:

1. **Time & Date:** [UTC timestamp or local time zone timestamp]
2. **Name:** [One-line summary identifier]
3. **Context:** [What problem or constraint prompted the decision]
4. **Decision:** [What was chosen]
5. **Alternatives considered:** [Other options and why they were rejected]
6. **Consequences:** [Trade-offs, follow-on work, or constraints introduced]
7. **Location:** [Relevant files, packages, or docs affected]
8. **Notes:** [Optional — links, related decisions, or open questions; skip if empty]

## What belongs here

- Durable architectural and implementation choices for any Atlas package (Atlas Core, Atlas Protocol, Atlas SDK, …) or the project as a whole.
- Decisions that future agents or contributors need to understand before changing related code.

### What does not belong here

- **Transient bugs or blockers** → `docs/problems/`.
- **Operational how-to** → the relevant package's docs (e.g. `Atlas_Core/docs/`).
- **API or schema reference** → specs and docs under the relevant package (e.g. `Atlas_Core/docs/`).

### File naming

- Keep `_EXAMPLE_DESIGN_DECISION_.md` as the style guide; do not edit it for real decisions.
- Add one markdown file per decision, named `YYYY-MM-DD-short-slug.md` (e.g., `2026-05-29-no-database-migrations.md`).
