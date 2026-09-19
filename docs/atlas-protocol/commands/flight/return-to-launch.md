# flight.return_to_launch

Recover the aircraft: return to launch, land, and disarm.

## Semantics

- Input is empty (`atlas.tasking.EmptyObject`). All intent is the command.
- May supersede an active takeoff or go-to; Core records the interrupted Task
  as `superseded`.
- The native RTL mode transition is expected Atlas-requested behavior, not
  pilot takeover, and is observed through completion.
- Requested after Core-loss grace expiry only while Atlas has control
  (Guided). Never overrides manual flight.

## Preconditions (enforced by the host at execution)

- Aircraft airborne. When issued as Core-loss recovery, Atlas must have
  control (Guided mode).

## Outcomes

- `completed`: returned, landed, and disarmed at launch.
- `failed`: timeout or no progress; the autopilot recovery action is left
  running.
- No ordinary cancellation after starting (`supports_cancel` is false).

## Durable effects

Standard Task lifecycle only. No output schema.

## Example

```json
{
  "asset_id": "quad-01",
  "command": "flight.return_to_launch",
  "input": {}
}
```
