import { ATLAS_PROTOCOL_REVISION } from "../../../atlas_sdk/src/index.js";
import type { StyleSpecification } from "maplibre-gl";

export type MapSourceConfig = {
  id: string;
  label: string;
  style?: StyleSpecification;
  unavailableReason?: string;
};

export type AppConfig = {
  atlasBaseUrl: string;
  protocolRevision: string;
  defaultMapSourceId: string;
  mapSources: MapSourceConfig[];
};

export type CoreConfig = Pick<AppConfig, "atlasBaseUrl" | "protocolRevision">;

const CONFIG_URL_BASE = "http://localhost";
const URL_SCHEME = /^[a-z][a-z\d+\-.]*:/i;
const LOCAL_CORE_BASE_URL = "http://127.0.0.1:8000";
const REMOTE_CORE_BASE_URL = "https://api.atlasinterface.com";
const CREDENTIALED_MAP_SOURCE_IDS = [
  "google-satellite",
  "mapbox-satellite",
  "mapbox-outdoors",
  "mapbox-dark",
  "thunderforest-outdoors",
  "maptiler-satellite",
  "maptiler-osm-dark"
] as const;

type RuntimeEnv = {
  DEV?: boolean;
  MODE?: string;
  googleMapsTileSession?: string;
  VITE_ATLAS_CORE_BASE_URL?: string;
  VITE_GOOGLE_MAPS_API_KEY?: string;
  VITE_MAPBOX_ACCESS_TOKEN?: string;
  VITE_MAPTILER_API_KEY?: string;
  VITE_THUNDERFOREST_API_KEY?: string;
};

/** Build the browser config from Vite env and provider tile templates. */
export async function fetchAppConfig(): Promise<AppConfig> {
  const env = import.meta.env;
  const googleMapsApiKey = envValue(env.VITE_GOOGLE_MAPS_API_KEY);
  const googleMapsTileSession = googleMapsApiKey ? await fetchGoogleMapsTileSession(googleMapsApiKey) : undefined;
  return appConfigFromEnv({ ...env, googleMapsTileSession });
}

/** Resolve the non-network Core settings needed by the public authentication shell. */
export function coreConfigFromEnv(env: RuntimeEnv): CoreConfig {
  return {
    atlasBaseUrl: parseConfigUrl(envValue(env.VITE_ATLAS_CORE_BASE_URL) ?? defaultCoreBaseUrl(env), "atlasBaseUrl").replace(/\/$/, ""),
    protocolRevision: ATLAS_PROTOCOL_REVISION
  };
}

export function appConfigFromEnv(env: RuntimeEnv): AppConfig {
  const coreConfig = coreConfigFromEnv(env);
  const mapSources = buildMapSourceConfig(env).map(parseMapSource);
  if (mapSources.length === 0) {
    throw new Error("Atlas interface config has no mapSources");
  }
  const defaultMapSourceId = selectDefaultMapSourceId(env, mapSources);
  if (!defaultMapSourceId || !mapSources.some((source) => source.id === defaultMapSourceId)) {
    throw new Error("Atlas interface config has an invalid defaultMapSourceId");
  }
  return {
    ...coreConfig,
    defaultMapSourceId,
    mapSources
  };
}

function defaultCoreBaseUrl(env: RuntimeEnv): string {
  return isDevelopment(env) ? LOCAL_CORE_BASE_URL : REMOTE_CORE_BASE_URL;
}

function selectDefaultMapSourceId(env: RuntimeEnv, mapSources: MapSourceConfig[]): string | undefined {
  if (!isDevelopment(env)) {
    for (const id of CREDENTIALED_MAP_SOURCE_IDS) {
      if (mapSources.some((source) => source.id === id && source.style)) return id;
    }
  }
  return mapSources.find((source) => source.style)?.id;
}

function isDevelopment(env: RuntimeEnv): boolean {
  return env.DEV === true || env.MODE === "development";
}

function parseMapSource(value: unknown): MapSourceConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { label?: unknown }).label !== "string"
  ) {
    throw new Error("Atlas interface config has invalid mapSources");
  }
  const id = (value as { id: string }).id.trim();
  const label = (value as { label: string }).label.trim();
  if (!id || !label) {
    throw new Error("Atlas interface config has invalid mapSources");
  }
  const rawStyle = (value as { style?: unknown }).style;
  const style = isStyleSpecification(rawStyle) ? rawStyle : undefined;
  const unavailableReason = envValue((value as { unavailableReason?: string }).unavailableReason);
  if (!style && !unavailableReason) throw new Error("Atlas interface config has invalid mapSources");
  return { id, label, style, unavailableReason };
}

