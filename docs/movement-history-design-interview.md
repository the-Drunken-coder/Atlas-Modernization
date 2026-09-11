# Movement history design interview

Status: confirmed by the user on 2026-09-09 after all 16 behavioral questions were answered. The user subsequently selected the existing sidebar for the entire history section and rejected broader layout changes. The user approved the revised sidebar mock with "i like it" on 2026-09-09. Implementation details remain proposed in the supporting investigation.

## Settled decisions

| Decision | User's answer | Documentation |
| --- | --- | --- |
| Historical information | Position, speed and altitude are enough; exclude battery, connection quality, sensor readings and status. | Movement history glossary; scope decision |
| Backfill | Include it in v1, especially for observations collected before identifying and creating a Track. | Backfill glossary; scope decision |
| Operator scope | One selected Entity is the intended experience. | Scope decision |
| Retention duration | 30 days from measurement time when known, otherwise Atlas arrival time. | Scope and report-semantics decisions |
| Display reduction | Simplification of the displayed trail is separate from retaining original reports. | Scope decision |
| Expected load | 10 to 25 Entities; Assets at most every one to five seconds, Tracks every few seconds. | Supporting proposal |
| Identity ownership | Asset identity, reconnect behavior and Track association belong outside this system. | Scope decision |
| Independent readings | Keep speed and altitude even without a position; never fill omitted quantities into a new sample. | Q1; report-semantics decision |
| Unrelated reports | A stationary Sentry reporting only battery 80 to 79 creates no movement sample and no fresh position time. | User's Q1 example |
| Current state | Backfill only changes history, even if the current marker is missing. | Q3 |
| Unknown measurement time | Retain the report using labeled arrival time. | Q4 |
| Historical editing | No manual correction/removal in v1; preserve received reports until retention expiry. | Q5 |
| Historical inspection | Show last reported values. Show an age cue only when a value was reported more than one minute before the inspected historical time; keep exact times available on inspection. | Q6, Q11 |
| Trail gaps | Use a different line style when more than one minute separates actual position reports. Other updates do not reset this interval. Dotted connectors were subsequently approved with the revised sidebar mock. | Q7, Q12 |
| Altitude reference | Meters above mean sea level, matching Command positions. | Q8; altitude decision |
| Initial history interval | Last hour, adjustable within retained history. | Q9 |
| Mixed-age upload | Keep eligible reports, skip expired reports, and clearly report skipped counts. | Q10 |
| Following reports | Recent history follows incoming reports. Selecting an earlier point or interval holds that historical view steady until returning to the recent view; the rest of the map stays live. | Q13 |
| Reported-point interaction | Hover previews historical readings; clicking pins them. Keep the parent Entity selected, leave its current marker live, and preserve active drawing/command behavior. | Q14 |
| Overlapping targets | Current Entity markers take priority over historical points. Overlapping reports remain accessible through history controls. | Q15 |
| History placement | Keep the entire history section in the existing selected-Entity sidebar and reuse current UI elements. Preserve existing inspector sections. Reject the separate bottom strip and floating report window. | User correction after visual review |
| Keyboard ownership | Left/right arrows step reports only inside focused history controls. Escape dismisses pinned historical details before clearing the Entity; existing active tools and dialogs retain priority. | Q16 |

The position-required restriction in the earlier proposal is superseded by Q1. The proposal and glossary now reflect independent movement readings.

## Design tree

