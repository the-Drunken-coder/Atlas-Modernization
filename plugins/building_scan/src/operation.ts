import {
  defineSpatialOperation,
  PluginFailureError,
  type SourceGatewayClient,
  SourceGatewayError,
  type SourceGatewayResponse
} from "@the-drunken-coder/atlas-plugin-runtime";
import type { MapArea, SpatialFeature, SpatialGeometry, SpatialOperationResult } from "@the-drunken-coder/atlas-sdk";

const connectorId = "building_scan";
const candidateLimit = 501;
const featureLimit = 500;
export const responseBudgetBytes = 900 * 1024;

const attribution = {
  text: "Map data from OpenStreetMap",
  url: "https://www.openstreetmap.org/copyright"
} as const;

type Gateway = Pick<SourceGatewayClient, "request">;
type Position = [longitude: number, latitude: number];
type Ring = Position[];
type Tags = Record<string, string>;
type ElementMetadata = {
  version?: number;
  timestamp?: string;
  changeset?: number;
  user?: string;
  uid?: number;
};

type Candidate = {
  type: "way" | "relation";
  id: number;
  tags: Tags;
  metadata: ElementMetadata;
  geometry: SpatialGeometry;
};

class MalformedSourceResponse extends Error {}

class SourceRemarkError extends Error {
  constructor(readonly pluginCode: "source_busy" | "source_timeout" | "source_unavailable") {
    super(pluginCode);
  }
}

export function createBuildingSearchOperation(gateway: Gateway, now: () => Date = () => new Date()) {
  return defineSpatialOperation({
    displayName: "Search buildings",
    timeoutMs: 20_000,
    async handler(area, signal) {
      const response = await requestSource(gateway, area, signal);
      if (response.status === 429) throw new PluginFailureError("source_busy");
      if (response.status >= 500) throw new PluginFailureError("source_unavailable");
      if (response.status < 200 || response.status >= 300) throw new PluginFailureError("source_rejected");

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(response.body));
      } catch {
        throw new PluginFailureError("malformed_source_response");
      }

      try {
        return buildResult(payload, now());
      } catch (error) {
        if (error instanceof SourceRemarkError) {
          throw new PluginFailureError(error.pluginCode);
        }
        if (error instanceof MalformedSourceResponse) {
          throw new PluginFailureError("malformed_source_response");
        }
        throw error;
      }
    }
  });
}

async function requestSource(gateway: Gateway, area: MapArea, signal: AbortSignal): Promise<SourceGatewayResponse> {
  const query = overpassQuery(area);
  try {
    return await gateway.request(
      connectorId,
      {
        method: "POST",
        path: "/api/interpreter",
        headers: [
          ["content-type", "application/x-www-form-urlencoded"],
          ["user-agent", "Atlas Building Scan/0.1 (+https://github.com/the-drunken-coder/atlas)"]
        ],
        body: new TextEncoder().encode(`data=${encodeURIComponent(query)}`)
      },
      { signal }
    );
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof SourceGatewayError)) throw new PluginFailureError("source_unavailable");
    switch (error.failureCode) {
      case "upstream_timeout":
        throw new PluginFailureError("source_timeout");
      case "response_too_large":
        throw new PluginFailureError("source_response_too_large");
      case "circuit_open":
        throw new PluginFailureError("source_busy");
      case "request_rejected":
      case "unknown_connector":
        throw new PluginFailureError("source_configuration_error");
      case "upstream_unreachable":
        throw new PluginFailureError("source_unavailable");
    }
  }
}

export function overpassQuery(area: MapArea): string {
  const bounds = `${area.south},${area.west},${area.north},${area.east}`;
  return `[out:json][timeout:9];\n(\n  way["building"](${bounds});\n  relation["building"](${bounds});\n);\nout meta geom ${candidateLimit};`;
}

export function buildResult(payload: unknown, retrievedAt: Date): SpatialOperationResult {
  if (Number.isNaN(retrievedAt.getTime())) throw new TypeError("retrieval time must be valid");
  const { candidates, sourceLimitReached } = parseCandidates(payload);
  const result: SpatialOperationResult = {
    features: [],
    provenance: { connector_id: connectorId, source: "OpenStreetMap through an Overpass-compatible endpoint" },
    attribution,
    retrieved_at: retrievedAt.toISOString(),
    truncation: null
  };
  const budgetBaseBytes = Buffer.byteLength(
    JSON.stringify({ ...result, truncation: { reason: "response_budget" as const } })
  );
  let featureBytes = 0;

  for (const candidate of candidates.slice(0, featureLimit)) {
    const feature = candidateToFeature(candidate);
    const nextFeatureBytes = Buffer.byteLength(JSON.stringify(feature)) + (result.features.length === 0 ? 0 : 1);
    if (budgetBaseBytes + featureBytes + nextFeatureBytes >= responseBudgetBytes) {
      result.truncation = { reason: "response_budget" };
      break;
    }
    featureBytes += nextFeatureBytes;
    result.features.push(feature);
  }
  if (result.truncation === null && (sourceLimitReached || candidates.length > featureLimit)) {
    result.truncation = { reason: "feature_limit" };
  }
  if (Buffer.byteLength(JSON.stringify(result)) >= responseBudgetBytes) {
    throw new Error("Building Scan result budget calculation failed");
  }
  return result;
}