function parseConfigUrl(value: string, field: "atlasBaseUrl"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Atlas interface config has empty ${field}`);
  if (!URL_SCHEME.test(trimmed) && !trimmed.startsWith("/")) {
    throw new Error(`Atlas interface config has invalid ${field}`);
  }
  try {
    return new URL(trimmed, configUrlBase()).toString();
  } catch {
    throw new Error(`Atlas interface config has invalid ${field}`);
  }
}

function configUrlBase(): string {
  return globalThis.location?.origin ?? CONFIG_URL_BASE;
}

function buildMapSourceConfig(env: RuntimeEnv): MapSourceConfig[] {
  const googleMapsApiKey = envValue(env.VITE_GOOGLE_MAPS_API_KEY);
  const googleMapsTileSession = envValue(env.googleMapsTileSession);
  const mapboxAccessToken = envValue(env.VITE_MAPBOX_ACCESS_TOKEN);
  const thunderforestApiKey = envValue(env.VITE_THUNDERFOREST_API_KEY);
  const maptilerApiKey = envValue(env.VITE_MAPTILER_API_KEY);

  return [
    googleMapsApiKey && googleMapsTileSession
      ? rasterMapSource({
          id: "google-satellite",
          label: "Google Satellite",
          tiles: [`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${urlParam(googleMapsTileSession)}&key=${urlParam(googleMapsApiKey)}`],
          maxzoom: 22,
          attribution: "Google"
        })
      : unavailableMapSource({
          id: "google-satellite",
          label: "Google Satellite",
          unavailableReason: googleMapsApiKey ? "session unavailable" : "missing key"
        }),
    rasterMapSource({
      id: "openstreetmap-default",
      label: "OpenStreetMap Default",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }),
    rasterMapSource({
      id: "usgs-topo",
      label: "USGS Topo",
      tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"],
      maxzoom: 23,
      attribution: "USGS The National Map",
      rasterContrast: 0.08
    }),
    mapboxAccessToken
      ? rasterMapSource({
          id: "mapbox-satellite",
          label: "Mapbox Satellite",
          tiles: [`https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90?access_token=${urlParam(mapboxAccessToken)}`],
          maxzoom: 22,
          attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
        })
      : unavailableMapSource({ id: "mapbox-satellite", label: "Mapbox Satellite", unavailableReason: "missing key" }),
    mapboxAccessToken
      ? rasterMapSource({
          id: "mapbox-outdoors",
          label: "Mapbox Outdoors",
          tiles: [`https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/{z}/{x}/{y}?access_token=${urlParam(mapboxAccessToken)}`],
          maxzoom: 22,
          attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
        })
      : unavailableMapSource({ id: "mapbox-outdoors", label: "Mapbox Outdoors", unavailableReason: "missing key" }),
    mapboxAccessToken
      ? rasterMapSource({
          id: "mapbox-dark",
          label: "Mapbox Dark",
          tiles: [`https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}?access_token=${urlParam(mapboxAccessToken)}`],
          maxzoom: 22,
          attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a>'
        })
      : unavailableMapSource({ id: "mapbox-dark", label: "Mapbox Dark", unavailableReason: "missing key" }),
    thunderforestApiKey
      ? rasterMapSource({
          id: "thunderforest-outdoors",
          label: "Thunderforest Outdoors",
          tiles: [`https://api.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${urlParam(thunderforestApiKey)}`],
          maxzoom: 22,
          attribution: '&copy; <a href="https://www.thunderforest.com/">Thunderforest</a>, &copy; OpenStreetMap contributors'
        })
      : unavailableMapSource({ id: "thunderforest-outdoors", label: "Thunderforest Outdoors", unavailableReason: "missing key" }),
    maptilerApiKey
      ? rasterMapSource({
          id: "maptiler-satellite",
          label: "MapTiler Satellite",
          tiles: [`https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key=${urlParam(maptilerApiKey)}`],
          maxzoom: 22,
          attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a>'
        })
      : unavailableMapSource({ id: "maptiler-satellite", label: "MapTiler Satellite", unavailableReason: "missing key" }),
    maptilerApiKey
      ? rasterMapSource({
          id: "maptiler-osm-dark",
          label: "MapTiler OSM Dark",
          tiles: [`https://api.maptiler.com/maps/openstreetmap-dark/256/{z}/{x}/{y}.png?key=${urlParam(maptilerApiKey)}`],
          maxzoom: 22,
          attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a>, &copy; OpenStreetMap contributors'
        })
      : unavailableMapSource({ id: "maptiler-osm-dark", label: "MapTiler OSM Dark", unavailableReason: "missing key" }),
    rasterMapSource({
      id: "openmaptiles-dark-matter",
      label: "OpenMapTiles Dark Matter",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
      ],
      maxzoom: 20,
      attribution: '&copy; OpenStreetMap contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>'
    })
  ];
}

function rasterMapSource({
  id,
  label,
  tiles,
  attribution,
  minzoom,
  maxzoom,
  rasterContrast = 0,
  rasterSaturation = 0
}: {
  id: string;
  label: string;
  tiles: string[];
  attribution: string;
  minzoom?: number;
  maxzoom: number;
  rasterContrast?: number;
  rasterSaturation?: number;
}): MapSourceConfig {
  return {
    id,
    label,
    style: {
      version: 8,
      sources: {
        [id]: {
          type: "raster",
          tiles,
          tileSize: 256,
          minzoom,
          maxzoom,
          attribution
        }
      },
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#070a0f" }
        },
        {
          id: `${id}-raster`,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": 0.84,
            "raster-saturation": rasterSaturation,
            "raster-contrast": rasterContrast
          }
        }
      ]
    }
  };
}

function unavailableMapSource({ id, label, unavailableReason }: { id: string; label: string; unavailableReason: string }): MapSourceConfig {
  return { id, label, unavailableReason };
}

async function fetchGoogleMapsTileSession(apiKey: string): Promise<string | undefined> {
  const response = await fetch(`https://tile.googleapis.com/v1/createSession?key=${urlParam(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" })
  }).catch((error: unknown) => {
    console.warn("Google Maps satellite session request failed", error);
    return undefined;
  });
  if (!response) return undefined;
  if (!response.ok) {
    console.warn(`Google Maps satellite session request failed (${response.status})`);
    return undefined;
  }
  const payload = (await response.json().catch(() => undefined)) as { session?: unknown } | undefined;
  const session = typeof payload?.session === "string" ? payload.session.trim() : "";
  if (!session) console.warn("Google Maps satellite session response did not include a session token");
  return session || undefined;
}

function isStyleSpecification(value: unknown): value is StyleSpecification {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 8 &&
    typeof (value as { sources?: unknown }).sources === "object" &&
    Array.isArray((value as { layers?: unknown }).layers)
  );
}

function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function urlParam(value: string): string {
  return encodeURIComponent(value);
}
