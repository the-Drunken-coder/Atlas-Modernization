import { ATLAS_PROTOCOL_REVISION } from "../../../atlas_sdk/src/index.js";

export type MapSourceConfig = {
  id: string;
  label: string;
  styleUrl: string;
};

export type AppConfig = {
  atlasBaseUrl: string;
  protocolRevision: string;
  defaultMapSourceId: string;
  mapSources: MapSourceConfig[];
};

const CONFIG_URL_BASE = "http://localhost";
const URL_SCHEME = /^[a-z][a-z\d+\-.]*:/i;
const LOCAL_CORE_BASE_URL = "http://127.0.0.1:8000";
const REMOTE_CORE_BASE_URL = "https://atlascommandapi.org";

const MAP_SOURCES: MapSourceConfig[] = [
  { id: "esri-world-imagery", label: "Esri World Imagery", styleUrl: "/maps/styles/esri-world-imagery.json" },
  { id: "usgs-topo", label: "USGS Topo", styleUrl: "/maps/styles/usgs-topo.json" }
];

type RuntimeEnv = {
  DEV?: boolean;
  MODE?: string;
  VITE_ATLAS_CORE_BASE_URL?: string;
};

/** Build the non-secret browser config from Vite env plus static public assets. */
export async function fetchAppConfig(): Promise<AppConfig> {
  return appConfigFromEnv(import.meta.env);
}

export function appConfigFromEnv(env: RuntimeEnv): AppConfig {
  const atlasBaseUrl = parseConfigUrl(env.VITE_ATLAS_CORE_BASE_URL ?? defaultCoreBaseUrl(env), "atlasBaseUrl").replace(/\/$/, "");
  const mapSources = MAP_SOURCES.map(parseMapSource);
  if (mapSources.length === 0) {
    throw new Error("Atlas interface config has no mapSources");
  }
  const defaultMapSourceId = "esri-world-imagery";
  if (!defaultMapSourceId || !mapSources.some((source) => source.id === defaultMapSourceId)) {
    throw new Error("Atlas interface config has an invalid defaultMapSourceId");
  }
  return {
    atlasBaseUrl,
    protocolRevision: ATLAS_PROTOCOL_REVISION,
    defaultMapSourceId,
    mapSources
  };
}

function defaultCoreBaseUrl(env: RuntimeEnv): string {
  return env.DEV || env.MODE === "development" ? LOCAL_CORE_BASE_URL : REMOTE_CORE_BASE_URL;
}

function parseMapSource(value: unknown): MapSourceConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { label?: unknown }).label !== "string" ||
    typeof (value as { styleUrl?: unknown }).styleUrl !== "string"
  ) {
    throw new Error("Atlas interface config has invalid mapSources");
  }
  const id = (value as { id: string }).id.trim();
  const label = (value as { label: string }).label.trim();
  if (!id || !label) {
    throw new Error("Atlas interface config has invalid mapSources");
  }
  return {
    id,
    label,
    styleUrl: parseConfigUrl((value as { styleUrl: string }).styleUrl, "styleUrl")
  };
}

function parseConfigUrl(value: string, field: "atlasBaseUrl" | "styleUrl"): string {
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