function parseCandidates(payload: unknown): { candidates: Candidate[]; sourceLimitReached: boolean } {
  if (!isRecord(payload)) throw new MalformedSourceResponse();
  if (Object.hasOwn(payload, "remark")) {
    if (typeof payload.remark !== "string" || !payload.remark.trim()) throw new MalformedSourceResponse();
    throw new SourceRemarkError(overpassRemarkCode(payload.remark));
  }
  if (!Array.isArray(payload.elements)) throw new MalformedSourceResponse();
  const byElement = new Map<string, Candidate>();
  for (const value of payload.elements) {
    if (!isRecord(value) || (value.type !== "way" && value.type !== "relation")) {
      throw new MalformedSourceResponse();
    }
    if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) throw new MalformedSourceResponse();
    const id = value.id as number;
    const tags = parseTags(value.tags);
    const metadata = parseMetadata(value);
    const candidate: Candidate =
      value.type === "way"
        ? { type: "way", id, tags, metadata, geometry: wayGeometry(value.geometry) }
        : { type: "relation", id, tags, metadata, geometry: relationGeometry(value.members) };
    const key = `${candidate.type}/${candidate.id}`;
    const existing = byElement.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) throw new MalformedSourceResponse();
    byElement.set(key, candidate);
  }
  return {
    candidates: [...byElement.values()].sort((left, right) => {
      const typeOrder = (left.type === "way" ? 0 : 1) - (right.type === "way" ? 0 : 1);
      return typeOrder || left.id - right.id;
    }),
    sourceLimitReached: payload.elements.length >= candidateLimit
  };
}

function overpassRemarkCode(remark: string): SourceRemarkError["pluginCode"] {
  const normalized = remark.toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("timeout")) return "source_timeout";
  if (
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("busy") ||
    normalized.includes("slots available")
  ) {
    return "source_busy";
  }
  return "source_unavailable";
}

function parseTags(value: unknown): Tags {
  if (!isRecord(value)) throw new MalformedSourceResponse();
  const tags: Tags = {};
  for (const key of Object.keys(value).sort()) {
    const tag = value[key];
    if (!key.trim() || typeof tag !== "string" || !tag.trim()) throw new MalformedSourceResponse();
    tags[key] = tag;
  }
  return tags;
}

function parseMetadata(value: Record<string, unknown>): ElementMetadata {
  return {
    version: optionalPositiveInteger(value.version),
    timestamp: optionalNonEmptyString(value.timestamp),
    changeset: optionalPositiveInteger(value.changeset),
    user: optionalNonEmptyString(value.user),
    uid: optionalPositiveInteger(value.uid)
  };
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new MalformedSourceResponse();
  return value as number;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new MalformedSourceResponse();
  return value;
}

function wayGeometry(value: unknown): SpatialGeometry {
  const ring = orientAndCanonicalizeRing(parsePositions(value, 4), "outer");
  return { type: "Polygon", coordinates: [ring] };
}

