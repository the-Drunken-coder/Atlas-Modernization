# Atlas context map

Atlas is a multi-module system. Read the root `CONTEXT.md` for terms that cross subsystem boundaries, then use the nearest subsystem documentation for the work at hand.

| Context | Location | Scope |
| --- | --- | --- |
| System vocabulary | `CONTEXT.md` | Terms shared across Atlas |
| Core | `services/core/` | Central Atlas services and durable storage |
| Protocol | `packages/protocol/` | Atlas wire contract and generated APIs |
| SDK and reusable packages | `packages/` | Client libraries and reusable runtime code |
| Operator surfaces | `surfaces/` | Command interface and Core CLI |
| Field and transport | `edge/`, `packages/meshtastic-link/`, `simulations/` | Field roles, communications, and simulation |

System-wide durable decisions live in `docs/design-decisions/`. Add a context-specific `CONTEXT.md` only when a subsystem needs vocabulary that the root glossary cannot express clearly.
