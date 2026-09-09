# Movement history has a narrow domain boundary

Status: accepted scope from the user's 2026-09-09 answers. The user confirmed the final shared understanding on 2026-09-09; runtime implementation remains pending.

1. **Time & Date:** 2026-09-09, America/New_York.
2. **Name:** Preserve movement reports without taking ownership of Entity lifecycle.
3. **Context:** The initial history proposal retained full Entity revisions. Review and user clarification established a smaller requirement: past position, speed and altitude for one selected Asset or Track, including earlier reports attached after a Track is identified.
4. **Decision:** Limit movement history to position, speed and altitude, retain original reports for 30 days, and keep display simplification separate from raw retention. Include backfill in the first version. Consume Entity associations supplied by existing owners; do not move Track identification, Asset identity, or disconnect/reconnect behavior into history. The intended operator experience concerns one selected Entity.
5. **Alternatives considered:** Full Entity revision history retains names, classification and unrelated components the user does not need. A browser-only trail cannot preserve reports collected while the browser was absent or support durable backfill. Making history own identity and reconnect rules crosses an explicitly excluded responsibility boundary.
6. **Consequences:** Later measured fields can extend movement history when requested. Full Entity reconstruction and whole-map replay are not prerequisites. [Report semantics](2026-09-09-movement-history-preserves-reported-values.md) now settle independent readings, retention timing, history-only backfill and arrival-time fallback. The interview records accepted display and import behavior. Final shared understanding is confirmed. The user approved the revised mock using the existing sidebar and current UI elements. Both design review gates are complete; runtime implementation remains pending.
7. **Location:** [Domain glossary](../../CONTEXT.md), [investigation](../entity-history-investigation.md), [design interview](../movement-history-design-interview.md); future implementation spans Protocol, Core, SDK and Command interface.
8. **Notes:** This records the user's scope, not approval of the earlier table schema, route names, lifecycle columns, or UI behavior.
