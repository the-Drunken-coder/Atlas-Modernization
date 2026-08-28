# Observation and FieldLink Picture

Observation is FieldLink message ID 5 and defaults to normal priority. It is
the only currently registered message eligible for passive collection.

```json
{
  "type": "observation",
  "observation_id": "track-1-42",
  "observed_at": "2026-08-26T12:00:00Z",
  "resource_type": "track",
  "resource_id": "track-1",
  "body": {
    "track_id": "track-1",
    "latitude": 38.8977,
    "longitude": -77.0365
  }
}
```

`resource_type` is `entity`, `track`, `geofeature`, or `object`. `body` is the
complete latest-known JSON snapshot selected by its producer. FieldLink checks
finite JSON and envelope bounds. Atlas Core or the Asset application remains responsible for
domain validation and whether the data is trustworthy enough to use.

## Publication

`node.publish(observation)` uses destination `0000000000000000`. A small
Observation uses one complete frame. A larger one sends one transfer start and
every fragment once. Publication returns `confirmed: false`; listeners send no
ready, receipt, completion, or application acknowledgement. This prevents one
shared publication from causing a reply storm.

Nodes can also learn an Observation addressed to another node. They reassemble
it passively but never invoke its addressed handler. Passive transfer state is
bounded to four entries and expires after two minutes. A required missing
snapshot is recovered with an addressed Resource request, not by asking every
listener to acknowledge every publication.

## Picture

`FieldLinkPicture` records both addressed and passive Observations. Its file
contains:

- latest known state by resource type and ID;
- a bounded recent-observation journal, 1,000 entries by default;
- observation and receive times, source, destination, logical ID, delivery,
  SNR when available, and `authentication: "unverified"`.

Repeated observation IDs are idempotent per source. Older state stays queryable
and is marked stale after five minutes by default. Latest state, journal,
replay-cache entries, and total serialized bytes all have configurable bounds;
the defaults are 4,096 latest records, 1,000 journal records, 8,192 replay
entries, and 64 MiB. Picture replaces a resource's latest record by observation
time and then observation ID, and does not merge IDs, estimate identity, or
perform Track fusion. Persistence coalesces concurrent updates and uses an
atomic temporary-file rename.
