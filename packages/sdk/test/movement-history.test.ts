import { expect, it, vi } from "vitest";
import { AtlasClient } from "../src/index.js";

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
