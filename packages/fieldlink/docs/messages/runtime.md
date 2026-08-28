# Runtime message

Runtime is FieldLink message ID 3. It carries one Asset runtime lifecycle
through a broad JSON request and response message.

## Implementation status

| Status                   | Scope                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implemented in FieldLink | `register`, `ready`, `check_in`, and `stop` envelopes; runtime validation; response correlation; replay protection; CLI input, evidence, and a transport-only responder. |
| Atlas integration        | Not implemented. Future Asset and Gateway applications own SDK validation, source binding, and recovery.                                                                 |
| Planned                  | Durable application operation journaling and radio sender authentication. Periodic check-in policy remains the deployed Asset application's responsibility.              |

## Request contract

Every request carries `request_id`, `asset_id`, and `runtime_id`.
`request_id` correlates one response and protects an accidental retry.
`asset_id` is the stable locally configured Atlas Entity ID. `runtime_id` is
fresh for one Asset process start.

| Operation  | Additional fields | Atlas behavior                                                                                            |
| ---------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `register` | `asset`           | Ensure the Asset Entity exists, then begin the runtime registration.                                      |
| `ready`    | `manifest`        | Publish the fixed Protocol Command Manifest after the Asset application establishes its local safe state. |
| `check_in` | `body`            | Submit observed Asset state through the current registered runtime.                                       |
| `stop`     | None              | Stop the matching runtime after Core confirms it.                                                         |

Register example:

```json
{
  "type": "runtime",
  "kind": "request",
  "operation": "register",
  "request_id": "register-runtime-1",
  "asset_id": "asset-1",
  "runtime_id": "runtime-7f347e18",
  "asset": {
    "entity_id": "asset-1",
    "entity_type": "asset",
    "alias": "Field asset 1"
  }
}
```

`asset.entity_id` must equal `asset_id`. The Atlas SDK validates the complete
`asset` object as an Atlas `EntityCreateRequest` before Core uses it. An
integrating application can create the Entity after a fresh read returns `404`.
A concurrent create conflict means another writer won the same race.

Ready example:

```json
{
  "type": "runtime",
  "kind": "request",
  "operation": "ready",
  "request_id": "ready-runtime-1",
  "asset_id": "asset-1",
  "runtime_id": "runtime-7f347e18",
  "manifest": []
}
```

The manifest uses the Atlas Protocol `CommandManifest` shape. FieldLink checks
that it is JSON; an integrating application and Core enforce the Protocol
contract. This is an Asset-owned declaration of commands it can execute, not a
FieldLink command-catalog query.

Check-in example:

```json
{
  "type": "runtime",
  "kind": "request",
  "operation": "check_in",
  "request_id": "check-in-runtime-1",
  "asset_id": "asset-1",
  "runtime_id": "runtime-7f347e18",
  "body": {
    "status": "online",
    "latitude": 38.8977,
    "longitude": -77.0365
  }
}
```

The body uses the Atlas Protocol `EntityCheckInRequest` shape. Its telemetry
fields are flat JSON fields; an integrating application must map them to the
SDK call and re-establish its own runtime state after restarting. FieldLink does
not define that recovery policy.

Stop example:

```json
{
  "type": "runtime",
  "kind": "request",
  "operation": "stop",
  "request_id": "stop-runtime-1",
  "asset_id": "asset-1",
  "runtime_id": "runtime-7f347e18"
}
```

## Response contract

A successful lifecycle write returns `204`:

```json
{
  "type": "runtime",
  "kind": "response",
  "request_id": "ready-runtime-1",
  "status": 204
}
```

An integrating application may retain Atlas API failures as numeric statuses
with bounded JSON error details. A response reports the application's result.
It does not replace FieldLink delivery evidence.

## Replay and trust

The test responder accepts requests only from radio A's preflight Node ID. It
caches 64 request IDs for the adapter process lifetime. Repeating identical
JSON replays the first response. Reusing an ID for different JSON returns `409`
without calling Atlas.

This is retry protection, not authentication. Any MeshCore channel member can
spoof a FieldLink Node ID. Use dedicated test radios on a trusted channel. An
integrating application must keep its API key outside FieldLink and apply its
own source admission and Asset ownership checks.

## Two-radio transport exercise

Save one Runtime request as JSON and run:

```bash
npm run fieldlink -- test \
  --a /dev/cu.usbmodem-A \
  --b /dev/cu.usbmodem-B \
  --message runtime \
  --runtime-request runtime.json \
  --retry-strategy selective-window \
  --allow-inbox-drain
```

The CLI validates the Runtime request before opening either radio. Adapter B's
canned responder returns the matching response. The run proves RF transport and
correlation only. Atlas registration, recovery, ownership, and lifecycle
mapping are not implemented.

The encoded Runtime message shares FieldLink's 1 MiB limit. Messages over 132
encoded bytes use the normal FieldLink transfer protocol.
