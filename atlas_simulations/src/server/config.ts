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
  const port = portValue(env.ATLAS_SIM_PORT);
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
    values[match[1]] = unquote(normalizeEnvValue(match[2]));
  }
  return values;
}

function stringValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function portValue(value: string | undefined): number {
  const trimmed = stringValue(value);
  if (!trimmed) return 5180;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("ATLAS_SIM_PORT must be a valid TCP port");
  }
  return parsed;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === quote && trimmed[index - 1] !== "\\") {
        return trimmed.slice(0, index + 1);
      }
    }
    return trimmed;
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}
