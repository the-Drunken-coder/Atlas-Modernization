import { describe, expect, it } from "vitest";
import { SharedPicture } from "./picture.js";
import { GatewaySubscriptionDemand, LocalSubscriptionDemand } from "./subscriptions.js";
import { positionPublication } from "./test-fixtures.js";

describe("Shared Picture", () => {
  it("provides a gap-free snapshot cursor and bounded replay", () => {
    const picture = new SharedPicture("picture-session", 4);
    picture.apply(positionPublication(1), context(1));
    const snapshot = picture.snapshot();
    picture.apply(positionPublication(2), context(2));
    const live: number[] = [];
    const subscription = picture.subscribeAfter(snapshot.session, snapshot.revision, (event) =>
      live.push(event.revision)
    );
    expect(subscription.replay.map((event) => event.revision)).toEqual([2]);
    picture.refresh(2_000);
    expect(live).toEqual([]);
    picture.refresh(7_000);
    expect(live).toEqual([3]);
  });

  it("marks positions stale after five seconds and removes them after thirty", () => {
    const picture = new SharedPicture("picture-session");
    picture.apply(positionPublication(1), context(1));
    picture.refresh(5_001);
    expect(picture.snapshot().records[0]?.freshness).toBe("stale");
    picture.refresh(30_001);
    expect(picture.snapshot().records).toHaveLength(0);
  });

  it("accepts reordered sequences when they update different records", () => {
    const picture = new SharedPicture("picture-session");
    const alpha = positionPublication(1);
    const bravo = positionPublication(1);
    bravo.resource = { ...bravo.resource, alias: "Bravo", entity_id: "asset-bravo" };
    expect(picture.apply(alpha, context(2))).toBe(true);
    expect(picture.apply(bravo, context(1))).toBe(true);
    expect(picture.snapshot().records.map((record) => record.id)).toEqual(["asset-alpha", "asset-bravo"]);
  });

  it("applies an explicit deletion at its changed-since feed version", () => {
    const picture = new SharedPicture("picture-session");
    const deletion = { ...positionPublication(1), deleted: true, atlas_version: 2 } as const;
    expect(picture.apply(positionPublication(1), context(1))).toBe(true);
    expect(picture.apply(deletion, context(2))).toBe(true);
    expect(picture.snapshot().records).toEqual([]);
  });

  it("degrades an active Task when its assigned Asset disconnects", () => {
    const picture = new SharedPicture("picture-session");
    picture.apply(
      {
        type: "state",
        resource_type: "task",
        resource: {
          asset_id: "asset-alpha",
          command: "atlas.survey",
          created_at: "2026-09-02T12:00:00Z",
          input: {},
          status: "pending",
          task_id: "task-1",
          updated_at: "2026-09-02T12:00:00Z"
        },
        observation_time: "2026-09-02T12:00:00Z",
        path: "gateway_feed",
        confirmation: "core_confirmed"
      },
      {
        source: { role: "gateway", id: "gateway" },
        source_generation: 1,
        service_session: "gateway-session",
        source_sequence: 1,
        received_at: 0
      }
    );

    picture.markSourceConnectivity({ role: "asset", id: "asset-alpha" }, false);

    expect(picture.snapshot().records[0]).toMatchObject({
      freshness: "degraded",
      source_asset_id: "asset-alpha"
    });
  });
});

describe("subscription aggregation", () => {
  const selector = { kind: "resource_type", resource_type: "entity" } as const;

  it("sends one Link transition for duplicate local demand", () => {
    const local = new LocalSubscriptionDemand();
    expect(local.add("client-a", selector)?.action).toBe("add");
    expect(local.add("client-b", selector)).toBeUndefined();
    expect(local.remove("client-a", selector)).toBeUndefined();
    expect(local.remove("client-b", selector)?.action).toBe("remove");
  });

  it("keeps Gateway demand alive for 90 seconds and renews it at the source", () => {
    const gateway = new GatewaySubscriptionDemand();
    expect(gateway.apply("asset-a", { action: "add", selector }, 0)).toBe(true);
    expect(gateway.apply("asset-b", { action: "add", selector }, 1)).toBe(false);
    expect(gateway.aggregate(89_999).size).toBe(1);
    expect(gateway.apply("asset-a", { action: "renew", selector }, 80_000)).toBe(false);
    expect(gateway.expire(91_000)).toEqual([]);
    expect(gateway.expire(171_000)).toEqual([selector]);
  });
});

function context(sequence: number) {
  return {
    source: { role: "asset" as const, id: "asset-alpha" },
    source_generation: 1,
    service_session: "asset-session",
    source_sequence: sequence,
    received_at: sequence === 1 ? 0 : 1_000
  };
}