```text
Movement history [scope settled]
  Retained report contents [Q1 settled]
    Earlier known values [Q6 settled]
      Age cue after more than one minute [Q11 settled]
    Gaps use a different connector style [Q7 settled]
      Gap after more than one minute without a position report [Q12 settled]
      Dotted gap connectors [approved sidebar mock]
    Altitude above mean sea level [Q8 settled]
  Retention from measurement time, arrival fallback [Q2 + Q4 settled]
    Mixed-age upload keeps eligible reports [Q10 settled]
    Missing/expired range presentation [truthful availability; confirmed acceptance examples]
  Backfill changes history only [Q3 settled]
    Recent follows; earlier inspection stays steady [Q13 settled]
  Historical corrections [Q5 settled: no manual editing]
  Trail presentation
    Initial last-hour window [Q9 settled]
    Following new reports [Q13 settled]
    Hover previews; click pins historical readings [Q14 settled]
    Current markers win overlapping historical/current points [Q15 settled]
    Focused keyboard stepping and Escape priority [Q16 settled]
    Existing sidebar placement [settled after user review]
    Detailed control arrangement and timing/gap appearance [approved sidebar mock]
  Final scope and acceptance examples [confirmed 2026-09-09]
    User confirmed shared understanding and approved the sidebar mock
```

## Round 1: answered

The user accepted all five recommendations. Q1 was reinforced with the stationary Sentry battery-only report example.

| ID | Scenario and choice | Recommendation | Answer |
| --- | --- | --- | --- |
| Q1 | An Asset reports a new speed or altitude without a new position. Keep that reading in history, or only save readings that accompany a position? | Keep the reported speed/altitude, but do not invent another position or timestamp an old position as fresh. | Accepted |
| Q2 | A position measured 29 days ago arrives today. Keep it for one more day, or for 30 days after arrival? | Count the 30 days from when it was measured when that time is known. | Accepted |
| Q3 | Earlier positions are uploaded to a Track. May that upload change its current marker, including filling an otherwise missing marker? | Backfill changes history only. Current location remains the responsibility of the source publishing current information. | Accepted |
| Q4 | A report has no trustworthy measurement time. Keep it using the time Atlas received it, clearly labeled, or leave it out? | Keep it, labeled with arrival time rather than a claimed measurement time. | Accepted |
| Q5 | A historical point is wrong. Must the first version let an operator correct/remove historical reports? | No manual history editing in v1; preserve received reports. Revisit if the user expects this correction workflow. | Accepted |

## Round 2: answered

The user accepted Q8 through Q10. Q6 retains earlier known readings with less timestamp clutter. Q7 changes the recommendation from an empty break to a differently styled connector, with dots suggested tentatively.

| ID | Scenario and choice | Recommendation | Answer |
| --- | --- | --- | --- |
| Q6 | A position arrives at 2:02, while the most recent speed report is from 2:01. What should inspection at 2:02 show for speed? | Show the last reported speed with its original time, clearly distinguished from a fresh reading. Raw samples remain unchanged. | Accepted with refinement: normally omit specific field times unless there is a discrepancy; keep the UI clean. |
| Q7 | Positions arrive at A and then B ten minutes later, with no positions between them. How should the trail represent the missing interval? | Show a visible break rather than claiming a known route. Missing position reports alone do not prove a disconnection or that the subject stopped. | Changed: use a different line style between endpoints. Dots were tentative in this round and were subsequently approved in the revised sidebar mock. |
| Q8 | What should an altitude reading of 100 meters mean? | Height above sea level, matching the existing Command position contract. Sources must supply/convert to that meaning; history must not guess. | Accepted. |
| Q9 | How far back should history show when first opened for an Entity? | The last hour, adjustable within retained history. | Accepted. |
| Q10 | An upload contains useful recent reports mixed with reports older than 30 days. What should happen? | Keep eligible reports, skip expired ones and report the counts clearly. Invalid/conflicting data handling remains a separate validation concern. | Accepted. |

## Round 3: answered

The user accepted all four recommendations, including the strict more-than-one-minute thresholds.

