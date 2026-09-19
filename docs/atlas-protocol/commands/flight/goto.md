# flight.goto

Fly to an absolute destination in meters above mean sea level, then hold
position as the airborne idle state.

## Semantics

- Input carries absolute `latitude`, `longitude`, and `altitude_m` (mean sea
  level). Terrain elevation is never inferred from a map click.
- The map flow selects the aircraft, right-clicks a map-background
  destination, reviews coordinates and altitude, and explicitly submits.
  Choosing a point alone never dispatches a Task.
- A new go-to replaces an active go-to; Core records the replaced Task as
  `superseded`. No future movement queue accumulates.
- Go-to during takeoff is rejected. New flight actions outside Guided are
  rejected rather than saved.

## Preconditions (enforced by the host at execution)

- Aircraft in Guided mode with usable observations.
- No takeoff active.

## Outcomes

- `completed`: reached the requested position and altitude, followed by idle
  hold.
- `cancelled` (`requested`): ordinary cancellation is supported; while still
  Guided with usable observations the host actively establishes idle hold at
  the current position. Merely ceasing messages does not cancel.
- `cancelled` (`superseded`, applied by Core): replaced by a newer go-to, or
  interrupted by return-to-launch / land recovery.
- `failed` (`precondition_failed` / `execution_failed`): outside Guided,
  takeover, timeout, or no progress. A failed go-to establishes idle hold
  while Guided with usable telemetry.

## Durable effects

Standard Task lifecycle only. No output schema.

## Example

```json
{
  "asset_id": "quad-01",
  "command": "flight.goto",
  "input": { "latitude": 37.7749, "longitude": -122.4194, "altitude_m": 590.0 }
}
```
