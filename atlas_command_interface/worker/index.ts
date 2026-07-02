import { ATLAS_PROTOCOL_REVISION } from "../../atlas_sdk/src/index.js";
import type { StyleSpecification } from "maplibre-gl";

type APIErrorResponse = {
  success: false;
  error_code: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
};

type ProviderSecretName = "MAPTILER_API_KEY" | "MAPBOX_ACCESS_TOKEN";
type ProviderKind = "maptiler" | "mapbox" | "arcgis";
type TileExtension = "png" | "jpg" | "webp";

type MapSource = {
  id: string;
  label: string;
  provider: ProviderKind;
  maxzoom: number;
  ext: TileExtension;
  attribution: string;
  secretName?: ProviderSecretName;
  providerMapId?: string;
  providerStyleOwner?: string;
  providerStyleId?: string;
  upstreamBaseUrl?: string;
};

type MapSourceConfig = {
  id: string;
  label: string;
  styleUrl: string;
};

const MAP_SOURCES: MapSource[] = [
  {
    id: "maptiler-osm-dark",
    label: "MapTiler OSM Dark",
    provider: "maptiler",
    providerMapId: "dataviz-v4-dark",
    maxzoom: 22,
    ext: "png",
    secretName: "MAPTILER_API_KEY",
    attribution: '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
  },
  {
    id: "maptiler-satellite",
    label: "MapTiler Satellite",
    provider: "maptiler",
    providerMapId: "satellite-v4",
    maxzoom: 22,
    ext: "jpg",
    secretName: "MAPTILER_API_KEY",
    attribution: '&copy; <a href="https://www.maptiler.com/">MapTiler</a>'
  },
  {
    id: "mapbox-satellite",
    label: "Mapbox Satellite",
    provider: "mapbox",
    providerStyleOwner: "mapbox",
    providerStyleId: "satellite-v9",
    maxzoom: 22,
    ext: "jpg",
    secretName: "MAPBOX_ACCESS_TOKEN",
    attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  },
  {
    id: "esri-world-imagery",
    label: "Esri World Imagery",
    provider: "arcgis",
    upstreamBaseUrl: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile",
    maxzoom: 19,
    ext: "jpg",
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>'
  },
  {
    id: "usgs-topo",
    label: "USGS Topo",
    provider: "arcgis",
    upstreamBaseUrl: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile",
    maxzoom: 23,
    ext: "png",
    attribution: "USGS The National Map"
  }
];

const STYLE_PATH = /^\/maps\/styles\/([a-z0-9-]+)\.json$/;
const TILE_PATH = /^\/maps\/tiles\/([a-z0-9-]+)\/(\d+)\/(\d+)\/(\d+)\.(png|jpg|webp)$/;

class WorkerHTTPError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string | number | boolean | null>;

  constructor(status: number, code: string, message: string, details: Record<string, string | number | boolean | null> = {}) {
    super(message);
    this.name = "WorkerHTTPError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleCommandRequest(request, env);
  }
} satisfies ExportedHandler<Env>;

export async function handleCommandRequest(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/maps" || url.pathname.startsWith("/maps/")) {
      return await handleMapRequest(request, env, url);
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      const atlasBaseUrl = requiredString(env.ATLAS_CORE_BASE_URL, "ATLAS_CORE_BASE_URL");
      const mapSources = availableMapSources(env).map(mapSourceConfig);
      if (mapSources.length === 0) {
        throw new WorkerHTTPError(500, "CONFIGURATION_ERROR", "No map sources are configured");
      }
      return jsonResponse({
        atlasBaseUrl: atlasBaseUrl.replace(/\/+$/, ""),
        protocolRevision: ATLAS_PROTOCOL_REVISION,
        defaultMapSourceId: defaultMapSourceId(mapSources),
        mapSources
      });
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "API route not found", { path: url.pathname });
    }
    if (
      url.pathname === "/auth" ||
      url.pathname.startsWith("/auth/") ||
      url.pathname === "/admin/auth" ||
      url.pathname.startsWith("/admin/auth/") ||
      url.pathname === "/admin/api-keys" ||
      url.pathname.startsWith("/admin/api-keys/") ||
      url.pathname === "/me/settings" ||
      url.pathname === "/atlas" ||
      url.pathname.startsWith("/atlas/")
    ) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "Route is owned by Atlas Core or has been removed", { path: url.pathname });
    }
    return await env.ASSETS.fetch(request);
  } catch (error) {
    return errorResponse(error, request);
  }
}

async function handleMapRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new WorkerHTTPError(405, "METHOD_NOT_ALLOWED", "Map routes only support GET and HEAD");
  }
  const styleMatch = url.pathname.match(STYLE_PATH);
  if (styleMatch) {
    const source = availableMapSource(env, styleMatch[1]);
    if (!source) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "Map style route not found", { path: url.pathname });
    }
    return jsonResponse(rasterStyle(source));
  }
  const tileMatch = url.pathname.match(TILE_PATH);
  if (tileMatch) {
    const [, sourceId, zText, xText, yText, ext] = tileMatch;
    const source = availableMapSource(env, sourceId);
    if (!source) {
      throw new WorkerHTTPError(404, "NOT_FOUND", "Map tile route not found", { path: url.pathname });
    }
    return await proxyTileRequest(request, env, source, {
      z: Number(zText),
      x: Number(xText),
      y: Number(yText),
      ext: ext as TileExtension
    });
  }
  throw new WorkerHTTPError(404, "NOT_FOUND", "Map route not found", { path: url.pathname });
}

