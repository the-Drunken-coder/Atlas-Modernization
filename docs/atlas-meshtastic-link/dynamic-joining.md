# Dynamic field joining

This document defines how an Asset joins the Atlas Meshtastic mesh. The Gateway owns admission and private-channel membership. Its authentication policy remains replaceable.

## Product behavior

- One Gateway serves the mesh.
- The Gateway is the only join authority. Peer Assets do not admit new members.
- Every Asset-mode Link service discovers, authenticates, and joins whenever it starts.
- The Gateway-mode Link service does not join through itself. It bootstraps from Gateway-owned membership state.
- A previous Asset join is not durable service membership. The Asset clears or disables old private-channel material before discovery.
- The Asset keeps one stable Atlas Asset ID on its machine. The radio's Meshtastic node identity is not the Asset identity.
- Gateway join authentication is a replaceable policy so its mechanism can change without replacing discovery, channel setup, or the rest of the Link service.
- Join messages that carry credentials or private-channel material use Meshtastic public-key encryption. The Link refuses shared-channel-key fallback.
- A Link service that starts while the Gateway is unavailable waits to join. Asset services that remain running continue participating.
- The system targets a cooperative environment rather than an active adversary, but it still rejects malformed, unauthenticated, or downgraded join traffic.

## Gateway bootstrap and membership ownership

The Gateway deployment owns one durable Link membership record. It contains the current private Atlas channel material, the Gateway's stable Link node identity, its source-generation counter, and the next source generation for each admitted Asset.

Initializing a new Gateway creates this record once. Ordinary Gateway restarts load the existing record and fail clearly if it is missing or corrupt. A restart never generates a new private-channel key. Key rotation is a separate explicit operation because changing the key disconnects running members until they rejoin.

The Gateway-mode Link service first converges the common static Radio profile, then installs the current dynamic membership material on its local radio. It increments its durable source generation and begins listening for discovery traffic. This is bootstrap, not admission through another node.

The common Radio profile and Link membership are different inputs:

- The Radio profile defines modem, relay, public rendezvous, module, and channel-slot settings shared by every supported radio.
- Link membership supplies the current private-channel secret and source generation.
- Asset and Gateway radios still converge to the same radio behavior. The difference is how their companion-computer software obtains membership.

## Asset join flow

The exact message encodings remain open, but the required flow is:

1. The Asset-mode Link service connects to its local Meshtastic radio.
2. Startup convergence applies the common static Radio profile and clears or disables private-channel material left by an earlier service session.
3. The Asset broadcasts an Atlas discovery beacon on the public rendezvous channel.
4. The Gateway and Asset obtain each other's Meshtastic public keys through Meshtastic node information. The Gateway waits rather than using symmetric channel encryption if the Asset key is unavailable.
5. The Gateway responds through a public-key-encrypted Meshtastic direct message.
6. The Gateway and Asset run the configured join-authentication policy through public-key-encrypted direct messages.
7. On acceptance, the Gateway assigns the Asset a source generation greater than every generation it previously issued for that Asset. It returns that generation and the current private Atlas channel material.
8. The Asset installs the membership material in its private secondary-channel slot and verifies it.
9. The Gateway publishes the Asset's active stable identity, service session, and source generation on the private channel. Peers retire any older generation for that Asset.
10. The Asset stops its public discovery beacon, accepts publications from the Asset application, answers addressed requests, and exposes received state through its Shared Picture.

The service rejects a protected join message unless the radio reports that Meshtastic public-key encryption authenticated it. Firmware must be Meshtastic 2.7.15 or newer because older releases allowed direct messages to fall back to shared-channel encryption. The implementation pins and tests a specific supported patch release rather than accepting an untested version solely because its number is higher.

`LOCAL_ONLY` rebroadcasts traffic associated with a radio's configured primary and secondary channels. Intermediate radios cannot decrypt a public-key direct message addressed to another node, so three-radio discovery and joining through a relay is a required hardware acceptance test. If that test fails, the implementation must change the rendezvous relay configuration or join exchange before field use.

## Discovery beacon

The public beacon is a structured Atlas application message rather than ordinary Meshtastic chat text. It contains:

- Atlas discovery marker
- Fresh join-attempt ID
- Meshtastic radio node identity
- Stable Atlas Asset ID
- Fresh Link service session identity
- Supported Meshtastic Link capabilities

It contains no location, Tasks, telemetry, credentials, private-channel material, or Shared Picture contents.

The Asset sends the beacon immediately, then every five seconds with slight random variation for the first thirty seconds. It then retries every thirty seconds until the Gateway responds. Successful joining stops the beacon immediately.

Losing the local radio connection stops the join attempt and its retry timer. The service reports an error and drains any in-flight join work during shutdown. A disconnected radio requires a service restart; an unavailable Gateway continues to use discovery retries.

The public rendezvous channel stays configured after joining. Joined Asset-mode Link services ignore unrelated public traffic, and the Gateway continues listening for new discovery beacons.

## Source generations

Every Link service start creates a fresh service session identity and resets its source sequence. The Gateway also assigns a durable, increasing source generation to that service instance. Every normal Link envelope carries the role-tagged source Link node, source generation, service session, and source sequence.

A receiver tracks the greatest accepted generation for each source Link node. Accepting a higher generation retires every lower generation and its service sessions. A packet from a retired generation cannot replace newer accepted state. For a previously unseen generation, the first valid private-channel packet binds its service session; a Gateway activation announcement may bind it first. Once bound, a different service session at the same generation is rejected. Source sequence rejects duplicate and reordered stale updates to the same record within the bound session without discarding unrelated records that arrive out of order.

## Startup picture behavior

Joining must not cause the Gateway to dump its stored state onto the channel. The new Link service starts with an empty Shared Picture and fills it by listening to routine live publications. The Shared Picture is not restored from disk.

The initial five-radio system should normally produce a useful current picture within thirty seconds. This target applies to current active state, not historical observations. Old data that is no longer being published is allowed to remain absent.

The Link service reports ready as soon as it has joined and its local service interface is operational. Thirty-second convergence is an acceptance target for normal field conditions, not a readiness gate.

The Shared Picture does not distinguish ownership based on who requested a message:

- Useful state heard passively may enter the picture.
- Useful state returned for the local Asset's request may enter the picture.
- Only the requester completes the corresponding local request.
