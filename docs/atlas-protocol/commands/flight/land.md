# flight.land

Land at the current location and disarm.

## Semantics

- Input is empty (`atlas.tasking.EmptyObject`). All intent is the command.
- May supersede an active takeoff or go-to; Core records the interrupted Task
  as `superseded`.
- The native Land mode transition is expected Atlas-requested behavior, not
  pilot takeover, and is observed through completion.
- An ongoing landing is preserved during link-loss recovery; reconnection
  never restarts another maneuver.

## Preconditions (enforced by the host at execution)

- Aircraft airborne.

## Outcomes

- `completed`: landed at the current location and disarmed.
- `failed`: timeout or no progress; the autopilot recovery action is left
  running.
- No ordinary cancellation after starting (`supports_cancel` is false).

## Durable effects

Standard Task lifecycle only. No output schema.

## Example

```json
{
  "asset_id": "quad-01",
  "command": "flight.land",
  "input": {}
}
```
