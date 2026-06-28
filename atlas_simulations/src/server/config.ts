import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SimulationConfig = {
  atlasBaseUrl: string;
  atlasApiKey?: string;
  port: number;
  packageRoot: string;
};

export function packageRootFromModule(metaUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "../..");
}

export function loadConfig(options: { env?: NodeJS.ProcessEnv; packageRoot?: string } = {}): SimulationConfig {
  const packageRoot = options.packageRoot ?? packageRootFromModule();
  const fileEnv = readEnvFile(path.join(packageRoot, ".env"));
  const env = { ...fileEnv, ...(options.env ?? process.env) };
  const atlasBaseUrl = stringValue(env.ATLAS_BASE_URL) ?? "http://localhost:8000";
  const atlasApiKey = stringValue(env.ATLAS_API_KEY);
  const port = numberValue(env.ATLAS_SIM_PORT) ?? 5180;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ATLAS_SIM_PORT must be a valid TCP port");
  }
  return {
    atlasBaseUrl: atlasBaseUrl.replace(/\/+$/, ""),
    ...(atlasApiKey ? { atlasApiKey } : {}),
    port,
    packageRoot
  };
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

function stringValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function numberValue(value: string | undefined): number | undefined {
  const trimmed = stringValue(value);
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
