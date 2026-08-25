import type { Position, UiPolygon } from "../../atlas/geometry.js";
import type { MapTarget } from "../../ui/map/interaction/map-camera.js";

export type PlaceSearchResult = {
  id: string;
  name: string;
  context?: string;
  coordinates: [number, number];
  target: MapTarget;
};

export type PlaceSearchResponse = {
  results: PlaceSearchResult[];
  attribution: string;
};

export type PlaceSearch = (query: string, signal: AbortSignal) => Promise<PlaceSearchResponse>;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const MAPTILER_GEOCODING_URL = "https://api.maptiler.com/geocoding";
const BROAD_PLACE_TYPES = new Set([
  "continental_marine",
  "country",
  "major_landform",
  "region",
  "subregion",
  "county",
  "municipality",
  "municipal_district",
  "locality",
  "neighbourhood",
  "place"
]);

export function createMapTilerPlaceSearch(apiKey: string, fetchImpl: Fetch = fetch): PlaceSearch {
  const normalizedApiKey = apiKey.trim();
  return async (query, signal) => {
    const url = new URL(`${MAPTILER_GEOCODING_URL}/${encodeURIComponent(query)}.json`);
    url.searchParams.set("key", normalizedApiKey);
    url.searchParams.set("limit", "5");
    url.searchParams.set("autocomplete", "true");

    const response = await fetchImpl(url, { signal }).catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new Error("Place search failed.");
    });
    if (!response.ok) {
      throw new Error(response.status === 403 ? "Place search is not authorized." : "Place search failed.");
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!isRecord(payload) || !Array.isArray(payload.features) || typeof payload.attribution !== "string") {
      throw new Error("Place search returned an invalid response.");
    }

    return {
      results: payload.features
        .flatMap((feature) => {
          const result = parseFeature(feature);
          return result ? [result] : [];
        })
        .slice(0, 5),
      attribution: payload.attribution
    };
  };
}

function parseFeature(value: unknown): PlaceSearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.text);
  const coordinates =
    lngLat(value.center) ?? (isRecord(value.geometry) ? lngLat(value.geometry.coordinates) : undefined);
  if (!id || !name || !coordinates) return undefined;

  const placeName = stringValue(value.place_name);
  const context = placeName && placeName !== name ? removeNamePrefix(placeName, name) : undefined;
  const targetId = `place:${id}`;
  const bbox = boundingBox(value.bbox);
  const placeTypes = Array.isArray(value.place_type) ? value.place_type.filter(isString) : [];
  const geometry = bbox && placeTypes.some((type) => BROAD_PLACE_TYPES.has(type)) ? polygonForBounds(bbox) : undefined;

  return {
    id,
    name,
    context,
    coordinates,
    target: geometry
      ? { type: "geometry", id: targetId, geometry, label: name }
      : { type: "point", id: targetId, coordinates, label: name }
  };
}

function removeNamePrefix(placeName: string, name: string): string {
  const prefix = `${name},`;
  return placeName.startsWith(prefix) ? placeName.slice(prefix.length).trim() : placeName;
}

function polygonForBounds([west, south, east, north]: [number, number, number, number]): UiPolygon {
  const southwest: Position = [west, south];
  const southeast: Position = [east, south];
  const northeast: Position = [east, north];
  const northwest: Position = [west, north];
  return { type: "Polygon", coordinates: [[southwest, southeast, northeast, northwest, southwest]] };
}

function boundingBox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const [west, south, east, north] = value;
  if (![west, south, east, north].every(isFiniteNumber)) return undefined;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return undefined;
  return [west, south, east, north];
}

function lngLat(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const [lng, lat] = value;
  if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) return undefined;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return undefined;
  return [lng, lat];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
