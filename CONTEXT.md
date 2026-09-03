# Atlas domain

Atlas is a control plane for observing entities, preserving operational data, and tasking assets. This glossary fixes terms whose meaning crosses package and deployment boundaries.

## Entities

**Asset**:
An Entity that represents a taskable or reporting system participating in Atlas.
_Avoid_: Plugin, device record

**Asset Host**:
The one computer running the Atlas process for one Asset. Attached autopilots, sensors, radios, and controllers are peripherals of that host.
_Avoid_: distributed Asset, Asset cluster

**Tool Asset**:
An Asset that represents a taskable Plugin. It receives Protocol-authored Commands through the normal Atlas Task system.
_Avoid_: every Plugin, Operation

**Track**:
An Entity that represents an observed moving subject whose state may change over time.
_Avoid_: Asset, stream item

**Geofeature**:
An Entity that represents a spatial feature or area, such as a building footprint or an area selected for monitoring.
_Avoid_: Asset, Track

## Plugins and external data

**External source**:
A system outside Atlas from which a Plugin obtains data, such as OpenStreetMap or an ADS-B provider.
_Avoid_: Datastream, Plugin

**Source connector**:
Atlas-managed access to one External source. It owns access mechanics while a Plugin owns the source-specific meaning of the data.
_Avoid_: Plugin, data model

**Source Gateway**:
The Atlas component through which Plugins use Source connectors without receiving External source credentials.
_Avoid_: External source, data normalizer

## Edge communications

**Communication method**:
A way an Asset Host or Edge Gateway exchanges Atlas data with another Atlas node. FieldLink, IP, and future radio protocols are communication methods, not Asset capabilities.
_Avoid_: FieldLink as the generic transport, Asset behavior

**Meshtastic Link**:
The accepted Atlas communication method that exchanges Atlas data through a shared Meshtastic radio mesh.
_Avoid_: FieldLink, generic Meshtastic chat

**Meshtastic Link service**:
The long-running local service that operates one Meshtastic Link, fulfills data requests, and exposes the node's Shared Picture to local software.
_Avoid_: Meshtastic Link Runtime, Runtime, radio firmware, Asset application

**Link client**:
A local program that reads the Shared Picture or asks the Meshtastic Link service to publish state, request data, or maintain a Link subscription.
_Avoid_: Runtime client, radio node, remote mesh member

**Link node**:
An Asset or Edge Gateway participating in Meshtastic Link. Its role-tagged Atlas identity is independent of the attached radio's Meshtastic node identity.
_Avoid_: radio, Meshtastic node identity

**Shared Picture**:
The ephemeral, continuously updated latest-known view of shared Atlas state maintained by a Meshtastic Link service. It includes useful traffic whether passively heard or explicitly requested, and each node's copy may temporarily differ.
_Avoid_: central database, `world_state.json`

**Link subscription**:
A request for the Gateway to publish and refresh selected Atlas data on the shared channel. Link subscriptions from all Link services are combined into publication demand and do not restrict who may receive the data.
_Avoid_: Core change-feed subscription, access grant, per-Asset transmission

**Field report**:
A valid Atlas state report or operation that originates from an Asset and is eligible for the Gateway to submit to Atlas Core once.
_Avoid_: every Shared Picture change, passive duplicate

**Radio profile**:
The single declarative set of static Meshtastic settings that every supported Atlas radio must match. Dynamic Link membership is not part of the profile.
_Avoid_: undocumented operator setup, firmware image

**Link membership**:
The Gateway-controlled private-channel material and source generation that admit a Link node to one Atlas mesh.
_Avoid_: Radio profile, prior service session

**Radio contract**:
The generated communication-method binding that carries Atlas Protocol resources and operations through Meshtastic Link. Atlas Protocol remains its source of truth; transport envelopes and fragmentation do not create a second Atlas data model.
_Avoid_: independent radio domain model, manually copied Atlas schema

**Edge Gateway**:
A field-deployed Atlas system that connects one or more communication methods to Atlas Core without representing an Asset.
_Avoid_: Asset Host, Source Gateway

**Plugin**:
An Atlas-managed extension that consumes External sources or Atlas data and may expose Operations, publish Datastreams, or request Atlas actions. A configured Plugin maps to one deployment-managed container and may optionally register one Tool Asset. Its availability may be `starting`, `available`, or `unavailable`.
_Avoid_: Asset, External source, standalone API

**Plugin release**:
An immutable version of one Plugin that Atlas can install independently of an Atlas Core release.
_Avoid_: Core release, running Plugin

**Plugin catalog**:
The signed Atlas-published index of trusted first-party Plugin releases.
_Avoid_: marketplace, runtime Plugin discovery

**Catalog entry**:
A Plugin release listed in the Plugin catalog. It is not an Installed Plugin or a runtime availability state.
_Avoid_: Installed Plugin, available Plugin

**Installed Plugin**:
A Plugin release retained by an Atlas deployment, whether or not that Plugin is enabled.
_Avoid_: Enabled Plugin, available Plugin

**Enabled Plugin**:
An Installed Plugin selected to run with Atlas.
_Avoid_: Installed Plugin, runtime availability

**Operation**:
A bounded request and response capability exposed by a Plugin through Atlas.
_Avoid_: Datastream, arbitrary endpoint

**Datastream**:
A named data product published by a Plugin for clients to consume without exposing an External source directly.
_Avoid_: External API, Core change feed
