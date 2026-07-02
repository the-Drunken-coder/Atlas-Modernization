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

/** Load non-secret runtime config from the same-origin Worker. */
export async function fetchAppConfig(signal?: AbortSignal): Promise<AppConfig> {
  const response = await fetch("/api/config", { headers: { Accept: "application/json" }, signal });
  if (!response.ok) {
    throw new Error(`Failed to load /api/config (${response.status})`);
  }
  const data = await response.json();
  if (!isConfigPayload(data)) {
    throw new Error("/api/config returned an unexpected shape");
  }
  if (typeof data.atlasBaseUrl !== "string" || typeof data.protocolRevision !== "string") {
    throw new Error("/api/config returned an unexpected shape");
  }
  const protocolRevision = data.protocolRevision.trim();
  if (!protocolRevision) {
    throw new Error("/api/config returned empty protocolRevision");
  }
  const atlasBaseUrl = parseConfigUrl(data.atlasBaseUrl, "atlasBaseUrl").replace(/\/$/, "");
  const mapSources = data.mapSources.map(parseMapSource);
  if (mapSources.length === 0) {
    throw new Error("/api/config returned no mapSources");
  }
  const defaultMapSourceId = data.defaultMapSourceId.trim();
  if (!defaultMapSourceId || !mapSources.some((source) => source.id === defaultMapSourceId)) {
    throw new Error("/api/config returned invalid defaultMapSourceId");
  }
  return {
    atlasBaseUrl,
    protocolRevision,
    defaultMapSourceId,
    mapSources
  };
}

function isConfigPayload(value: unknown): value is {
  atlasBaseUrl: string;
  protocolRevision: string;
  defaultMapSourceId: string;
  mapSources: unknown[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { atlasBaseUrl?: unknown }).atlasBaseUrl === "string" &&
    typeof (value as { protocolRevision?: unknown }).protocolRevision === "string" &&
    typeof (value as { defaultMapSourceId?: unknown }).defaultMapSourceId === "string" &&
    Array.isArray((value as { mapSources?: unknown }).mapSources)
  );
}

function parseMapSource(value: unknown): MapSourceConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { label?: unknown }).label !== "string" ||
    typeof (value as { styleUrl?: unknown }).styleUrl !== "string"
  ) {
    throw new Error("/api/config returned invalid mapSources");
  }
  const id = (value as { id: string }).id.trim();
  const label = (value as { label: string }).label.trim();
  if (!id || !label) {
    throw new Error("/api/config returned invalid mapSources");
  }
  return {
    id,
    label,
    styleUrl: parseConfigUrl((value as { styleUrl: string }).styleUrl, "styleUrl")
  };
}

function parseConfigUrl(value: string, field: "atlasBaseUrl" | "styleUrl"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`/api/config returned empty ${field}`);
  if (!URL_SCHEME.test(trimmed) && !trimmed.startsWith("/")) {
    throw new Error(`/api/config returned invalid ${field}`);
  }
  try {
    return new URL(trimmed, configUrlBase()).toString();
  } catch {
    throw new Error(`/api/config returned invalid ${field}`);
  }
}

function configUrlBase(): string {
  return globalThis.location?.origin ?? CONFIG_URL_BASE;
}
