import { describe, expect, it } from "vitest";
import {
  isStateDeltaPayload,
  STATE_DELTA_BASELINE_INTERVAL_MS,
  StateDeltaDecoder,
  StateDeltaEncoder,
  type StateDeltaIdentity
} from "./state-delta.js";
import { positionPublication } from "./test-fixtures.js";
import type { ResourceStatePublication } from "./types.js";

const identity = (sourceSequence: number): StateDeltaIdentity => ({
  source: { role: "asset", id: "asset-alpha" },
  source_generation: 3,
  service_session: "session-alpha",
  source_sequence: sourceSequence
});

const entityPublication = (entityID: string, version: number): ResourceStatePublication => {
  const publication = positionPublication(version);
  return { ...publication, resource: { ...publication.resource, entity_id: entityID } };
};

describe("state delta codec", () => {
  it("returns normal full bytes and a delta against the last committed full", () => {
    const encoder = new StateDeltaEncoder();
    const decoder = new StateDeltaDecoder();
    const firstPublication = positionPublication(1);
    const secondPublication = positionPublication(2);
    const first = encoder.prepare(firstPublication, identity(1), 0);
    expect(first.deltaPayload).toBeUndefined();
    expect(isStateDeltaPayload(first.fullPayload)).toBe(false);

    const uncommitted = encoder.prepare(secondPublication, identity(2), 1);
    expect(uncommitted.deltaPayload).toBeUndefined();
    first.commitFull();
    const second = encoder.prepare(secondPublication, identity(2), 1);
    expect(second.deltaPayload).toBeDefined();
    expect(second.baselineSourceSequence).toBe(1);
    expect(second.deltaPayload!.byteLength).toBeLessThan(second.fullPayload.byteLength);
    second.commitFull();
    const third = encoder.prepare(positionPublication(3), identity(3), 2);
    expect(third.baselineSourceSequence).toBe(2);
    expect(decoder.decode(first.fullPayload, identity(1))).toEqual(firstPublication);
    expect(decoder.decode(second.deltaPayload!, identity(2))).toEqual(secondPublication);
  });

  it("freezes the full baseline while its outbound frame is queued", () => {
    const encoder = new StateDeltaEncoder();
    const decoder = new StateDeltaDecoder();
    const first = positionPublication(1);
    const prepared = encoder.prepare(first, identity(1), 0);
    first.resource.extra = { queued: true };
    prepared.commitFull();

    const second = encoder.prepare(positionPublication(2), identity(2), 1);
    expect(second.deltaPayload).toBeDefined();
    expect(decoder.decode(prepared.fullPayload, identity(1))).toEqual(positionPublication(1));
    expect(decoder.decode(second.deltaPayload!, identity(2))).toEqual(positionPublication(2));
  });

  it("repeats full bytes at the bounded recovery interval", () => {
    const encoder = new StateDeltaEncoder();
    const first = encoder.prepare(positionPublication(1), identity(1), 0);
    first.commitFull();

    expect(
      encoder.prepare(positionPublication(2), identity(2), STATE_DELTA_BASELINE_INTERVAL_MS - 1).deltaPayload
    ).toBeDefined();
    expect(
      encoder.prepare(positionPublication(3), identity(3), STATE_DELTA_BASELINE_INTERVAL_MS).deltaPayload
    ).toBeUndefined();
  });

  it("exposes the full fallback when a patch costs at least as much", () => {
    const encoder = new StateDeltaEncoder();
    const fields = Object.fromEntries(Array.from({ length: 160 }, (_, index) => [`field-${index}`, "x".repeat(30)]));
    const first: Extract<ResourceStatePublication, { resource_type: "entity" }> = {
      ...positionPublication(1),
      resource: { ...positionPublication(1).resource, extra: fields }
    };
    const second: Extract<ResourceStatePublication, { resource_type: "entity" }> = {
      ...positionPublication(2),
      resource: {
        ...positionPublication(2).resource,
        extra: Object.fromEntries(Array.from({ length: 160 }, (_, index) => [`field-${index}`, "y".repeat(30)]))
      }
    };
    const baseline = encoder.prepare(first, identity(1), 0);
    baseline.commitFull();
    const prepared = encoder.prepare(second, identity(2), 1);

    expect(prepared.deltaPayload).toBeDefined();
    expect(prepared.deltaPayload!.byteLength).toBeGreaterThanOrEqual(prepared.fullPayload.byteLength);
  });

  it("fails closed when the full baseline is missing after restart", () => {
    const encoder = new StateDeltaEncoder();
    const first = encoder.prepare(positionPublication(1), identity(1), 0);
    first.commitFull();
    const delta = encoder.prepare(positionPublication(2), identity(2), 1);

    expect(delta.deltaPayload).toBeDefined();
    expect(new StateDeltaDecoder().decode(delta.deltaPayload!, identity(2))).toBeUndefined();
  });

  it("keeps out-of-order full baselines scoped by source and resource", () => {
    const encoder = new StateDeltaEncoder();
    const decoder = new StateDeltaDecoder();
    const firstPublication = positionPublication(1);
    const secondPublication = positionPublication(2);
    const thirdPublication = positionPublication(3);
    const first = encoder.prepare(firstPublication, identity(1), 0);
    first.commitFull();
    const second = encoder.prepare(secondPublication, identity(2), STATE_DELTA_BASELINE_INTERVAL_MS);
    expect(second.deltaPayload).toBeUndefined();
    second.commitFull();
    const third = encoder.prepare(thirdPublication, identity(3), STATE_DELTA_BASELINE_INTERVAL_MS + 1);
    expect(third.deltaPayload).toBeDefined();

    expect(decoder.decode(second.fullPayload, identity(2))).toEqual(secondPublication);
    expect(decoder.decode(first.fullPayload, identity(1))).toEqual(firstPublication);
    expect(decoder.decode(third.deltaPayload!, identity(3))).toEqual(thirdPublication);
    expect(decoder.decode(first.fullPayload, identity(1))).toEqual(firstPublication);
  });

  it("retains the previous baseline and evicts whole resource scopes", () => {
    const firstEncoder = new StateDeltaEncoder();
    const first = firstEncoder.prepare(positionPublication(1), identity(1), 0);
    first.commitFull();
    const deltaAgainstFirst = firstEncoder.prepare(positionPublication(2), identity(2), 1);
    expect(deltaAgainstFirst.deltaPayload).toBeDefined();
    const unrelated = new StateDeltaEncoder().prepare(entityPublication("asset-bravo", 1), identity(3), 0);
    const decoder = new StateDeltaDecoder({ maxResources: 1 });
    expect(decoder.decode(first.fullPayload, identity(1))).toBeDefined();
    expect(decoder.decode(deltaAgainstFirst.fullPayload, identity(2))).toBeDefined();
    expect(decoder.decode(deltaAgainstFirst.deltaPayload!, identity(2))).toEqual(positionPublication(2));
    expect(decoder.decode(unrelated.fullPayload, identity(3))).toBeDefined();
    expect(decoder.decode(deltaAgainstFirst.deltaPayload!, identity(2))).toBeUndefined();
  });

  it("keeps a target resource through repeated full updates to another resource", () => {
    const targetEncoder = new StateDeltaEncoder();
    const target = targetEncoder.prepare(positionPublication(1), identity(1), 0);
    target.commitFull();
    const targetDelta = targetEncoder.prepare(positionPublication(2), identity(2), 1);
    const decoder = new StateDeltaDecoder();
    expect(decoder.decode(target.fullPayload, identity(1))).toBeDefined();

    for (let sequence = 2; sequence <= 65; sequence++) {
      const other = new StateDeltaEncoder().prepare(
        entityPublication("asset-bravo", ((sequence - 2) % 50) + 1),
        identity(sequence),
        0
      );
      expect(decoder.decode(other.fullPayload, identity(sequence))).toBeDefined();
    }
    expect(decoder.decode(targetDelta.deltaPayload!, identity(2))).toEqual(positionPublication(2));
  });

  it("does not let a late old full refresh scope recency or displace the current base", () => {
    const encoder = new StateDeltaEncoder();
    const first = encoder.prepare(positionPublication(1), identity(1), 0);
    first.commitFull();
    const second = encoder.prepare(positionPublication(2), identity(2), 1);
    expect(second.deltaPayload).toBeDefined();
    second.commitFull();
    const third = encoder.prepare(positionPublication(3), identity(3), 2);
    expect(third.deltaPayload).toBeDefined();

    const decoder = new StateDeltaDecoder({ maxResources: 2 });
    expect(decoder.decode(first.fullPayload, identity(1))).toBeDefined();
    expect(decoder.decode(second.fullPayload, identity(2))).toBeDefined();
    const other = new StateDeltaEncoder().prepare(entityPublication("asset-bravo", 1), identity(4), 0);
    expect(decoder.decode(other.fullPayload, identity(4))).toBeDefined();
    expect(decoder.decode(first.fullPayload, identity(1))).toBeDefined();
    const another = new StateDeltaEncoder().prepare(entityPublication("asset-charlie", 1), identity(5), 0);
    expect(decoder.decode(another.fullPayload, identity(5))).toBeDefined();
    expect(decoder.decode(third.deltaPayload!, identity(3))).toBeUndefined();
  });

  it("accepts an old baseline that arrives after the current full", () => {
    const encoder = new StateDeltaEncoder();
    const first = encoder.prepare(positionPublication(1), identity(1), 0);
    first.commitFull();
    const deltaAgainstFirst = encoder.prepare(positionPublication(2), identity(2), 1);
    expect(deltaAgainstFirst.deltaPayload).toBeDefined();

    const decoder = new StateDeltaDecoder();
    expect(decoder.decode(deltaAgainstFirst.fullPayload, identity(2))).toEqual(positionPublication(2));
    expect(decoder.decode(first.fullPayload, identity(1))).toEqual(positionPublication(1));
    expect(decoder.decode(deltaAgainstFirst.deltaPayload!, identity(2))).toEqual(positionPublication(2));
  });

  it("applies patches through own properties for prototype-shaped keys", () => {
    const encoder = new StateDeltaEncoder();
    const decoder = new StateDeltaDecoder();
    const first: Extract<ResourceStatePublication, { resource_type: "entity" }> = {
      ...positionPublication(1),
      resource: { ...positionPublication(1).resource, extra: {} }
    };
    const second: Extract<ResourceStatePublication, { resource_type: "entity" }> = {
      ...positionPublication(2),
      resource: {
        ...positionPublication(2).resource,
        extra: JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}')
      }
    };
    const baseline = encoder.prepare(first, identity(1), 0);
    baseline.commitFull();
    const delta = encoder.prepare(second, identity(2), 1);
    expect(delta.deltaPayload).toBeDefined();
    expect(decoder.decode(baseline.fullPayload, identity(1))).toEqual(first);
    const result = decoder.decode(delta.deltaPayload!, identity(2));
    expect(result).toEqual(second);
    if (!result || result.deleted === true || result.resource_type !== "entity")
      throw new Error("expected entity state");
    const extra = result.resource.extra;
    if (extra === undefined || extra === null || typeof extra !== "object") throw new Error("expected extra object");
    expect(Object.hasOwn(extra, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(extra)).toBe(Object.prototype);
  });

  it("decodes and remembers normal canonical full state payloads", () => {
    const publication = positionPublication(1);
    const decoder = new StateDeltaDecoder();
    expect(decoder.decode(new TextEncoder().encode('{"not":"a link message"}'), identity(1))).toBeUndefined();
    expect(
      decoder.decode(new StateDeltaEncoder().prepare(publication, identity(1), 0).fullPayload, identity(1))
    ).toEqual(publication);
  });

  it("bounds full input and reconstructed state size", () => {
    const oversized: Extract<ResourceStatePublication, { resource_type: "entity" }> = {
      ...positionPublication(1),
      resource: {
        ...positionPublication(1).resource,
        extra: { payload: "x".repeat(140_000) }
      }
    };
    expect(() => new StateDeltaEncoder().prepare(oversized, identity(1), 0)).toThrow("exceeds 128 KiB");
  });
});

it("retains full publications when a resource identity cannot be represented as UTF-8", () => {
  const encoder = new StateDeltaEncoder();
  const first = positionPublication(1);
  first.resource.entity_id = "asset-\ud800";
  const second = positionPublication(2);
  second.resource.entity_id = first.resource.entity_id;
  encoder.prepare(first, identity(1), 0).commitFull();
  const next = encoder.prepare(second, identity(2), 1);
  expect(next.deltaPayload).toBeUndefined();
  expect(new StateDeltaDecoder().decode(next.fullPayload, identity(2))).toEqual(second);
});
