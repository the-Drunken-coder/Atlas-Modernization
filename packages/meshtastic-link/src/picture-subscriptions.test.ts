import { describe, expect, it, vi } from "vitest";
import { SharedPicture } from "./picture.js";
import { GatewaySubscriptionDemand, LocalSubscriptionDemand } from "./subscriptions.js";
import { positionPublication } from "./test-fixtures.js";
import type { ResourceStatePublication } from "./types.js";

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
    picture.refresh(31_001);
    expect(picture.snapshot().records).toHaveLength(0);
  });

  it("accepts reordered sequences when they update different records", () => {
    const picture = new SharedPicture("picture-session");
    const alpha = positionPublication(1);
    const bravo = positionPublication(1);
    bravo.resource = { ...bravo.resource, alias: "Bravo", entity_id: "asset-bravo" };
    expect(picture.apply(alpha, context(2))).toEqual({ status: "applied" });
    expect(picture.apply(bravo, context(1))).toEqual({ status: "applied" });
    expect(picture.snapshot().records.map((record) => record.id)).toEqual(["asset-alpha", "asset-bravo"]);
  });

  it("retains a source sequence fence after another source replaces the record", () => {
    const picture = new SharedPicture("picture-session");
    const field = positionPublication(1);
    const confirmed = { ...positionPublication(2), path: "gateway_feed", confirmation: "core_confirmed" } as const;
    const delayed = structuredClone(positionPublication(3));
    delayed.operation_id = "delayed-field";
    delayed.observation_time = "2026-09-02T12:00:10Z";

    expect(picture.apply(field, context(10))).toEqual({ status: "applied" });
    expect(
      picture.apply(confirmed, {
        source: { role: "gateway", id: "gateway" },
        source_generation: 1,
        service_session: "gateway-session",
        source_sequence: 1,
        received_at: 1_000
      })
    ).toEqual({ status: "applied" });
    expect(picture.apply(delayed, context(9))).toEqual({ status: "rejected", reason: "stale_sequence" });
    expect(picture.snapshot().records[0]).toMatchObject({
      atlas_version: 2,
      source: { role: "gateway", id: "gateway" }
    });
  });

  it("retains a source sequence fence after an expiring record leaves the picture", () => {
    const picture = new SharedPicture("picture-session");
    expect(picture.apply(positionPublication(2), context(10))).toEqual({ status: "applied" });
    picture.refresh(31_001);
    expect(picture.snapshot().records).toEqual([]);

    expect(picture.apply(positionPublication(1), { ...context(9), received_at: 31_000 })).toEqual({
      status: "rejected",
      reason: "stale_sequence"
    });
    expect(picture.snapshot().records).toEqual([]);
  });

  it("expires source sequence fences after the bounded replay window", () => {
    const picture = new SharedPicture("picture-session");
    expect(picture.apply(positionPublication(2), context(10))).toEqual({ status: "applied" });
    picture.refresh(10 * 60_000 + 1_000);

    expect(picture.apply(positionPublication(1), { ...context(9), received_at: 10 * 60_000 + 1_000 })).toEqual({
      status: "applied"
    });
  });

  it("bounds retained picture entries after replay fences expire", () => {
    const picture = new SharedPicture("picture-session");
    for (let index = 0; index < 4_096; index++) {
      expect(picture.apply(objectPublication(index), { ...context(index + 1), received_at: index })).toEqual({
        status: "applied"
      });
    }
    picture.refresh(10 * 60_000 + 5_000);
    expect(picture.apply(objectPublication(4_096), { ...context(4_097), received_at: 10 * 60_000 + 5_000 })).toEqual({
      status: "rejected",
      reason: "capacity"
    });
  });

  it("bounds retained picture bytes", () => {
    const picture = new SharedPicture("picture-session");
    const largeHint = "x".repeat(100_000);
    let result = picture.apply(objectPublication(0, largeHint), context(1));
    for (let index = 1; index < 200 && result.status === "applied"; index++) {
      result = picture.apply(objectPublication(index, largeHint), context(index + 1));
    }
    expect(result).toEqual({ status: "rejected", reason: "capacity" });
  });

  it("bounds remembered source identities", () => {
    const picture = new SharedPicture("picture-session");
    for (let index = 0; index < 4_096; index++) {
      expect(picture.activateSource({ role: "asset", id: `asset-${index}` }, 1, `session-${index}`)).toBe(true);
    }
    expect(picture.activateSource({ role: "asset", id: "asset-overflow" }, 1, "overflow-session")).toBe(false);
  });

  it("bounds subscriber registrations", () => {
    const picture = new SharedPicture("picture-session");
    const subscriptions = Array.from({ length: 1_024 }, () => picture.subscribe(() => undefined));
    expect(() => picture.subscribe(() => undefined)).toThrowError("picture subscriber capacity exhausted");
    subscriptions[0]?.();
    expect(() => picture.subscribe(() => undefined)).not.toThrow();
  });

  it("applies an explicit deletion at its changed-since feed version", () => {
    const picture = new SharedPicture("picture-session");
    const deletion = {
      type: "state",
      resource_type: "entity",
      resource_id: "asset-alpha",
      deleted: true,
      atlas_version: 2,
      observation_time: "2026-09-02T12:00:02Z",
      path: "gateway_feed",
      confirmation: "core_confirmed"
    } as const;
    expect(picture.apply(positionPublication(1), context(1))).toEqual({ status: "applied" });
    expect(picture.apply(deletion, context(2))).toEqual({ status: "applied" });
    expect(picture.snapshot().records).toEqual([]);
  });

  it("keeps a versioned deletion fence when the record was absent", () => {
    const picture = new SharedPicture("picture-session");
    const deletion = {
      type: "state",
      resource_type: "entity",
      resource_id: "asset-alpha",
      deleted: true,
      atlas_version: 2,
      observation_time: "2026-09-02T12:00:02Z",
      path: "gateway_feed",
      confirmation: "core_confirmed"
    } as const;
    expect(picture.apply(deletion, context(2))).toEqual({ status: "applied" });
    expect(picture.apply(positionPublication(1), context(3))).toEqual({
      status: "rejected",
      reason: "stale_record"
    });
    expect(picture.snapshot().records).toEqual([]);
  });

  it("lets authoritative Core state reverse an equal-version provisional deletion", () => {
    const picture = new SharedPicture("picture-session");
    const confirmed = {
      ...positionPublication(2),
      path: "gateway_feed",
      confirmation: "core_confirmed"
    } as const;
    const provisionalDeletion = {
      type: "state",
      resource_type: "entity",
      resource_id: "asset-alpha",
      deleted: true,
      atlas_version: 2,
      observation_time: "2026-09-02T12:00:03Z",
      path: "field",
      confirmation: "awaiting_core"
    } as const;
    const restored = { ...confirmed, confirmation: "core_rejected" } as const;

    expect(
      picture.apply(confirmed, {
        source: { role: "gateway", id: "gateway" },
        source_generation: 1,
        service_session: "gateway-session",
        source_sequence: 1,
        received_at: 0
      })
    ).toEqual({ status: "applied" });
    expect(picture.apply(provisionalDeletion, context(1))).toEqual({ status: "applied" });
    expect(picture.snapshot().records).toEqual([]);
    expect(
      picture.apply(restored, {
        source: { role: "gateway", id: "gateway" },
        source_generation: 1,
        service_session: "gateway-session",
        source_sequence: 2,
        received_at: 2_000
      })
    ).toEqual({ status: "applied" });
    expect(picture.snapshot().records[0]).toMatchObject({
      id: "asset-alpha",
      confirmation: "core_rejected",
      atlas_version: 2
    });
  });

  it("lets equal-version Core state replace provisional field state", () => {
    const picture = new SharedPicture("picture-session");
    const provisional = positionPublication(1);
    const confirmed = { ...provisional, path: "gateway_feed", confirmation: "core_confirmed" } as const;
    expect(picture.apply(provisional, context(1))).toEqual({ status: "applied" });
    expect(
      picture.apply(confirmed, {
        source: { role: "gateway", id: "gateway" },
        source_generation: 1,
        service_session: "gateway-session",
        source_sequence: 1,
        received_at: 2_000
      })
    ).toEqual({ status: "applied" });
    expect(picture.snapshot().records[0]).toMatchObject({
      source: { role: "gateway", id: "gateway" },
      confirmation: "core_confirmed"
    });
  });

  it("lets authoritative Core rejection replace a newer provisional Task timestamp", () => {
    const picture = new SharedPicture("picture-session");
    const provisional = {
      type: "state",
      resource_type: "task",
      resource: {
        asset_id: "asset-alpha",
        acknowledged_at: "2026-09-02T12:01:00Z",
        command: "atlas.survey",
        created_at: "2026-09-02T12:00:00Z",
        input: {},
        started_at: "2026-09-02T12:02:00Z",
        status: "in_progress",
        task_id: "task-1",
        updated_at: "2026-09-02T12:10:00Z"
      },
      observation_time: "2026-09-02T12:10:00Z",
      path: "field",
      confirmation: "awaiting_core",
      operation_id: "progress-1"
    } as const;
    const rejected = {
      ...provisional,
      resource: {
        asset_id: "asset-alpha",
        command: "atlas.survey",
        created_at: "2026-09-02T12:00:00Z",
        input: {},
        status: "pending",
        task_id: "task-1",
        updated_at: "2026-09-02T12:05:00Z"
      },
      observation_time: "2026-09-02T12:05:00Z",
      path: "gateway_feed",
      confirmation: "core_rejected"
    } as const;

    expect(picture.apply(provisional, context(1))).toEqual({ status: "applied" });
    expect(
      picture.apply(rejected, {
        source: { role: "gateway", id: "gateway" },
        source_generation: 1,
        service_session: "gateway-session",
        source_sequence: 1,
        received_at: 1_000
      })
    ).toEqual({ status: "applied" });
    expect(picture.snapshot().records[0]).toMatchObject({
      confirmation: "core_rejected",
      state: { status: "pending", updated_at: "2026-09-02T12:05:00Z" }
    });
  });

  it("applies a later Task transition when its source timestamp is unchanged", () => {
    const picture = new SharedPicture("picture-session");
    const pending = {
      type: "state",
      resource_type: "task",
      resource: {
        asset_id: "asset-alpha",
        command: "atlas.survey",
        created_at: "2026-09-02T12:00:00Z",
        input: {},
        status: "pending",
        task_id: "task-equal-time",
        updated_at: "2026-09-02T12:00:00Z"
      },
      observation_time: "2026-09-02T12:00:00Z",
      path: "gateway_feed",
      confirmation: "core_confirmed"
    } as const;
    const acknowledged = {
      ...pending,
      resource: {
        ...pending.resource,
        acknowledged_at: "2026-09-02T12:00:00Z",
        status: "acknowledged"
      }
    } as const;
    const gatewayContext = {
      source: { role: "gateway", id: "gateway" } as const,
      source_generation: 1,
      service_session: "gateway-session",
      source_sequence: 1,
      received_at: 0
    };

    expect(picture.apply(pending, gatewayContext)).toEqual({ status: "applied" });
    expect(picture.apply(acknowledged, { ...gatewayContext, source_sequence: 2 })).toEqual({ status: "applied" });
    expect(picture.snapshot().records[0]?.state).toMatchObject({ status: "acknowledged" });
  });

  it("accepts a later field observation without a new Core version", () => {
    const picture = new SharedPicture("picture-session");
    const first = positionPublication(1);
    const second = structuredClone(first);
    second.operation_id = "position-later";
    second.observation_time = "2026-09-02T12:00:02Z";
    const geometry = second.resource.components.geometry;
    if (!geometry || geometry.type !== "Point") throw new Error("position fixture must contain point geometry");
    geometry.coordinates = [-71.8, 42.2, 150];

    expect(picture.apply(first, context(1))).toEqual({ status: "applied" });
    expect(picture.apply(second, context(2))).toEqual({ status: "applied" });
    expect(picture.snapshot().records[0]?.state).toMatchObject({
      components: { geometry: { coordinates: [-71.8, 42.2, 150] } }
    });
  });

  it("accepts a later field observation after a Core snapshot at the same version", () => {
    const picture = new SharedPicture("picture-session");
    const confirmed = {
      ...positionPublication(1),
      path: "gateway_feed",
      confirmation: "core_confirmed"
    } as const;
    const later = positionPublication(1);
    later.observation_time = "2026-09-02T12:00:02Z";
    const geometry = later.resource.components.geometry;
    if (!geometry || geometry.type !== "Point") throw new Error("position fixture must contain point geometry");
    geometry.coordinates = [-71.8, 42.2, 151];

    expect(
      picture.apply(confirmed, {
        source: { role: "gateway", id: "gateway" },
        source_generation: 1,
        service_session: "gateway-session",
        source_sequence: 1,
        received_at: 0
      })
    ).toEqual({ status: "applied" });
    expect(picture.apply(later, context(2))).toEqual({ status: "applied" });
    expect(picture.snapshot().records[0]).toMatchObject({
      source: { role: "asset", id: "asset-alpha" },
      confirmation: "awaiting_core",
      state: { components: { geometry: { coordinates: [-71.8, 42.2, 151] } } }
    });
  });

  it("refreshes equal state from a newer source generation", () => {
    const picture = new SharedPicture("picture-session");
    const publication = positionPublication(1);
    expect(picture.apply(publication, context(1))).toEqual({ status: "applied" });
    expect(picture.activateSource({ role: "asset", id: "asset-alpha" }, 2, "asset-session-2")).toBe(true);
    expect(
      picture.apply(publication, {
        source: { role: "asset", id: "asset-alpha" },
        source_generation: 2,
        service_session: "asset-session-2",
        source_sequence: 1,
        received_at: 6_000
      })
    ).toEqual({ status: "applied" });
    expect(picture.snapshot().records[0]).toMatchObject({
      source_generation: 2,
      service_session: "asset-session-2",
      received_at: 6_000,
      freshness: "fresh"
    });
  });

  it("isolates throwing subscribers and serializes reentrant events", () => {
    const picture = new SharedPicture("picture-session");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let throwingCalls = 0;
    const observed: number[] = [];
    picture.subscribe(() => {
      throwingCalls++;
      throw new Error("subscriber failed");
    });
    picture.subscribe((event) => {
      if (event.revision === 1) picture.apply(positionPublication(2), context(2));
    });
    picture.subscribe((event) => observed.push(event.revision));

    try {
      expect(picture.apply(positionPublication(1), context(1))).toEqual({ status: "applied" });
      expect(throwingCalls).toBe(1);
      expect(observed).toEqual([1, 2]);
      expect(consoleError).toHaveBeenCalledWith(
        "Shared Picture subscriber failed; removing subscriber",
        expect.any(Error)
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("retains mixed position and telemetry records for the telemetry interval", () => {
    const picture = new SharedPicture("picture-session");
    const mixed = positionPublication(1);
    mixed.resource.components.telemetry = { speed_m_s: 4 };
    picture.apply(mixed, context(1));

    picture.refresh(30_001);
    expect(picture.snapshot().records[0]?.freshness).toBe("stale");
    picture.refresh(120_001);
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

  it("degrades an active Task when its Asset state becomes stale", () => {
    const picture = new SharedPicture("picture-session");
    picture.apply(positionPublication(1), context(1));
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

    picture.refresh(5_001);

    expect(picture.snapshot().records.find((record) => record.resource_type === "task")).toMatchObject({
      freshness: "degraded",
      source_asset_id: "asset-alpha"
    });

    picture.apply(positionPublication(2), { ...context(2), received_at: 6_000 });
    expect(picture.snapshot().records.find((record) => record.resource_type === "task")).toMatchObject({
      freshness: "fresh",
      source_asset_id: "asset-alpha"
    });
  });

  it("degrades an active Task when its Asset is deleted", () => {
    const picture = new SharedPicture("picture-session");
    picture.apply(positionPublication(1), context(1));
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
    expect(
      picture.apply(
        {
          type: "state",
          resource_type: "entity",
          resource_id: "asset-alpha",
          deleted: true,
          atlas_version: 2,
          observation_time: "2026-09-02T12:00:02Z",
          path: "gateway_feed",
          confirmation: "core_confirmed"
        },
        {
          source: { role: "gateway", id: "gateway" },
          source_generation: 1,
          service_session: "gateway-session",
          source_sequence: 2,
          received_at: 2_000
        }
      )
    ).toEqual({ status: "applied" });
    expect(picture.snapshot().records.find((record) => record.resource_type === "task")).toMatchObject({
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

function objectPublication(
  index: number,
  usageHint = "map"
): Extract<ResourceStatePublication, { resource_type: "object" }> {
  const timestamp = "2026-09-02T12:00:00Z";
  return {
    type: "state",
    resource_type: "object",
    resource: {
      bucket: null,
      content_type: null,
      metadata: { created_at: timestamp, updated_at: timestamp, version: index + 1 },
      object_id: `object-${index}`,
      path: null,
      size_bytes: 0,
      type: "test",
      usage_hints: [usageHint]
    },
    observation_time: timestamp,
    path: "field",
    confirmation: "awaiting_core",
    operation_id: `object-${index}`
  };
}
