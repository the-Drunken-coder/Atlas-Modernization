import { readFile } from "node:fs/promises";
import {
  SourceGatewayError,
  type SourceGatewayRequest,
  type SourceGatewayResponse
} from "@the-drunken-coder/atlas-plugin-runtime";
import { describe, expect, it } from "vitest";
import { buildResult, createBuildingSearchOperation, overpassQuery, responseBudgetBytes } from "../src/operation.js";

const area = { west: -71.01, south: 42, east: -71, north: 42.01 };
const retrievedAt = new Date("2026-08-30T12:00:00Z");

describe("Building Scan", () => {
  it("builds the bounded query without clipping output geometry", () => {
    const query = overpassQuery(area);
    expect(query).toContain('way["building"](42,-71.01,42.01,-71)');
    expect(query).toContain('relation["building"](42,-71.01,42.01,-71)');
    expect(query).toContain("[timeout:9]");
    expect(query).toContain("out meta geom 501");
  });

  it("returns an attributed empty result", async () => {
    const result = buildResult(await fixture("empty.json"), retrievedAt);
    expect(result).toEqual({
      features: [],
      provenance: {
        connector_id: "building_scan",
        source: "OpenStreetMap through an Overpass-compatible endpoint"
      },
      attribution: {
        text: "Map data from OpenStreetMap",
        url: "https://www.openstreetmap.org/copyright"
      },
      retrieved_at: "2026-08-30T12:00:00.000Z",
      truncation: null
    });
  });

  it("parses closed ways, holes, multiple outers, labels, missing optional tags, and duplicate elements deterministically", async () => {
    const payload = await fixture("buildings.json");
    const first = buildResult(payload, retrievedAt);
    const second = buildResult(payload, retrievedAt);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.features.map(({ id }) => id)).toEqual(["way/10", "way/20", "relation/30"]);
    expect(first.features[0]).toMatchObject({
      title: "Atlas Hall",
      fields: [
        { label: "Address", value: "100 Main Street" },
        { label: "OSM version", value: "7" },
        { label: "Last edited", value: "2026-08-29T16:42:10Z" },
        { label: "Changeset", value: "123456789" },
        { label: "Contributor", value: "Atlas Mapper" },
        { label: "Contributor ID", value: "42" },
        { label: "addr:housenumber", value: "100" },
        { label: "addr:street", value: "Main Street" },
        { label: "building", value: "office_building" },
        { label: "building:levels", value: "4" },
        { label: "height", value: "12 m" },
        { label: "name", value: "Atlas Hall" },
        { label: "operator", value: "Atlas" },
        { label: "roof:shape", value: "flat" },
        { label: "start_date", value: "1984" }
      ],
      geometry: { type: "Polygon" }
    });
    expect(first.features[1]).toMatchObject({
      title: "Building way/20",
      fields: [{ label: "building", value: "yes" }]
    });
    expect(first.features[2].geometry).toMatchObject({ type: "MultiPolygon" });
    if (first.features[2].geometry.type !== "MultiPolygon") throw new Error("expected MultiPolygon");
    expect(first.features[2].geometry.coordinates).toHaveLength(2);
    expect(first.features[2].geometry.coordinates.some((polygon) => polygon.length === 2)).toBe(true);
  });

  it("fails closed on malformed geometry and conflicting duplicates", async () => {
    const malformed = await fixture("malformed-geometry.json");
    const operation = createBuildingSearchOperation(
      { request: async () => response(200, malformed) },
      () => retrievedAt
    );
    await expect(operation.handler(area, new AbortController().signal)).rejects.toMatchObject({
      pluginCode: "malformed_source_response"
    });
    expect(() => buildResult({ elements: [{ ...squareElement(2), version: "invalid" }] }, retrievedAt)).toThrow();
    const duplicate = squareElement(1);
    expect(() =>
      buildResult(
        {
          elements: [duplicate, { ...duplicate, tags: { building: "school" } }]
        },
        retrievedAt
      )
    ).toThrow();
  });

  it("rejects source elements without tags", async () => {
    const operation = createBuildingSearchOperation({
      request: async () => response(200, { elements: [{ ...squareElement(1), tags: undefined }] })
    });
    await expect(operation.handler(area, new AbortController().signal)).rejects.toMatchObject({
      pluginCode: "malformed_source_response"
    });
  });

  it("reports feature-limit truncation after 501 candidates", () => {
    const result = buildResult(
      { elements: Array.from({ length: 501 }, (_, index) => squareElement(index + 1)) },
      retrievedAt
    );
    expect(result.features).toHaveLength(500);
    expect(result.truncation).toEqual({ reason: "feature_limit" });
  });

  it("stays below the response budget and reports budget truncation", () => {
    const result = buildResult(
      {
        elements: [
          {
            ...squareElement(1),
            tags: { building: "yes", name: "x".repeat(responseBudgetBytes) }
          }
        ]
      },
      retrievedAt
    );
    expect(result.features).toEqual([]);
    expect(result.truncation).toEqual({ reason: "response_budget" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(responseBudgetBytes);
  });

  it.each([
    [429, "source_busy"],
    [500, "source_unavailable"],
    [400, "source_rejected"]
  ])("maps source status %i to %s", async (status, pluginCode) => {
    const operation = createBuildingSearchOperation({ request: async () => response(status, {}) }, () => retrievedAt);
    await expect(operation.handler(area, new AbortController().signal)).rejects.toMatchObject({ pluginCode });
  });

  it.each([
    ["upstream_timeout", "source_timeout"],
    ["response_too_large", "source_response_too_large"],
    ["circuit_open", "source_busy"],
    ["upstream_unreachable", "source_unavailable"],
    ["request_rejected", "source_configuration_error"],
    ["unknown_connector", "source_configuration_error"]
  ] as const)("maps gateway failure %s to %s", async (failureCode, pluginCode) => {
    const operation = createBuildingSearchOperation({
      request: async () => {
        throw new SourceGatewayError(failureCode);
      }
    });
    await expect(operation.handler(area, new AbortController().signal)).rejects.toMatchObject({ pluginCode });
  });

  it("maps malformed JSON and preserves cancellation", async () => {
    const malformed = createBuildingSearchOperation({ request: async () => response(200, "{not json") });
    await expect(malformed.handler(area, new AbortController().signal)).rejects.toMatchObject({
      pluginCode: "malformed_source_response"
    });

    const controller = new AbortController();
    const operation = createBuildingSearchOperation({
      request: async (_connectorId, _request, options) => {
        await new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason))
        );
        throw new Error("unreachable");
      }
    });
    const pending = operation.handler(area, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("rejects an HTTP 200 timeout remark without publishing recorded partial elements", async () => {
    const payload = await fixture("remark-timeout.json");
    const operation = createBuildingSearchOperation({ request: async () => response(200, payload) });
    await expect(operation.handler(area, new AbortController().signal)).rejects.toMatchObject({
      pluginCode: "source_timeout"
    });
  });

  it.each([
    ["runtime error: The dispatcher is busy and no slots are available.", "source_busy"],
    ["runtime error: Backend database unavailable.", "source_unavailable"]
  ])("maps HTTP 200 Overpass remark failures", async (remark, pluginCode) => {
    const operation = createBuildingSearchOperation({
      request: async () => response(200, { remark, elements: [squareElement(1)] })
    });
    await expect(operation.handler(area, new AbortController().signal)).rejects.toMatchObject({ pluginCode });
  });

  it("uses the configured connector, identifying header, and encoded query", async () => {
    const requests: Array<{ connectorId: string; request: SourceGatewayRequest; signal: AbortSignal | undefined }> = [];
    const operation = createBuildingSearchOperation(
      {
        request: async (connectorId, request, options) => {
          requests.push({ connectorId, request, signal: options?.signal });
          return response(200, { elements: [] });
        }
      },
      () => retrievedAt
    );
    await operation.handler(area, new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(requests[0].connectorId).toBe("building_scan");
    expect(requests[0].request).toMatchObject({ method: "POST", path: "/api/interpreter" });
    expect(requests[0].request.headers).toEqual(
      expect.arrayContaining([expect.arrayContaining(["user-agent", expect.stringContaining("Atlas Building Scan")])])
    );
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    if (!requests[0].request.body) throw new Error("expected request body");
    const body = new TextDecoder().decode(requests[0].request.body);
    expect(body).toContain("data=%5Bout%3Ajson%5D");
  });
});

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function response(status: number, value: unknown): SourceGatewayResponse {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return { status, headers: [], body: new TextEncoder().encode(body) };
}

function squareElement(id: number) {
  const offset = id / 1_000_000;
  return {
    type: "way",
    id,
    tags: { building: "yes" },
    geometry: [
      { lat: 42 + offset, lon: -71 },
      { lat: 42 + offset, lon: -70.9999 },
      { lat: 42.0001 + offset, lon: -70.9999 },
      { lat: 42.0001 + offset, lon: -71 },
      { lat: 42 + offset, lon: -71 }
    ]
  };
}
