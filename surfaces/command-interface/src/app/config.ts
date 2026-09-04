import { ATLAS_PROTOCOL_REVISION, normalizeAtlasBaseUrl, sanitizeErrorMessage } from "@the-drunken-coder/atlas-sdk";
import type { StyleSpecification } from "maplibre-gl";

export type MapSourceConfig = {
  id: string;
  label: string;
  style?: StyleSpecification;
  unavailableReason?: string;
};

export type PlaceSearchConfig = {
  provider: "maptiler";
  apiKey?: string;
  unavailableReason?: string;
};

export type AppConfig = {
  atlasBaseUrl: string;
  protocolRevision: string;
  defaultMapSourceId: string;
  mapSources: MapSourceConfig[];
  placeSearch: PlaceSearchConfig;
};

export type CoreConfig = Pick<AppConfig, "atlasBaseUrl" | "protocolRevision">;

const LOCAL_CORE_BASE_URL = "http://127.0.0.1:8000";
const REMOTE_CORE_BASE_URL = "https://api.atlasinterface.com";
const DEFAULT_MAP_SOURCE_ID = "maptiler-osm-dark";
export const GOOGLE_MAPS_TILE_SESSION_TIMEOUT_MS = 5_000;

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

type MapProviderEnvKey =
  | "googleMapsTileSession"
  | "VITE_GOOGLE_MAPS_API_KEY"
  | "VITE_MAPBOX_ACCESS_TOKEN"
  | "VITE_MAPTILER_API_KEY"
  | "VITE_THUNDERFOREST_API_KEY";

type MapProviderManifestEntry = {
  readonly id: string;
  readonly label: string;
  readonly tiles: readonly string[];
  readonly maxzoom: number;
  readonly credentials?: readonly {
    readonly env: MapProviderEnvKey;
    readonly unavailableReason: string;
  }[];
  readonly rasterContrast?: number;
};

export const MAP_PROVIDER_MANIFEST: readonly MapProviderManifestEntry[] = [
  {
    id: "google-satellite",
    label: "Google Satellite",
    tiles: [
      "https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session={googleMapsTileSession}&key={VITE_GOOGLE_MAPS_API_KEY}"
    ],
    maxzoom: 22,
    credentials: [
      { env: "VITE_GOOGLE_MAPS_API_KEY", unavailableReason: "missing key" },
      { env: "googleMapsTileSession", unavailableReason: "session unavailable" }
    ]
  },
  {
    id: "openstreetmap-default",
    label: "OpenStreetMap Default",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    maxzoom: 19
  },
  {
    id: "usgs-topo",
    label: "USGS Topo",
    tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"],
    maxzoom: 23,
    rasterContrast: 0.08
  },
  {
    id: "mapbox-satellite",
    label: "Mapbox Satellite",
    tiles: ["https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90?access_token={VITE_MAPBOX_ACCESS_TOKEN}"],
    maxzoom: 22,
    credentials: [{ env: "VITE_MAPBOX_ACCESS_TOKEN", unavailableReason: "missing key" }]
  },
  {
    id: "mapbox-outdoors",
    label: "Mapbox Outdoors",
    tiles: [
      "https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/{z}/{x}/{y}?access_token={VITE_MAPBOX_ACCESS_TOKEN}"
    ],
    maxzoom: 22,
    credentials: [{ env: "VITE_MAPBOX_ACCESS_TOKEN", unavailableReason: "missing key" }]
  },
  {
    id: "mapbox-dark",
    label: "Mapbox Dark",
    tiles: [
      "https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}?access_token={VITE_MAPBOX_ACCESS_TOKEN}"
    ],
    maxzoom: 22,
    credentials: [{ env: "VITE_MAPBOX_ACCESS_TOKEN", unavailableReason: "missing key" }]
  },
  {
    id: "thunderforest-outdoors",
    label: "Thunderforest Outdoors",
    tiles: ["https://api.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey={VITE_THUNDERFOREST_API_KEY}"],
    maxzoom: 22,
    credentials: [{ env: "VITE_THUNDERFOREST_API_KEY", unavailableReason: "missing key" }]
  },
  {
    id: "maptiler-satellite",
    label: "MapTiler Satellite",
    tiles: ["https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key={VITE_MAPTILER_API_KEY}"],
    maxzoom: 22,
    credentials: [{ env: "VITE_MAPTILER_API_KEY", unavailableReason: "missing key" }]
  },
  {
    id: "maptiler-osm-dark",
    label: "MapTiler OSM Dark",
    tiles: ["https://api.maptiler.com/maps/openstreetmap-dark/256/{z}/{x}/{y}.png?key={VITE_MAPTILER_API_KEY}"],
    maxzoom: 22,
    credentials: [{ env: "VITE_MAPTILER_API_KEY", unavailableReason: "missing key" }]
  },
  {
    id: "openmaptiles-dark-matter",
    label: "OpenMapTiles Dark Matter",
    tiles: [
      "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
      "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
      "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
      "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
    ],
    maxzoom: 20
  }
];

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
    atlasBaseUrl: parseConfigUrl(envValue(env.VITE_ATLAS_CORE_BASE_URL) ?? defaultCoreBaseUrl(env), "atlasBaseUrl"),
    protocolRevision: ATLAS_PROTOCOL_REVISION
  };
}

