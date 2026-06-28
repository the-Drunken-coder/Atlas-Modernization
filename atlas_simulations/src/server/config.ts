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
  const runtimeEnv = options.env ?? process.env;
  const atlasBaseUrl = atlasBaseUrlValue(stringValue(runtimeEnv.ATLAS_BASE_URL) ?? stringValue(fileEnv.ATLAS_BASE_URL) ?? "http://localhost:8000");
  const atlasApiKey = stringValue(runtimeEnv.ATLAS_API_KEY) ?? stringValue(fileEnv.ATLAS_API_KEY);
  const port = portValue(stringValue(runtimeEnv.ATLAS_SIM_PORT) ?? stringValue(fileEnv.ATLAS_SIM_PORT));
  return {
    atlasBaseUrl,
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
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
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
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("ATLAS_SIM_PORT must be a valid TCP port");
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1 || parsed > 65535) {
    throw new Error("ATLAS_SIM_PORT must be a valid TCP port");
  }
  return parsed;
}

function atlasBaseUrlValue(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ATLAS_BASE_URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ATLAS_BASE_URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("ATLAS_BASE_URL must use HTTPS unless it targets loopback");
  }
  if (parsed.username || parsed.password) {
    throw new Error("ATLAS_BASE_URL must not include embedded credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("ATLAS_BASE_URL must not include a query string or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || isIPv4Loopback(normalized);
}

function isIPv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const quote = value[0];
    return value.slice(1, -1).replace(new RegExp(`\\\\${quote}`, "g"), quote);
  }
  return value;
}

function normalizeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === quote && !isEscaped(trimmed, index)) {
        const remainder = trimmed.slice(index + 1).trim();
        if (remainder && !remainder.startsWith("#")) {
          throw new Error("Invalid quoted value in .env");
        }
        return trimmed.slice(0, index + 1);
      }
    }
    throw new Error("Unterminated quoted value in .env");
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function isEscaped(value: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}