| ID | Scenario and choice | Recommendation | Answer |
| --- | --- | --- | --- |
| Q11 | Speed was reported two seconds before a selected position, versus five minutes before it. Which timing differences should the normal display call out? | Keep small ordinary reporting differences quiet. Start with an age cue only when a displayed value was reported more than one minute before the selected historical time; exact times remain inspectable. | Accepted. |
| Q12 | When should a connection between reported positions switch to the gap style? | Start with more than one minute between actual position reports. This denotes missing positions, not disconnection; downsampling must not create gaps. | Accepted. |
| Q13 | How should recent history behave as new reports arrive while the operator is inspecting it? | Follow new reports in the recent view. Once the operator picks an earlier time or point, hold that historical time/window steady until they return to the recent view; the rest of the map remains live. | Accepted. |
| Q14 | What should hovering or clicking an actual reported point on the trail do? | Hover previews its historical readings; clicking pins those details while keeping the Entity selected and its live marker live. Existing drawing and command interactions retain priority. | Accepted. |

## Round 4: answered

The user accepted both recommendations. These choices preserve established map behavior while defining ownership of the new history interaction.

| ID | Scenario and choice | Recommendation | Answer |
| --- | --- | --- | --- |
| Q15 | A historical point occupies the same place as a current Entity marker. Which should a map click select? | Current Entity markers retain priority. The history controls still provide access to the overlapping historical report. Active drawing and commands already retain their behavior under Q14. | Accepted. |
| Q16 | How should arrow keys and Escape behave while using history? | Inside focused history controls, left/right arrows step through reports. Elsewhere, existing map navigation remains unchanged. Escape dismisses a pinned historical readout before clearing the Entity, while active tools/dialogs retain existing Escape priority. | Accepted. |

## Final shared understanding

Confirmation: the user replied "Seems good to me" to the final shared-understanding summary on 2026-09-09. The behavioral design is confirmed. The user subsequently approved the revised sidebar mock with "i like it"; both the interview and visual review gates are complete.

The first version keeps 30 days of reported position, speed and altitude for one selected Asset or Track. Each report contains only what the source actually supplied. Earlier reports can be attached after a Track is created without changing its current information. Identity, identification and reconnect behavior stay with their existing owners.

History opens to the last hour. Recent history follows new reports, while inspecting the past holds that historical view steady and leaves the rest of the map live. Hover previews a reported point; clicking pins its details. Current markers win overlapping clicks. History controls provide report stepping, and Escape closes pinned details before clearing the Entity, subject to existing tool/dialog priority.

Readings use the last retained report at or before the inspected time. Normal timing differences stay quiet; readings more than one minute old receive an age cue. More than one minute between actual position reports uses a distinct connector style. This indicates missing position information, not a measured route or inferred disconnection. Altitude means meters above mean sea level.

The implementation uses Core’s existing PostgreSQL database and typed movement samples, with history reads separate from live Entity state. Additional measured fields and faster summaries can be added later without replacing this separation. The [implementation report](movement-history-implementation.md) records measured storage and query costs.

### Acceptance examples

These are expected outcomes for implementation validation, not claims of passing tests. Availability cases express the proposal’s requirement to report coverage honestly.

| Situation | Expected outcome |
| --- | --- |
| A stationary Sentry reports battery 80 to 79, omitting movement information. | No movement sample and no refreshed position time. |
| A source reports only speed or altitude. | Keep that quantity; do not fabricate a position or freshen an older reading. |
| Earlier observations are attached after a Track is created. | They appear at their historical times; the current marker and current readings do not change. |
| An upload includes a report measured 29 days ago and another older than 30 days. | Keep the eligible report for its remaining day, skip the expired report and clearly report counts. |
| Measurement time is unknown. | Use Atlas arrival time and identify that time basis. |
| A reading is 60 seconds old at the inspected time, then more than 60 seconds old. | No age cue at exactly 60 seconds; an age cue beyond it. Exact times remain inspectable. |
| Consecutive actual positions are 60 seconds apart, then more than 60 seconds apart. | Ordinary connection at exactly 60 seconds; distinct gap style beyond it. Unrelated reports and display simplification do not change this classification. |
| New live data arrives while an earlier report is pinned. | Historical inspection stays steady; the current marker continues updating. |
| A historical point overlaps a current Entity marker. | Map interaction prioritizes the current marker; history controls can still reach the report. |
| Left/right is pressed in focused history controls, then elsewhere. | Step historical reports in those controls; preserve existing navigation elsewhere. |
| Escape is pressed with historical details pinned. | Existing tools/dialogs handle it first when applicable; otherwise close the historical details before clearing the Entity. |
| No retained report exists for a requested reading or interval. | Show that data is unavailable; do not invent a value or silently label an incomplete trail as complete. |

