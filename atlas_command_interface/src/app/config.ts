export type AppConfig = {
  atlasBaseUrl: string;
  protocolRevision: string;
  mapStyleUrl?: string;
};

const CONFIG_URL_BASE = "http://localhost";
const URL_SCHEME = /^[a-z][a-z\d+\-.]*:/i;

/** Load non-secret runtime config from the same-origin Worker. */
export async function fetchAppConfig(signal?: AbortSignal): Promise<AppConfig> {
  const response = await fetch("/api/config", { headers: { Accept: "application/json" }, signal });
  if (!response.ok) {
    throw new Error(`Failed to load /api/config (${response.status})`);
  }
  const data = (await response.json()) as Partial<AppConfig>;
  if (typeof data.atlasBaseUrl !== "string" || typeof data.protocolRevision !== "string") {
    throw new Error("/api/config returned an unexpected shape");
  }
  return {
    atlasBaseUrl: parseConfigUrl(data.atlasBaseUrl, "atlasBaseUrl").replace(/\/$/, ""),
    protocolRevision: data.protocolRevision,
    mapStyleUrl: typeof data.mapStyleUrl === "string" && data.mapStyleUrl.trim() !== "" ? parseConfigUrl(data.mapStyleUrl, "mapStyleUrl") : undefined
  };
}

function parseConfigUrl(value: string, field: keyof Pick<AppConfig, "atlasBaseUrl" | "mapStyleUrl">): string {
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
