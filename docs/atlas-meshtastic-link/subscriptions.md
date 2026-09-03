# Link subscriptions

A Link subscription asks the Gateway to publish and refresh selected Atlas data on the shared channel. It is a request for a feed, not a private delivery route or permission to read the data.

## Combined demand

The Gateway combines subscriptions from every joined Link service:

1. The first subscription for a feed creates publication demand.
2. Additional subscriptions for the same feed do not create additional radio transmissions.
3. An update for an in-demand feed is broadcast once on the shared channel.
4. Every Link service may add the update to its Shared Picture, including Link services that did not subscribe.
5. One Link service unsubscribing removes only its demand.
6. Publication stops only after no Link service still subscribes to the feed.

## Feed selectors

The initial system supports:

- One exact Atlas record by resource type and ID
- All records of one supported Atlas resource type
- Tasks assigned to one Asset

The link does not add an arbitrary query language or geographic filtering. A new selector should be added only for a demonstrated field need.

## Subscription lifetime

Link subscriptions are renewable leases. A Link service renews its active subscriptions while joined. If it disappears without unsubscribing, its leases expire and stop contributing publication demand.

A Link service renews each active Link subscription every thirty seconds. The Gateway lease expires after ninety seconds without a renewal. One or two lost renewals therefore do not stop the feed, while demand from a vanished Link service disappears within roughly a minute and a half. An explicit unsubscribe removes that Link service's demand immediately.

## Feed update behavior

The Gateway coalesces superseded state while it waits for radio capacity. If several position, Track, or observational Task updates accumulate for the same feed, it keeps the newest state for each record and does not replay obsolete intermediate values.

When the first Link service subscribes to a feed, the Gateway broadcasts the current value once and then publishes subsequent updates. Additional subscribers reuse the active feed and do not trigger another initial broadcast unless the current value has not yet been published.

`tasks_for_asset` is an observational Shared Picture feed. It does not deliver work. The Gateway sends eligible Task assignments and cancellations to their addressed Asset through the confirmed Task path without requiring a Link subscription. A Task received only through the feed never invokes the Asset's Task handler and never counts as Task acknowledgement.

## Duplicate-path airtime concern

Combined demand prevents two subscribers from causing two Gateway broadcasts. It does not prevent the same underlying field data from crossing the channel twice through different paths.

```text
Asset A broadcasts its position ---> every radio, including Gateway and Asset B
Gateway writes or observes it in Core
Asset B subscribes to Asset A's position
Gateway broadcasts the Core feed ----> every radio, including Asset B
```

Asset B already learned the position from Asset A's original broadcast. The Gateway feed can therefore spend additional airtime carrying data that was already available in the mesh.

This concern is intentionally unresolved. The architecture must preserve enough source and provenance information to measure the duplicate path during simulation and field testing. No suppression, coalescing, or source-preference rule has been accepted yet.

## Distinction from Atlas Core subscriptions

The Gateway may use Atlas SDK and Core change-feed subscriptions to obtain requested data, but those are an implementation mechanism behind the Gateway. A Link subscription is the field-facing request that creates shared-channel publication demand.
