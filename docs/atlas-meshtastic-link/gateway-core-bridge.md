# Gateway and Atlas Core bridge

The Gateway connects one Meshtastic mesh to Atlas Core through the Atlas SDK. It translates intentional Field reports into Core operations. It does not synchronize the contents of its Shared Picture as a database replica.

## Distinct state systems

| System | Purpose | Lifetime and authority |
| --- | --- | --- |
| Shared Picture | Give each field machine a useful latest-known operational view | Ephemeral, locally assembled, possibly incomplete |
| Atlas Core | Preserve Atlas resources, enforce operations, and own authoritative Task state | Durable and authoritative according to Atlas Protocol |

A record appearing in the Gateway's Shared Picture is not sufficient reason to write it to Core. The Gateway must know that it received a valid Field report and has not already submitted that report.

## Field reports

The Gateway submits supported field-originated Atlas activity to Core once. Initial examples include:

- Asset position, telemetry, health, and runtime reports
- New or updated Tracks and Track telemetry reported by an Asset
- Geofeatures created or changed by an Asset
- Task acknowledgement, progress, cancellation handling, completion, and failure
- Explicit Entity, Object, or Object-content operations supported by the link

The Gateway validates the message, identifies its role-tagged source Link node, binds an originating Asset and Atlas Runtime ID when applicable, deduplicates repeated radio delivery, and invokes the corresponding typed Atlas SDK operation. It never turns an arbitrary picture mutation into a generic Core write.

## Loop prevention

The Gateway does not submit:

- Its own Core-originated feed broadcasts
- Passive duplicates of a Field report it already processed
- State learned only by restoring or querying its local Shared Picture
- Transport acknowledgements, retries, fragments, or joining traffic

Every Field report therefore needs a stable operation or observation identity and provenance that survives radio duplication and application retries.

## Task authority and confirmation

Core is final for every Task. The Shared Picture may show a field report before Core responds so peers can see current activity without waiting on the internet path.

The Gateway sends eligible Task assignments and cancellations to their addressed Asset through the confirmed Task path without requiring a Link subscription. A `tasks_for_asset` Link subscription is an observational feed for Shared Pictures. It cannot deliver executable work or acknowledge a Task.

The Gateway may use Atlas Core's change feed as the signal that Task state changed for a joined Asset, then reconcile that state through the confirmed delivery path. That internal Core subscription is not a Link subscription and does not make Task delivery best effort.

For each Asset, the Gateway dispatches confirmed Task assignments in Core's authoritative order. It waits for application acknowledgement, rejection, or terminal state before delivering the next assignment, but it does not wait for the earlier Task to finish. The Asset application owns its local Task queue and execution order.

A Task record distinguishes:

- Field-reported state awaiting Core confirmation
- Core-confirmed authoritative state
- A rejected field transition followed by the authoritative Core state

When Core rejects a Task transition, the Gateway returns the rejection to the originating Asset. Every Link service that receives the resulting authoritative Task state replaces its provisional view. The rejection remains available as bounded diagnostic evidence rather than as a permanent picture record.

## Other field-created resources

An Asset may report telemetry, create a Track, or request creation of a Geofeature. The Shared Picture may expose the reported state immediately. Core still validates the corresponding operation and returns the durable resource identity and version when applicable.

The resulting Core state may replace or confirm the provisional picture record. The exact temporary identity scheme for a field-created resource remains a wire-protocol decision.

## Core connectivity loss

Core or Gateway loss is outside normal expected operation, but joined Assets continue exchanging shared field state. The Gateway durably retains important Task lifecycle and explicit write operations while coalescing routine telemetry to its latest value.

When Core returns, the Gateway submits retained important operations, sends the latest coalesced telemetry, restores active subscribed feeds, and resumes current operation. It does not replay historical telemetry or dump Core state onto the radio. The exact durable outbox implementation remains an implementation decision.
