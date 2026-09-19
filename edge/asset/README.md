# Atlas ArduPilot Asset Host

One Asset Host process for one ArduPilot quadcopter. This is the first
supported Atlas Asset implementation: a TypeScript/Node.js program on macOS
that represents the aircraft as an Asset, translates Atlas Tasks into aircraft
actions, and reports observed state. The autopilot and SiK radios are
peripherals, not Atlas compute nodes.

## Run

```sh
cp config.example.toml asset.toml
# edit asset.toml: Core URL/key, Asset id, serial port, vehicle identity
npm run build --workspace @the-drunken-coder/atlas-asset
node edge/asset/dist/cli.js --config asset.toml
```

Configuration loads once at startup; file edits never change flight behavior
while running. Keep the credential-bearing file out of version control.

## Behavior

- Direct Core connection through the public Atlas SDK. No Worker proxy, no
  browser-to-radio path, no local flight-command API.
- Verifies the connected vehicle (system/component identity, quadcopter type,
  ArduPilot autopilot) and required configuration (GCS failsafe
  `FS_GCS_ENABLE`, battery, GPS, verified launch elevation) before runtime
  readiness. Failures explain what is wrong; the host never changes aircraft
  configuration.
- Four production Commands (`flight.takeoff`, `flight.goto`,
  `flight.return_to_launch`, `flight.land`), all immediate scheduling. Go-to
  replaces go-to; RTL/land interrupt takeoff/go-to via Core supersession.
- RC arming is separate; Atlas never arms and never forces Guided. Leaving
  Guided fails the interrupted Task; returning to Guided holds the new
  position and awaits fresh tasking. Expected native RTL/Land transitions are
  observed to completion, not treated as takeover.
- Takeoff needs armed + ready + Guided and completes on reaching altitude plus
  hover settle. Go-to completes on position + altitude arrival, then idle
  hold. Only go-to supports ordinary cancellation (active idle hold). RTL
  completes on return + land + disarm; land on touchdown + disarm.
- Core loss stops new starts with a configurable 5s grace period. Recovery
  reconnects and reconciles before continuing; after expiry it requests RTL
  only under Atlas control. Reconnection never resumes the interrupted action,
  and an ongoing landing is preserved. Host/SiK loss relies on the verified
  onboard heartbeat-loss failsafe (the host sends GCS heartbeats).
- Every restart uses a fresh runtime identity under normal Core fencing.
  Telemetry resumes, but flight readiness waits for landed + disarmed state.
- Ctrl+C requests RTL when airborne under Atlas control and briefly awaits
  mode confirmation; ongoing RTL, landing, or manual control is preserved.
  The runtime registration is left for the next process, whose fresh identity
  drains stale work.

## Compatibility

- Transport is a serial MAVLink connection, independent of SiK radio model.
- Target: ArduCopter stable; the exact tested release is recorded in
  validation evidence, not assumed from the firmware metadata URL.
- Tested versions and hardware results: simulation runs against the same
  MAVLink handling over TCP (`transport = "tcp"`). macOS serial and aircraft
  verification on the intended setup remain explicitly outstanding until
  recorded here.

## Checks

```sh
npm run check --workspace @the-drunken-coder/atlas-asset
```
