import type { Position, UiPolygon } from "../../atlas/geometry.js";
import type { MapTarget } from "../../ui/map/interaction/map-camera.js";
import type { CountryBounds } from "./primary-country-bounds.js";

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
type CountryBoundsLookup = (countryCode: string) => CountryBounds | undefined;

const MAPTILER_GEOCODING_URL = "https://api.maptiler.com/geocoding";
const POINT_RETICLE_SIZE = 48;
const MAX_MERCATOR_LATITUDE = 85.051129;

export function createMapTilerPlaceSearch(apiKey: string, fetchImpl: Fetch = fetch): PlaceSearch {
  const normalizedApiKey = apiKey.trim();
  return async (query, signal) => {
    const url = new URL(`${MAPTILER_GEOCODING_URL}/${encodeURIComponent(query)}.json`);
    url.searchParams.set("key", normalizedApiKey);
    url.searchParams.set("limit", "5");
    url.searchParams.set("autocomplete", "true");
    url.searchParams.set("language", "en");

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

    const countryBounds = payload.features.some(
      (feature) => isRecord(feature) && countryCodeFromFeature(feature) !== undefined
    )
      ? await import("./primary-country-bounds.js")
          .then(({ primaryCountryBounds }) => primaryCountryBounds)
          .catch(() => {
            throw new Error("Place search failed.");
          })
      : undefined;

    return {
      results: payload.features
        .flatMap((feature) => {
          const result = parseFeature(feature, countryBounds);
          return result ? [result] : [];
        })
        .slice(0, 5),
      attribution: payload.attribution
    };
  };
}

function parseFeature(value: unknown, countryBounds?: CountryBoundsLookup): PlaceSearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const name = stringValue(value.text);
  const coordinates =
    lngLat(value.center) ?? (isRecord(value.geometry) ? lngLat(value.geometry.coordinates) : undefined);
  if (!id || !name || !coordinates) return undefined;

  const placeName = stringValue(value.place_name);
  const context = placeName && placeName !== name ? removeNamePrefix(placeName, name) : undefined;
  const targetId = `place:${id}`;
  const placeTypes = placeTypesFromFeature(value);
  const countryCode = countryCodeFromFeature(value);
  const pointOnly = placeTypes.some((placeType) => placeType === "address" || placeType === "poi");
  const bbox = pointOnly ? undefined : ((countryCode && countryBounds?.(countryCode)) ?? boundingBox(value.bbox));
  const geometry = bbox ? polygonForBounds(bbox) : undefined;
  const cameraCoordinates: [number, number] = [coordinates[0], clampMercatorLatitude(coordinates[1])];

  return {
    id,
    name,
    context,
    coordinates,
    target: geometry
      ? { type: "geometry", id: targetId, geometry, label: name }
      : { type: "point", id: targetId, coordinates: cameraCoordinates, label: name, reticleSize: POINT_RETICLE_SIZE }
  };
}

function removeNamePrefix(placeName: string, name: string): string {
  const prefix = `${name},`;
  return placeName.startsWith(prefix) ? placeName.slice(prefix.length).trim() : placeName;
}

function countryCodeFromFeature(value: Record<string, unknown>): string | undefined {
  if (!placeTypesFromFeature(value).includes("country") || !isRecord(value.properties)) {
    return undefined;
  }
  return stringValue(value.properties.country_code)?.toLowerCase();
}

function placeTypesFromFeature(value: Record<string, unknown>): string[] {
  return Array.isArray(value.place_type)
    ? value.place_type.filter((placeType): placeType is string => typeof placeType === "string")
    : [];
}

function polygonForBounds([west, south, east, north]: CountryBounds): UiPolygon {
  const unwrappedEast = east < west ? east + 360 : east;
  const southwest: Position = [west, south];
  const southeast: Position = [unwrappedEast, south];
  const northeast: Position = [unwrappedEast, north];
  const northwest: Position = [west, north];
  return { type: "Polygon", coordinates: [[southwest, southeast, northeast, northwest, southwest]] };
}

function boundingBox(value: unknown): CountryBounds | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const [west, south, east, north] = value;
  if (![west, south, east, north].every(isFiniteNumber)) return undefined;
  const longitudeSpan = east >= west ? east - west : east + 360 - west;
  if (
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    longitudeSpan <= 0 ||
    longitudeSpan >= 360 ||
    south >= north
  )
    return undefined;
  const clampedSouth = clampMercatorLatitude(south);
  const clampedNorth = clampMercatorLatitude(north);
  return clampedSouth < clampedNorth ? [west, clampedSouth, east, clampedNorth] : undefined;
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampMercatorLatitude(latitude: number): number {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}
