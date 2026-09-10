import { expect, it, vi } from "vitest";
import {
  AtlasClient,
  isMovementHistoryBatchRequest,
  isMovementHistoryBatchResponse,
  isMovementHistoryPage,
  isMovementInspection,
  isMovementTrail
} from "../src/index.js";

const time = "2026-09-09T12:00:00Z";
const query = { entityCreatedAt: time, from: time, to: time };
const page = {
  entity_created_at: time,
  from: time,
  to: time,
  retained_from: time,
  snapshot: "1",
  samples: [{ sample_id: "speed-only", time, received_at: time, time_is_arrival: true, speed_m_s: 0 }]
};
const trail = {
  entity_created_at: time,
  from: time,
  to: time,
  retained_from: time,
  points: [],
  position_count: 0,
  simplified: false
};
it("uses authenticated, cancellable history transport without changing live synchronization state", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page));
  const client = new AtlasClient({ baseUrl: "http://atlas.test", apiKey: "fixture-key", fetch: fetchImpl });
  const before = client.sync.snapshot();
  const abort = new AbortController();
  const result = await client.entities.history("asset-1", { ...query, cursor: "opaque+/=", signal: abort.signal });
  expect(result.samples[0]?.speed_m_s).toBe(0);
  expect(result.samples[0]?.latitude).toBeUndefined();
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(new URL(String(url)).searchParams.get("cursor")).toBe("opaque+/=");
  expect(new URL(String(url)).searchParams.get("entity_created_at")).toBe(time);
  expect(new Headers(init?.headers).get("X-API-Key")).toBe("fixture-key");
  expect(init?.signal).toBeDefined();
  expect(client.sync.snapshot()).toEqual(before);
  fetchImpl.mockResolvedValueOnce(Response.json({ inserted: 1, duplicates: 0, expired: 0 }));
  const batch = { entity_created_at: time, samples: [{ sample_id: "backfill", observed_at: time, speed_m_s: 0 }] };
  await client.entities.importMovement("asset-1", batch);
  expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(batch);
  expect(client.sync.snapshot()).toEqual(before);
  abort.abort();
  expect(init?.signal?.aborted).toBe(true);
});
it("rejects malformed history responses and uses dedicated trail and inspection routes", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...page, samples: [{ sample_id: "bad" }] }));
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  await expect(client.entities.history("asset-1", query)).rejects.toThrow();
  fetchImpl.mockResolvedValueOnce(Response.json({ entity_created_at: time, time }));
  await client.entities.inspectMovement("asset-1", time, time);
  expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/movement-history/at?");
  fetchImpl.mockResolvedValueOnce(
    Response.json({
      entity_created_at: time,
      from: time,
      to: time,
      retained_from: time,
      points: [],
      position_count: 0,
      simplified: false
    })
  );
  await client.entities.trail("asset-1", { ...query, maxPoints: 100 });
  expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("/trail?");
  expect(new URL(String(fetchImpl.mock.calls[2]?.[0])).searchParams.get("max_points")).toBe("100");
});

it("exports generated movement predicates at the package root", () => {
  expect(isMovementHistoryPage(page)).toBe(true);
  expect(isMovementTrail(trail)).toBe(true);
  expect(isMovementInspection({ entity_created_at: time, time })).toBe(true);
  expect(isMovementHistoryBatchRequest({ entity_created_at: time, samples: [{ sample_id: "s", speed_m_s: 0 }] })).toBe(
    true
  );
  expect(isMovementHistoryBatchResponse({ inserted: 1, duplicates: 0, expired: 0 })).toBe(true);
});

it.each(["entity_created_at", "from", "to"] as const)("rejects history and trail with mismatched %s", async (field) => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...page, [field]: "2026-09-09T12:00:01Z" }))
    .mockResolvedValueOnce(Response.json({ ...trail, [field]: "2026-09-09T12:00:01Z" }));
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  await expect(client.entities.history("asset-1", query)).rejects.toThrow();
  await expect(client.entities.trail("asset-1", query)).rejects.toThrow();
});

it("compares response instants across offsets without losing association precision", async () => {
  const created = "2026-09-09T12:00:00.123456Z";
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json({
      ...page,
      entity_created_at: "2026-09-09T08:00:00.1234560-04:00",
      from: "2026-09-09T08:00:00-04:00",
      to: "2026-09-09T12:00:00.000Z"
    })
  );
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  await expect(client.entities.history("asset-1", { ...query, entityCreatedAt: created })).resolves.toBeDefined();
  fetchImpl.mockResolvedValueOnce(Response.json({ ...page, entity_created_at: "2026-09-09T12:00:00.123457Z" }));
  await expect(client.entities.history("asset-1", { ...query, entityCreatedAt: created })).rejects.toThrow();
  for (const response of [
    { entity_created_at: created, time: "2026-09-09T12:00:01Z" },
    { entity_created_at: "2026-09-09T12:00:00.123457Z", time }
  ]) {
    fetchImpl.mockResolvedValueOnce(Response.json(response));
    await expect(client.entities.inspectMovement("asset-1", created, time)).rejects.toThrow();
  }
});
