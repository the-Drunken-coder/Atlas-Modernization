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

it("sends only the pagination fields supported by each movement endpoint", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(page))
    .mockResolvedValueOnce(Response.json(trail));
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  const options = { ...query, cursor: "page", limit: 10, maxPoints: 20 };
  await client.entities.history("asset-1", options);
  await client.entities.trail("asset-1", options);
  const historyURL = new URL(String(fetchImpl.mock.calls[0]?.[0]));
  const trailURL = new URL(String(fetchImpl.mock.calls[1]?.[0]));
  expect(historyURL.searchParams.get("limit")).toBe("10");
  expect(historyURL.searchParams.has("max_points")).toBe(false);
  expect(trailURL.searchParams.get("max_points")).toBe("20");
  expect(trailURL.searchParams.has("cursor")).toBe(false);
  expect(trailURL.searchParams.has("limit")).toBe(false);
});
it.each([{}, { latitude: 0 }, { longitude: 0 }, { latitude: 0, speed_m_s: 1 }])(
  "rejects incomplete movement sample %j in requests and responses",
  (quantities) => {
    expect(
      isMovementHistoryBatchRequest({ entity_created_at: time, samples: [{ sample_id: "incomplete", ...quantities }] })
    ).toBe(false);
    expect(
      isMovementHistoryPage({
        ...page,
        samples: [{ sample_id: "incomplete", time, received_at: time, time_is_arrival: true, ...quantities }]
      })
    ).toBe(false);
  }
);

it("matches Core's nanosecond normalization for longer fractions", async () => {
  const long = "2026-09-09T12:00:00.123456789012Z";
  const normalized = "2026-09-09T12:00:00.123456789Z";
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ entity_created_at: normalized, time: normalized }));
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  await expect(client.entities.inspectMovement("asset-1", long, long)).resolves.toBeDefined();
});

it.each([
  { inserted: 0, duplicates: 0, expired: 0 },
  { inserted: 2, duplicates: 0, expired: 0 }
])("rejects incoherent import counts %j", async (response) => {
  const client = new AtlasClient({
    baseUrl: "http://atlas.test",
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))
  });
  await expect(
    client.entities.importMovement("asset-1", {
      entity_created_at: time,
      samples: [{ sample_id: "one", speed_m_s: 1 }]
    })
  ).rejects.toThrow();
});

it("checks sample bounds and descending ordering at nanosecond precision", async () => {
  const from = "2026-09-09T12:00:00.000001Z";
  const to = "2026-09-09T12:00:00.000003Z";
  const middle = "2026-09-09T12:00:00.000002Z";
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  for (const times of [[from, to], ["2026-09-09T12:00:00Z"], ["2026-09-09T12:00:00.000004Z"]]) {
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        ...page,
        from,
        to,
        samples: times.map((time) => ({ ...page.samples[0], time, received_at: time }))
      })
    );
    await expect(client.entities.history("asset-1", { ...query, from, to })).rejects.toThrow();
  }
  fetchImpl.mockResolvedValueOnce(
    Response.json({
      ...page,
      from,
      to,
      samples: [to, middle, middle, from].map((time) => ({ ...page.samples[0], time, received_at: time }))
    })
  );
  await expect(client.entities.history("asset-1", { ...query, from, to })).resolves.toBeDefined();
});

it("matches canonical lowercase and leap-second query timestamps", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ entity_created_at: "2026-01-03T00:00:00Z", time: "2026-01-03T00:00:00Z" }));
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  await expect(
    client.entities.inspectMovement("asset-1", "2026-01-02t23:59:60z", "2026-01-02T23:59:60Z")
  ).resolves.toBeDefined();
});

it.each(["positionless", "outside", "descending", "count"])("rejects incoherent trail %s", async (issue) => {
  const to = "2026-09-09T12:00:01Z";
  const point = (time: string) => ({
    sample: { ...page.samples[0], sample_id: time, time, received_at: time, latitude: 1, longitude: 2 },
    gap_before: false
  });
  const response = { ...trail, to, points: [point(time), point(to)], position_count: 2 };
  if (issue === "positionless")
    Object.assign(response.points[0]!.sample, { latitude: undefined, longitude: undefined });
  if (issue === "outside") response.points = [point("2026-09-09T12:00:02Z"), point(to)];
  if (issue === "descending") response.points.reverse();
  if (issue === "count") response.position_count = 1;
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(response))
    .mockResolvedValueOnce(Response.json({ ...trail, to, points: [point(time), point(to)], position_count: 2 }));
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  await expect(client.entities.trail("asset-1", { ...query, to })).rejects.toThrow();
  await expect(client.entities.trail("asset-1", { ...query, to })).resolves.toBeDefined();
});

