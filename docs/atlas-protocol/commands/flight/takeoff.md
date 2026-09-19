# flight.takeoff

Climb an already-armed ArduPilot quadcopter in Guided mode to an absolute
altitude and settle into a position hold.

## Semantics

- Input `altitude_m` is meters above mean sea level. Operators enter height
  above launch; the submitter converts to mean sea level with verified launch
  elevation before Task creation. The host rejects the Task when the reference
  cannot be established.
- Atlas never arms. The aircraft must already be armed through the independent
  RC transmitter.
- Position holding is the airborne idle state; there is no separate Hold
  Command.

## Preconditions (enforced by the host at execution)

- Connected vehicle identity matches startup configuration.
- Aircraft armed, ready, and in Guided mode.
- No other flight Task active. Go-to during takeoff is rejected.

## Outcomes

- `completed`: reached the requested altitude and settled into a hover.
- `failed` (`precondition_failed`): not armed, not ready, or not in Guided.
- `failed` (`execution_failed`): pilot takeover (mode left Guided), timeout,
  or no progress. A failed takeoff requests Land while Guided and airborne.
- Takeoff supports no ordinary cancellation after starting (`supports_cancel`
  is false); pilot takeover remains available.
- MAVLink acknowledgement alone is never completion.

## Durable effects

Standard Task lifecycle only. No output schema.

## Example

```json
{
  "asset_id": "quad-01",
  "command": "flight.takeoff",
  "input": { "altitude_m": 585.5 }
}
```
