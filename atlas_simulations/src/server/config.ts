import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SimulationConfig = {
  atlasBaseUrl: string;
  atlasApiKey?: string;
  atlasTargets?: AtlasTargetConfig[];
  defaultAtlasTargetId?: string;
  port: number;
  packageRoot: string;
};

export type AtlasTargetConfig = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
};

const LOCAL_TARGET_ID = "local";
const DEPLOYED_TARGET_ID = "deployed";
const DEFAULT_LOCAL_BASE_URL = "http://localhost:8000";
const DEFAULT_DEPLOYED_BASE_URL = "https://atlascommandapi.org";

export function packageRootFromModule(metaUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "../..");
}

export function loadConfig(options: { env?: NodeJS.ProcessEnv; packageRoot?: string } = {}): SimulationConfig {
  const packageRoot = options.packageRoot ?? packageRootFromModule();
  const fileEnv = readEnvFile(path.join(packageRoot, ".env"));
  const runtimeEnv = options.env ?? process.env;
  const configuredBaseUrl = stringValue(runtimeEnv.ATLAS_BASE_URL) ?? stringValue(fileEnv.ATLAS_BASE_URL);
  const atlasBaseUrl = atlasBaseUrlValue(configuredBaseUrl ?? DEFAULT_LOCAL_BASE_URL);
  const atlasApiKey = stringValue(runtimeEnv.ATLAS_API_KEY) ?? stringValue(fileEnv.ATLAS_API_KEY);
  const localBaseUrl = atlasBaseUrlValue(
    stringValue(runtimeEnv.ATLAS_LOCAL_BASE_URL) ??
      stringValue(fileEnv.ATLAS_LOCAL_BASE_URL) ??
      (isLoopbackUrl(atlasBaseUrl) ? atlasBaseUrl : DEFAULT_LOCAL_BASE_URL)
  );
  const deployedBaseUrl = atlasBaseUrlValue(
    stringValue(runtimeEnv.ATLAS_DEPLOYED_BASE_URL) ??
      stringValue(fileEnv.ATLAS_DEPLOYED_BASE_URL) ??
      (isLoopbackUrl(atlasBaseUrl) ? DEFAULT_DEPLOYED_BASE_URL : atlasBaseUrl)
  );
  const localApiKey = stringValue(runtimeEnv.ATLAS_LOCAL_API_KEY) ?? stringValue(fileEnv.ATLAS_LOCAL_API_KEY) ?? (sameAtlasBaseUrl(localBaseUrl, atlasBaseUrl) ? atlasApiKey : undefined);
  const deployedApiKey =
    stringValue(runtimeEnv.ATLAS_DEPLOYED_API_KEY) ?? stringValue(fileEnv.ATLAS_DEPLOYED_API_KEY) ?? (sameAtlasBaseUrl(deployedBaseUrl, atlasBaseUrl) ? atlasApiKey : undefined);
  const defaultAtlasTargetId = targetIdValue(
    stringValue(runtimeEnv.ATLAS_SIM_TARGET) ??
      stringValue(fileEnv.ATLAS_SIM_TARGET) ??
      (sameAtlasBaseUrl(deployedBaseUrl, atlasBaseUrl) && !isLoopbackUrl(atlasBaseUrl) ? DEPLOYED_TARGET_ID : LOCAL_TARGET_ID)
  );
  const port = portValue(stringValue(runtimeEnv.ATLAS_SIM_PORT) ?? stringValue(fileEnv.ATLAS_SIM_PORT));
  return {
    atlasBaseUrl,
    ...(atlasApiKey ? { atlasApiKey } : {}),
    atlasTargets: [
      {
        id: LOCAL_TARGET_ID,
        label: "Local Core",
        baseUrl: localBaseUrl,
        ...(localApiKey ? { apiKey: localApiKey } : {})
      },
      {
        id: DEPLOYED_TARGET_ID,
        label: "Atlas Command API",
        baseUrl: deployedBaseUrl,
        ...(deployedApiKey ? { apiKey: deployedApiKey } : {})
      }
    ],
    defaultAtlasTargetId,
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

function targetIdValue(value: string): string {
  if (value !== LOCAL_TARGET_ID && value !== DEPLOYED_TARGET_ID) {
    throw new Error(`ATLAS_SIM_TARGET must be ${LOCAL_TARGET_ID} or ${DEPLOYED_TARGET_ID}`);
  }
  return value;
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

function sameAtlasBaseUrl(left: string, right: string): boolean {
  return left === right;
}

function isLoopbackUrl(value: string): boolean {
  return isLoopbackHost(new URL(value).hostname);
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
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuotedValue(value.slice(1, -1));
  }
  return value;
}

function normalizeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return "";
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === quote && (quote === "'" || !isEscaped(trimmed, index))) {
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

function unescapeDoubleQuotedValue(value: string): string {
  return value.replace(/\\([\\"nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function isEscaped(value: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}
