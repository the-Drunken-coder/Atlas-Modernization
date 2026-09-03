# Dynamic field joining

This document defines the target field experience for bringing an Asset onto the Atlas Meshtastic mesh. Authentication belongs to the Gateway but its mechanism is intentionally replaceable.

## Product behavior

- One Gateway serves the mesh.
- The Gateway is the only join authority. Peer Assets do not admit new members.
- A Meshtastic Link Runtime performs discovery and joining every time it starts.
- A previous successful join is not treated as durable runtime membership.
- The Asset keeps one stable Atlas Asset ID on its machine. The radio's Meshtastic node identity is not the Asset identity.
- Gateway join authentication is a replaceable policy so its mechanism can change without replacing discovery, channel setup, or the rest of the Runtime.
- A successful join is observable, but the system is designed for a cooperative environment rather than an active adversary.
- A Runtime that starts while the Gateway is unavailable waits to join. Already running members continue participating.

## Target flow

The precise wire shapes remain undecided, but the intended behavior is:

1. The Runtime connects to its local Meshtastic radio.
2. Startup convergence configures the known public Atlas rendezvous channel and common modem settings.
3. The Asset Runtime broadcasts an Atlas discovery beacon on the public rendezvous channel.
4. The one Gateway hears the beacon and responds through a Meshtastic direct message.
5. The Gateway and Asset run the configured join-authentication policy through direct messages.
6. On acceptance, the Asset receives the private Atlas channel membership material and applies it to its local radio.
7. The Runtime joins the shared Atlas channel and announces its stable Asset identity and new runtime presence.
8. The Runtime stops its public discovery beacon, accepts publications from the Asset application, answers addressed requests, and exposes received state through its Shared Picture.

The existing Meshtastic shareable channel configuration and direct-message support make this flow feasible. The implementation should reuse those capabilities rather than invent another radio configuration format.

The public beacon is a structured Atlas application message rather than ordinary Meshtastic chat text. It contains:

- Atlas discovery marker
- Fresh join-attempt ID
- Meshtastic radio node identity
- Stable Atlas Asset ID
- Supported Meshtastic Link capabilities

It contains no location, Tasks, telemetry, credentials, or Shared Picture contents.

The Asset sends the beacon immediately, then every five seconds with slight random variation for the first thirty seconds. It then retries every thirty seconds until the Gateway responds. Successful joining stops the beacon immediately.

The public rendezvous channel stays configured after joining. Joined Asset Runtimes ignore unrelated public traffic, and the Gateway continues listening for new discovery beacons.

## Startup picture behavior

Joining must not cause the Gateway to dump its stored state onto the channel. The new Runtime starts with an empty Shared Picture and fills it by listening to routine live publications. The Shared Picture is not restored from disk.

The initial five-radio system should normally produce a useful current picture within thirty seconds. This target applies to current active state, not historical observations. Old data that is no longer being published is allowed to remain absent.

The Runtime reports ready as soon as it has joined and its local service interface is operational. Thirty-second convergence is an acceptance target for normal field conditions, not a readiness gate.

The Shared Picture does not distinguish ownership based on who requested a message:

- Useful state heard passively may enter the picture.
- Useful state returned for the local Asset's request may enter the picture.
- Only the requester completes the corresponding local request.