function availableMapSources(env: Env): MapSource[] {
  return MAP_SOURCES.filter((source) => !source.secretName || optionalString(env[source.secretName]));
}

function availableMapSource(env: Env, sourceId: string): MapSource | undefined {
  return availableMapSources(env).find((source) => source.id === sourceId);
}

function mapSourceConfig(source: MapSource): MapSourceConfig {
  return {
    id: source.id,
    label: source.label,
    styleUrl: `/maps/styles/${source.id}.json`
  };
}

function defaultMapSourceId(mapSources: MapSourceConfig[]): string {
  return mapSources.find((source) => source.id === "maptiler-osm-dark")?.id ?? mapSources[0].id;
}

function rasterStyle(source: MapSource): StyleSpecification {
  return {
    version: 8,
    sources: {
      [source.id]: {
        type: "raster",
        tiles: [`/maps/tiles/${source.id}/{z}/{x}/{y}.${source.ext}`],
        tileSize: 256,
        maxzoom: source.maxzoom,
        attribution: source.attribution
      }
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#070a0f" } },
      {
        id: `${source.id}-raster`,
        type: "raster",
        source: source.id,
        paint: {
          "raster-opacity": source.id === "maptiler-osm-dark" ? 0.92 : 0.84,
          "raster-saturation": source.id.includes("satellite") || source.id.includes("imagery") ? -0.14 : 0,
          "raster-contrast": source.id === "usgs-topo" ? 0.08 : 0
        }
      }
    ]
  };
}

async function proxyTileRequest(
  request: Request,
  env: Env,
  source: MapSource,
  tile: { z: number; x: number; y: number; ext: TileExtension }
): Promise<Response> {
  validateTile(source, tile);
  return await fetch(upstreamTileUrl(env, source, tile), {
    method: request.method,
    headers: { Accept: request.headers.get("Accept") ?? "image/*,*/*;q=0.8" }
  });
}

function validateTile(source: MapSource, tile: { z: number; x: number; y: number; ext: TileExtension }): void {
  if (tile.ext !== source.ext) {
    throw new WorkerHTTPError(404, "NOT_FOUND", "Map tile route not found");
  }
  if (!Number.isInteger(tile.z) || tile.z < 0 || tile.z > source.maxzoom) {
    throw new WorkerHTTPError(400, "INVALID_TILE", "Map tile zoom is out of range", { source: source.id, z: tile.z });
  }
  const maxIndex = 2 ** tile.z - 1;
  if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 || tile.y < 0 || tile.x > maxIndex || tile.y > maxIndex) {
    throw new WorkerHTTPError(400, "INVALID_TILE", "Map tile coordinates are out of range", { source: source.id, z: tile.z, x: tile.x, y: tile.y });
  }
}

function upstreamTileUrl(env: Env, source: MapSource, tile: { z: number; x: number; y: number }): string {
  if (source.provider === "maptiler") {
    const key = requiredMapSecret(env, source);
    return `https://api.maptiler.com/maps/${requiredSourceField(source.providerMapId, source.id)}/256/${tile.z}/${tile.x}/${tile.y}.${source.ext}?key=${encodeURIComponent(key)}`;
  }
  if (source.provider === "mapbox") {
    const token = requiredMapSecret(env, source);
    return `https://api.mapbox.com/styles/v1/${requiredSourceField(source.providerStyleOwner, source.id)}/${requiredSourceField(source.providerStyleId, source.id)}/tiles/256/${tile.z}/${tile.x}/${tile.y}?access_token=${encodeURIComponent(token)}`;
  }
  return `${requiredSourceField(source.upstreamBaseUrl, source.id)}/${tile.z}/${tile.y}/${tile.x}`;
}

function requiredMapSecret(env: Env, source: MapSource): string {
  if (!source.secretName) {
    throw new WorkerHTTPError(500, "CONFIGURATION_ERROR", `${source.id} does not declare a provider secret`);
  }
  const value = optionalString(env[source.secretName]);
  if (value) return value;
  throw new WorkerHTTPError(404, "NOT_FOUND", "Map source is not configured", { source: source.id });
}

function requiredSourceField(value: string | undefined, sourceId: string): string {
  if (value) return value;
  throw new WorkerHTTPError(500, "CONFIGURATION_ERROR", "Map source is missing upstream configuration", { source: sourceId });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new WorkerHTTPError(500, "CONFIGURATION_ERROR", `${name} is not configured`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof WorkerHTTPError) {
    if (error.status >= 500) {
      console.error("Atlas command interface Worker error", {
        code: error.code,
        message: error.message,
        path: new URL(request.url).pathname
      });
    }
    const body: APIErrorResponse = {
      success: false,
      error_code: error.code,
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {})
    };
    return jsonResponse(body, { status: error.status });
  }
  console.error("Atlas command interface Worker unhandled error", {
    message: error instanceof Error ? error.message : String(error),
    path: new URL(request.url).pathname
  });
  return jsonResponse(
    {
      success: false,
      error_code: "INTERNAL_ERROR",
      message: "Unexpected Worker error"
    } satisfies APIErrorResponse,
    { status: 500 }
  );
}
