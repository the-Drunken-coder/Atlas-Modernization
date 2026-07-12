export type ConnectorConfig = {
  baseUrl: string;
  apiKey?: string;
  connectorId: string;
  intervalMs: number;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const intervalMs = Number(env.ATLAS_CONNECTOR_INTERVAL_MS ?? "2000");
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 2_147_483_647) {
    throw new Error("ATLAS_CONNECTOR_INTERVAL_MS must be an integer from 250 to 2147483647");
  }

  const connectorId = env.ATLAS_CONNECTOR_ID?.trim() || "connector-adsb-demo";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/.test(connectorId)) throw new Error("ATLAS_CONNECTOR_ID must be a valid Atlas ID of at most 50 characters");

  const apiKey = env.ATLAS_API_KEY?.trim();
  return {
    baseUrl: (env.ATLAS_BASE_URL?.trim() || "http://127.0.0.1:8000").replace(/\/+$/, ""),
    ...(apiKey ? { apiKey } : {}),
    connectorId,
    intervalMs
  };
}