export function appConfigFromEnv(env: RuntimeEnv): AppConfig {
  const coreConfig = coreConfigFromEnv(env);
  const mapTilerApiKey = envValue(env.VITE_MAPTILER_API_KEY);
  return {
    ...coreConfig,
    defaultMapSourceId: DEFAULT_MAP_SOURCE_ID,
    mapSources: buildMapSourceConfig(env),
    placeSearch: mapTilerApiKey
      ? { provider: "maptiler", apiKey: mapTilerApiKey }
      : { provider: "maptiler", unavailableReason: "missing key" }
  };
}

function defaultCoreBaseUrl(env: RuntimeEnv): string {
  return isDevelopment(env) ? LOCAL_CORE_BASE_URL : REMOTE_CORE_BASE_URL;
}

function isDevelopment(env: RuntimeEnv): boolean {
  return env.DEV === true || env.MODE === "development";
}

function parseConfigUrl(value: string, field: "atlasBaseUrl"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Atlas interface config has empty ${field}`);
  let normalized: string;
  try {
    normalized = normalizeAtlasBaseUrl(trimmed);
  } catch {
    throw new Error(`Atlas interface config has invalid ${field}`);
  }
  if (normalized.startsWith("/")) return normalized;
  const parsed = new URL(normalized);
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`Atlas interface config has invalid ${field}`);
  }
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part));
}

function buildMapSourceConfig(env: RuntimeEnv): MapSourceConfig[] {
  return MAP_PROVIDER_MANIFEST.map((provider) => {
    const credentials = (provider.credentials ?? []).map((credential) => ({
      ...credential,
      value: envValue(env[credential.env])
    }));
    const missingCredential = credentials.find((credential) => !credential.value);
    if (missingCredential) {
      return { id: provider.id, label: provider.label, unavailableReason: missingCredential.unavailableReason };
    }

    const tiles = provider.tiles.map((template) => {
      let tile = template;
      for (const credential of credentials) {
        if (credential.value) tile = tile.replaceAll(`{${credential.env}}`, urlParam(credential.value));
      }
      return tile;
    });

    return {
      id: provider.id,
      label: provider.label,
      style: {
        version: 8,
        sources: {
          [provider.id]: {
            type: "raster",
            tiles,
            tileSize: 256,
            minzoom: undefined,
            maxzoom: provider.maxzoom
          }
        },
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#070a0f" }
          },
          {
            id: `${provider.id}-raster`,
            type: "raster",
            source: provider.id,
            paint: {
              "raster-opacity": 0.84,
              "raster-saturation": 0,
              "raster-contrast": provider.rasterContrast ?? 0
            }
          }
        ]
      }
    };
  });
}

async function fetchGoogleMapsTileSession(apiKey: string): Promise<string | undefined> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const request = fetch(`https://tile.googleapis.com/v1/createSession?key=${urlParam(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" }),
    signal: controller.signal
  })
    .then(async (response) => {
      if (!response.ok) {
        console.warn(`Google Maps satellite session request failed (${response.status})`);
        return undefined;
      }
      const payload = (await response.json().catch(() => undefined)) as { session?: unknown } | undefined;
      const session = typeof payload?.session === "string" ? payload.session.trim() : "";
      if (!session) console.warn("Google Maps satellite session response did not include a session token");
      return session || undefined;
    })
    .catch((error: unknown) => {
      if (!timedOut) console.warn("Google Maps satellite session request failed", sanitizeErrorMessage(error));
      return undefined;
    });
  const timeout = new Promise<undefined>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      console.warn(`Google Maps satellite session request timed out after ${GOOGLE_MAPS_TILE_SESSION_TIMEOUT_MS}ms`);
      resolve(undefined);
    }, GOOGLE_MAPS_TILE_SESSION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function urlParam(value: string): string {
  return encodeURIComponent(value);
}
