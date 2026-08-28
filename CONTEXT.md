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

**Edge Gateway**:
A field-deployed Atlas system that connects one or more communication methods to Atlas Core without representing an Asset.
_Avoid_: Asset Host, Source Gateway

**Plugin**:
An Atlas-managed extension that consumes External sources or Atlas data and may expose Operations, publish Datastreams, or request Atlas actions. A configured Plugin maps to one deployment-managed container and may optionally register one Tool Asset. Its availability may be `starting`, `available`, or `unavailable`.
_Avoid_: Asset, External source, standalone API

**Operation**:
A bounded request and response capability exposed by a Plugin through Atlas.
_Avoid_: Datastream, arbitrary endpoint

**Datastream**:
A named data product published by a Plugin for clients to consume without exposing an External source directly.
_Avoid_: External API, Core change feed