The user approved the revised sidebar mock, including its control arrangement and dotted gap connectors, with "i like it" on 2026-09-09. The behavioral question frontier is complete and shared understanding is confirmed. The user rejected the first drafts for changing the UI too much and selected the existing sidebar for the entire history section. The approved design preserves the current Asset inspector sections and adds history using the same UI patterns. The visual mockup is kept locally outside the committed files. The bottom strip and floating report window are rejected. Implement the approved sidebar design using the existing production components; do not copy the mock shell or fixture code.

## Source checks

Read-only investigation completed on the current checkout; no runtime tests were run.

- Partial latitude, longitude, speed and altitude input is already supported. [Protocol schema](../packages/protocol/schema/jsonschema/atlas.schema.json), [SDK input types](../packages/sdk/src/types.ts), [merge behavior](../services/core/internal/actions/json_blob_contracts.go).
- Entity telemetry's altitude reference is unspecified. The command position contract explicitly uses meters above mean sea level, which supported the Q8 recommendation. Q8 now settles the intended telemetry meaning; source implementations have not yet been verified against it. [Entity telemetry guide](../services/core/docs/database-structure/entities.md), [Command position contract](atlas-protocol/commands-and-tasking.md).
- At the start of the investigation, Core check-in conversion supplied its own time without a source observation-time field. The implementation now accepts `movement_observed_at`. Meshtastic publication context already has observation time, so new history ingestion must preserve it where available. [Check-in conversion](../services/core/internal/api/handlers/handler_requests.go), [Link publication types](../packages/meshtastic-link/src/types.ts).
- There is no existing movement-history correction UI, sample-deletion API or trail-gap policy to preserve. [Current Entity actions](../services/core/internal/actions/entity_actions.go), [SDK Entity operations](../packages/sdk/src/client.ts).

These findings establish facts and integration constraints, not user preferences. The follow-up read-only map check is complete:

- Current Entity selection is separate from any future historical-point selection. Selecting on the map opens the Entity inspector without claiming camera focus. [Selection state](../surfaces/command-interface/src/state/selection.ts).
- Existing drawing consumes map clicks, current Entity hover uses the reticle, overlapping Entity clicks cycle targets, and map Escape/arrow keys have established ownership. History must preserve those behaviors. [Pointer handling](../surfaces/command-interface/src/ui/map/interaction/use-map-reticle-pointer.ts), [Escape handling](../surfaces/command-interface/src/ui/map/interaction/use-map-reticle-effects.ts), [MapView](../surfaces/command-interface/src/ui/map/view/MapView.tsx).
- Entity inspectors use sections and a shared optional section action, not tabs. No historical-point hover or click behavior exists yet. [Track inspector](../surfaces/command-interface/src/features/tracks/TrackInspector.tsx), [shared panels](../surfaces/command-interface/src/features/shared/panels.tsx).

Q14 through Q16 settle reported-point hover, click, overlap and focused keyboard behavior while preserving existing map modes. No runtime tests were run for this source check.

## Supporting documents

- [Glossary](../CONTEXT.md)
- [Accepted scope decision](design-decisions/2026-09-09-movement-history-has-a-narrow-domain-boundary.md)
- [Accepted report-semantics decision](design-decisions/2026-09-09-movement-history-preserves-reported-values.md)
- [Accepted altitude decision](design-decisions/2026-09-09-movement-altitude-uses-mean-sea-level.md)
- [Implementation investigation](entity-history-investigation.md)
