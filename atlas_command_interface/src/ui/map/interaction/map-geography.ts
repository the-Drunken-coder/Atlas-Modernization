import { FIT_BOUNDS_PADDING } from "./map-camera.js";

type MapTilerPlaceType =
  | "country"
  | "major_landform"
  | "region"
  | "subregion"
  | "county"
  | "municipality"
  | "municipal_district"
  | "locality"
  | "neighbourhood"
  | "place";

export type GeographicZoomTarget = {
  bounds: [[number, number], [number, number]];
  label?: string;
  type: MapTilerPlaceType;
};

type GeographicCamera = {
  getZoom(): number;
  cameraForBounds(
    bounds: GeographicZoomTarget["bounds"],
    options: { maxZoom: number; padding: number }
  ): { zoom?: number } | undefined;
};

export const GEOGRAPHIC_FIT_MAX_ZOOM = 14;
const MINIMUM_ZOOM_GAIN = 0.35;

/**
 * Match reverse-geocoding detail to what is legible at the current scale.
 * Repeated double-clicks therefore move from country to region to local area
 * instead of jumping from a world view directly to a street.
 */
export function geographicTypesForZoom(zoom: number): readonly MapTilerPlaceType[] {
  if (zoom < 3.5) return ["country", "major_landform"];
  if (zoom < 6) return ["major_landform", "region", "country"];
  if (zoom < 8) return ["major_landform", "subregion", "county", "region"];
  if (zoom < 10) return ["major_landform", "municipality", "municipal_district", "locality", "county"];
  return ["major_landform", "place", "locality", "neighbourhood", "municipality"];
}

export async function fetchMapTilerGeographicTargets({
  apiKey,
  coordinates,
  zoom,
  signal,
  fetcher = fetch
}: {
  apiKey: string;
  coordinates: [number, number];
  zoom: number;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<GeographicZoomTarget[]> {
  const types = geographicTypesForZoom(zoom);
  const url = new URL(`https://api.maptiler.com/geocoding/${coordinates[0]},${coordinates[1]}.json`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("types", types.join(","));

  const response = await fetcher(url, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`MapTiler geographic lookup failed (${response.status})`);
  const payload: unknown = await response.json();
  const features = mapTilerFeatures(payload, coordinates);

  return types.flatMap((type) => {
    const match = features.find((feature) => feature.type === type);
    return match ? [match] : [];
  });
}

/** Pick the first ranked feature that would move the camera meaningfully closer. */
export function chooseGeographicZoomTarget(
  map: GeographicCamera,
  targets: readonly GeographicZoomTarget[]
): GeographicZoomTarget | undefined {
  const currentZoom = map.getZoom();
  return targets.find((target) => {
    const camera = map.cameraForBounds(target.bounds, {
      maxZoom: GEOGRAPHIC_FIT_MAX_ZOOM,
      padding: FIT_BOUNDS_PADDING
    });
    return camera?.zoom !== undefined && camera.zoom > currentZoom + MINIMUM_ZOOM_GAIN;
  });
}

function mapTilerFeatures(payload: unknown, coordinates: [number, number]): GeographicZoomTarget[] {
  if (!isRecord(payload) || !Array.isArray(payload.features)) return [];
  return payload.features.flatMap((feature) => {
    if (!isRecord(feature)) return [];
    const type = mapTilerPlaceType(feature.place_type);
    const bounds = geographicBounds(feature.bbox);
    if (!type || !bounds || !boundsContain(bounds, coordinates)) return [];
    return [{ bounds, label: typeof feature.text === "string" ? feature.text : undefined, type }];
  });
}

function mapTilerPlaceType(value: unknown): MapTilerPlaceType | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((item): item is MapTilerPlaceType => typeof item === "string" && PLACE_TYPES.has(item));
}

function geographicBounds(value: unknown): [[number, number], [number, number]] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  )
    return undefined;
  const [west, south, east, north] = value;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return undefined;
  return [
    [west, south],
    [east, north]
  ];
}

function boundsContain(
  [[west, south], [east, north]]: [[number, number], [number, number]],
  [longitude, latitude]: [number, number]
): boolean {
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const PLACE_TYPES: ReadonlySet<string> = new Set([
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