function relationGeometry(value: unknown): SpatialGeometry {
  if (!Array.isArray(value)) throw new MalformedSourceResponse();
  const outerSegments: Ring[] = [];
  const innerSegments: Ring[] = [];
  for (const member of value) {
    if (!isRecord(member) || typeof member.role !== "string" || typeof member.type !== "string") {
      throw new MalformedSourceResponse();
    }
    const role = member.role === "" ? "outer" : member.role;
    if (role !== "outer" && role !== "inner") continue;
    if (member.type !== "way") throw new MalformedSourceResponse();
    (role === "outer" ? outerSegments : innerSegments).push(parsePositions(member.geometry, 2));
  }
  const outers = assembleRings(outerSegments).map((ring) => orientAndCanonicalizeRing(ring, "outer"));
  const inners = assembleRings(innerSegments).map((ring) => orientAndCanonicalizeRing(ring, "inner"));
  if (outers.length === 0) throw new MalformedSourceResponse();
  outers.sort(compareRings);
  inners.sort(compareRings);

  const polygons: Ring[][] = outers.map((outer) => [outer]);
  for (const inner of inners) {
    const containing = outers
      .map((outer, index) => ({ index, area: Math.abs(signedArea(outer)), contains: pointInRing(inner[0], outer) }))
      .filter(({ contains }) => contains)
      .sort((left, right) => left.area - right.area || left.index - right.index)[0];
    if (!containing) throw new MalformedSourceResponse();
    polygons[containing.index].push(inner);
  }
  for (const polygon of polygons) polygon.splice(1, polygon.length - 1, ...polygon.slice(1).sort(compareRings));
  const positionCount = polygons.flat(2).length;
  if (positionCount > 10_000) throw new MalformedSourceResponse();
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

function parsePositions(value: unknown, minimum: number): Ring {
  if (!Array.isArray(value) || value.length < minimum) throw new MalformedSourceResponse();
  const positions = value.map((position): Position => {
    if (!isRecord(position) || typeof position.lon !== "number" || typeof position.lat !== "number") {
      throw new MalformedSourceResponse();
    }
    if (!Number.isFinite(position.lon) || position.lon < -180 || position.lon > 180)
      throw new MalformedSourceResponse();
    if (!Number.isFinite(position.lat) || position.lat < -90 || position.lat > 90) throw new MalformedSourceResponse();
    return [position.lon, position.lat];
  });
  return positions;
}

function assembleRings(input: Ring[]): Ring[] {
  const segments = input.map((segment) => segment.map((position): Position => [...position]));
  const rings: Ring[] = [];
  while (segments.length > 0) {
    const current = segments.shift();
    if (!current) throw new MalformedSourceResponse();
    while (!positionsEqual(current[0], current[current.length - 1])) {
      const end = current[current.length - 1];
      const index = segments.findIndex(
        (segment) => positionsEqual(end, segment[0]) || positionsEqual(end, segment[segment.length - 1])
      );
      if (index < 0) throw new MalformedSourceResponse();
      const [next] = segments.splice(index, 1);
      if (!positionsEqual(end, next[0])) next.reverse();
      current.push(...next.slice(1));
    }
    if (current.length < 4) throw new MalformedSourceResponse();
    rings.push(current);
  }
  return rings;
}

function orientAndCanonicalizeRing(ring: Ring, role: "outer" | "inner"): Ring {
  if (!positionsEqual(ring[0], ring[ring.length - 1])) throw new MalformedSourceResponse();
  if (ring.length > 10_000) throw new MalformedSourceResponse();
  let open = ring.slice(0, -1);
  if (open.length < 3 || signedArea(ring) === 0) throw new MalformedSourceResponse();
  const isCounterClockwise = signedArea(ring) > 0;
  if ((role === "outer") !== isCounterClockwise) open = [...open].reverse();
  let start = 0;
  for (let index = 1; index < open.length; index += 1) {
    if (comparePositions(open[index], open[start]) < 0) start = index;
  }
  const rotated = [...open.slice(start), ...open.slice(0, start)];
  return [...rotated, rotated[0]];
}

function signedArea(ring: Ring): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

function pointInRing(point: Position, ring: Ring): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    const intersects =
      currentPoint[1] > point[1] !== previousPoint[1] > point[1] &&
      point[0] <
        ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])) / (previousPoint[1] - currentPoint[1]) +
          currentPoint[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function candidateToFeature(candidate: Candidate): SpatialFeature {
  const address = buildingAddress(candidate.tags);
  const buildingType = humanizeBuildingType(candidate.tags.building);
  const metadataFields = [
    ["OSM version", candidate.metadata.version?.toString()],
    ["Last edited", candidate.metadata.timestamp],
    ["Changeset", candidate.metadata.changeset?.toString()],
    ["Contributor", candidate.metadata.user],
    ["Contributor ID", candidate.metadata.uid?.toString()]
  ].filter((field): field is [string, string] => typeof field[1] === "string");
  const tagFields = Object.entries(candidate.tags).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const fields = [...(address ? [["Address", address] as [string, string]] : []), ...metadataFields, ...tagFields].map(
    ([label, value]) => ({ label, value })
  );
  return {
    id: `${candidate.type}/${candidate.id}`,
    title: candidate.tags.name?.trim() || address || buildingType || `Building ${candidate.type}/${candidate.id}`,
    geometry: candidate.geometry,
    fields
  };
}

function buildingAddress(tags: Tags): string | undefined {
  if (tags["addr:full"]?.trim()) return tags["addr:full"].trim();
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ").trim();
  const locality = [tags["addr:city"], tags["addr:postcode"]].filter(Boolean).join(" ").trim();
  return [street, locality].filter(Boolean).join(", ") || undefined;
}

function humanizeBuildingType(value: string | undefined): string | undefined {
  if (!value || value === "yes") return undefined;
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function compareRings(left: Ring, right: Ring): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = comparePositions(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function comparePositions(left: Position, right: Position): number {
  return left[0] - right[0] || left[1] - right[1];
}

function positionsEqual(left: Position, right: Position): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
