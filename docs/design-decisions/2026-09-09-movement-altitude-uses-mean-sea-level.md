# Movement altitude uses mean sea level

Status: accepted from design interview Q8 on 2026-09-09. Producer verification and implementation remain pending.

1. **Time & Date:** 2026-09-09, America/New_York.
2. **Name:** Give reported movement altitude the same vertical reference as Command positions.
3. **Context:** Command positions already specify meters above mean sea level, but Entity telemetry previously documented only a numeric altitude in meters. Ground-relative or launch-relative values can mean different physical heights at different locations.
4. **Decision:** Entity movement altitude means meters above mean sea level. A source using another vertical reference must convert before publishing a value under this contract. History preserves the supplied value and must not guess the reference or silently relabel older data of unknown meaning.
5. **Alternatives considered:** Ground-relative height changes with terrain; launch-relative height changes with the launch reference. Leaving the reference unspecified makes readings impossible to interpret reliably and complicates future use of historical data.
6. **Consequences:** This aligns movement history with existing Command position meaning. Document the telemetry contract and verify affected producers during implementation. Schema validation can validate a finite number but cannot prove that a producer used the correct vertical reference.
7. **Location:** [Glossary](../../CONTEXT.md), [Entity telemetry guide](../../services/core/docs/database-structure/entities.md), [Command position contract](../atlas-protocol/commands-and-tasking.md), [history interview](../movement-history-design-interview.md).
8. **Notes:** This records a semantic decision, not evidence that all existing simulated or physical producers already provide sea-level altitude.
