# Agent workflow

Choose the smallest workflow that leaves the next session enough verified context to continue.

| Situation | Workflow | Durable record |
| --- | --- | --- |
| A product request or reported bug needs evaluation | `$matt-triage` | GitHub Issue with category and state labels |
| A clear feature needs an agent-ready statement | `$matt-to-spec`, then `$matt-to-tickets` | GitHub specification and dependency-aware tickets |
| A large direction has unresolved decisions | `$matt-wayfinder` | GitHub map and decision tickets |
| A review or test exposes a suspected implementation defect | `$dcs:review-to-problems` | Verified, temporary `docs/problems/` report |
| A verified temporary defect needs a design or implementation | `$problems-to-plan` or `$problems-to-fixes` | Focused plan or fix, then report retirement |

Use the root and context-specific domain documents before creating a spec, ticket, or agent brief. Preserve a durable design decision in `docs/design-decisions/` and package behavior in the nearest package documentation. Do not copy those durable records into temporary problem reports or active GitHub issues.
