# Feed subscription readiness is not acknowledged

1. **Time & Date:** 2026-08-05 America/Los_Angeles
2. **Status:** Open
3. **Current limitation:** The WebSocket server applies valid subscription commands silently. The SDK sends its initial subscriptions after `hello` and then starts changed-since recovery without knowing that Core has processed those commands.
4. **Impact:** An event committed after the recovery snapshot but before the subscription is active can be absent from both that recovery response and the live feed. Normal safety polling catches it on the next changed-since request. A client configured with `pollIntervalMs: 0` can remain stale indefinitely. This race predates the transactional recovery-log work, so reconnect recovery must not be described as sufficient by itself while the protocol remains unacknowledged.
5. **Required resolution:** Add a server acknowledgment after the complete initial subscription set is active, then have the SDK wait for it before taking the recovery snapshot. Buffer any feed events received during that handshake and apply them after recovery in version order. A version watermark in the acknowledgment is desirable but not required if subscription activation happens before the acknowledgment is sent.
6. **Interim rule:** Production clients must keep safety polling enabled.
