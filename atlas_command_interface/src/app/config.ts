export type AppConfig = {
  atlasBaseUrl: string;
  protocolRevision: string;
  mapStyleUrl?: string;
};

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
    atlasBaseUrl: data.atlasBaseUrl,
    protocolRevision: data.protocolRevision,
    mapStyleUrl: typeof data.mapStyleUrl === "string" && data.mapStyleUrl.trim() !== "" ? data.mapStyleUrl : undefined
  };
}