it.each([
  { firstGap: true, to: "2026-09-09T12:01:01Z", gap: true, accepted: false },
  { firstGap: false, to: "2026-09-09T12:00:59.999999999Z", gap: true, accepted: false },
  { firstGap: false, to: "2026-09-09T12:01:00Z", gap: true, accepted: false },
  { firstGap: false, to: "2026-09-09T12:01:00.000000001Z", gap: true, accepted: true },
  { firstGap: false, to: "2026-09-09T12:01:01Z", gap: false, accepted: true }
])("validates raw gap claims without inferring gaps from reduction: %j", async ({ firstGap, to, gap, accepted }) => {
  const response = {
    ...trail,
    to,
    position_count: 3,
    simplified: true,
    points: [time, to].map((instant, index) => ({
      sample: {
        ...page.samples[0],
        sample_id: instant,
        time: instant,
        received_at: instant,
        latitude: 1,
        longitude: 2
      },
      gap_before: index === 0 ? firstGap : gap
    }))
  };
  const client = new AtlasClient({
    baseUrl: "http://atlas.test",
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))
  });
  const result = client.entities.trail("asset-1", { ...query, to });
  if (accepted) await expect(result).resolves.toEqual(response);
  else await expect(result).rejects.toThrow();
});

it.each(["position", "speed", "altitude", "future"])("rejects incoherent inspection %s", async (issue) => {
  const future = "2026-09-09T12:00:01Z";
  const response = {
    entity_created_at: time,
    time,
    [issue === "future" ? "position" : issue]:
      issue === "future"
        ? { ...page.samples[0], time: future, received_at: future, latitude: 1, longitude: 2 }
        : issue === "speed"
          ? { sample_id: "altitude", time, received_at: time, time_is_arrival: true, altitude_m: 1 }
          : page.samples[0]
  };
  const client = new AtlasClient({
    baseUrl: "http://atlas.test",
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))
  });
  await expect(client.entities.inspectMovement("asset-1", time, time)).rejects.toThrow();
});

it("rejects a report whose time source contradicts its timestamps", async () => {
  const response = { ...page, samples: [{ ...page.samples[0], observed_at: time }] };
  const client = new AtlasClient({
    baseUrl: "http://atlas.test",
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))
  });
  await expect(client.entities.history("asset-1", query)).rejects.toThrow();
});

it.each(["history", "trail"] as const)("enforces the returned retention cutoff for %s", async (method) => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new AtlasClient({ baseUrl: "http://atlas.test", fetch: fetchImpl });
  const sample = { ...page.samples[0], latitude: 1, longitude: 2 };
  const response =
    method === "history"
      ? { ...page, samples: [sample] }
      : { ...trail, points: [{ sample, gap_before: false }], position_count: 1 };
  fetchImpl.mockResolvedValueOnce(Response.json(response));
  await expect(client.entities[method]("asset-1", query)).resolves.toEqual(response);
  fetchImpl.mockResolvedValueOnce(Response.json({ ...response, retained_from: "2026-09-09T12:00:00.000000001Z" }));
  await expect(client.entities[method]("asset-1", query)).rejects.toThrow();
});

it.each([
  { limit: 1, count: 2, cursor: undefined, accepted: false },
  { limit: undefined, count: 101, cursor: undefined, accepted: false },
  { limit: 2, count: 1, cursor: "next", accepted: false },
  { limit: 1, count: 0, cursor: "next", accepted: false },
  { limit: 1, count: 1, cursor: " ", accepted: false },
  { limit: 1, count: 1, cursor: "next", accepted: true },
  { limit: 2, count: 1, cursor: undefined, accepted: true }
])("checks history page size and continuation: %j", async ({ limit, count, cursor, accepted }) => {
  const response = {
    ...page,
    samples: Array.from({ length: count }, (_, index) => ({ ...page.samples[0], sample_id: String(index) })),
    ...(cursor === undefined ? {} : { next_cursor: cursor })
  };
  const client = new AtlasClient({
    baseUrl: "http://atlas.test",
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))
  });
  const result = client.entities.history("asset-1", { ...query, ...(limit === undefined ? {} : { limit }) });
  if (accepted) await expect(result).resolves.toEqual(response);
  else await expect(result).rejects.toThrow();
});
