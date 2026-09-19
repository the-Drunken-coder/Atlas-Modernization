import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";

export type AssetLinkConfig =
  | { transport: "serial"; port: string; baud: number }
  | { transport: "tcp"; host: string; port: number };

export type AssetConfig = {
  coreUrl: string;
  apiKey: string;
  assetId: string;
  link: AssetLinkConfig;
  vehicleSystemId: number;
  vehicleComponentId: number;
  coreLossGraceSeconds: number;
  telemetryIntervalSeconds: number;
  arrivalRadiusM: number;
  altitudeToleranceM: number;
  hoverSettleSeconds: number;
  progressTimeoutSeconds: number;
  taskTimeoutSeconds: number;
  minBatteryPercent: number;
  shutdownConfirmSeconds: number;
};

const DEFAULTS = {
  baud: 57600,
  coreLossGraceSeconds: 5,
  telemetryIntervalSeconds: 1,
  arrivalRadiusM: 1.5,
  altitudeToleranceM: 1.0,
  hoverSettleSeconds: 3,
  progressTimeoutSeconds: 30,
  taskTimeoutSeconds: 300,
  minBatteryPercent: 20,
  shutdownConfirmSeconds: 5
} as const;

function fail(message: string): never {
  throw new Error(`Invalid Asset configuration: ${message}`);
}

function requiredSection(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`missing [${name}] section`);
  }
  return value as Record<string, unknown>;
}

function requiredString(section: Record<string, unknown>, sectionName: string, key: string): string {
  const value = section[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`[${sectionName}] ${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNumber(
  section: Record<string, unknown>,
  sectionName: string,
  key: string,
  fallback: number,
  minimum: number
): number {
  const value = section[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    fail(`[${sectionName}] ${key} must be a number >= ${minimum}`);
  }
  return value;
}

function optionalInteger(
  section: Record<string, unknown>,
  sectionName: string,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = optionalNumber(section, sectionName, key, fallback, minimum);
  if (!Number.isInteger(value) || value > maximum) {
    fail(`[${sectionName}] ${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Parse startup configuration from TOML text. The file is read once at
 * process startup; edits while running never change flight behavior.
 */
export function parseAssetConfig(text: string): AssetConfig {
  let document: unknown;
  try {
    document = parseToml(text);
  } catch (cause) {
    fail(`not valid TOML: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const root = requiredSection(document, "");
  const core = requiredSection(root["core"], "core");
  const asset = requiredSection(root["asset"], "asset");
  const link = requiredSection(root["link"], "link");
  const vehicle = requiredSection(root["vehicle"], "vehicle");
  const execution = root["execution"] === undefined ? {} : requiredSection(root["execution"], "execution");

  const coreUrl = requiredString(core, "core", "url");
  if (!/^https?:\/\//.test(coreUrl)) {
    fail("[core] url must start with http:// or https://");
  }
  const linkConfig = parseLinkConfig(link);

  return {
    coreUrl: coreUrl.replace(/\/+$/, ""),
    apiKey: requiredString(core, "core", "api_key"),
    assetId: requiredString(asset, "asset", "id"),
    link: linkConfig,
    vehicleSystemId: optionalInteger(vehicle, "vehicle", "system_id", 1, 1, 255),
    vehicleComponentId: optionalInteger(vehicle, "vehicle", "component_id", 1, 1, 255),
    coreLossGraceSeconds: optionalNumber(
      execution,
      "execution",
      "core_loss_grace_seconds",
      DEFAULTS.coreLossGraceSeconds,
      1
    ),
    telemetryIntervalSeconds: optionalNumber(
      execution,
      "execution",
      "telemetry_interval_seconds",
      DEFAULTS.telemetryIntervalSeconds,
      0.25
    ),
    arrivalRadiusM: optionalNumber(execution, "execution", "arrival_radius_m", DEFAULTS.arrivalRadiusM, 0.1),
    altitudeToleranceM: optionalNumber(
      execution,
      "execution",
      "altitude_tolerance_m",
      DEFAULTS.altitudeToleranceM,
      0.1
    ),
    hoverSettleSeconds: optionalNumber(execution, "execution", "hover_settle_seconds", DEFAULTS.hoverSettleSeconds, 1),
    progressTimeoutSeconds: optionalNumber(
      execution,
      "execution",
      "progress_timeout_seconds",
      DEFAULTS.progressTimeoutSeconds,
      5
    ),
    taskTimeoutSeconds: optionalNumber(execution, "execution", "task_timeout_seconds", DEFAULTS.taskTimeoutSeconds, 30),
    minBatteryPercent: optionalNumber(execution, "execution", "min_battery_percent", DEFAULTS.minBatteryPercent, 0),
    shutdownConfirmSeconds: optionalNumber(
      execution,
      "execution",
      "shutdown_confirm_seconds",
      DEFAULTS.shutdownConfirmSeconds,
      1
    )
  };
}

function parseLinkConfig(link: Record<string, unknown>): AssetLinkConfig {
  const transport = link["transport"];
  if (transport === "tcp") {
    return {
      transport: "tcp",
      host: typeof link["host"] === "string" && link["host"].trim() !== "" ? link["host"].trim() : "127.0.0.1",
      port: optionalInteger(link, "link", "tcp_port", 5760, 1, 65535)
    };
  }
  if (transport === undefined || transport === "serial") {
    const port = link["port"];
    if (typeof port !== "string" || port.trim() === "") {
      fail("[link] port is required for serial transport (the SiK radio device, e.g. /dev/tty.usbserial-XXXX)");
    }
    return {
      transport: "serial",
      port: port.trim(),
      baud: optionalInteger(link, "link", "baud", DEFAULTS.baud, 1200, 921600)
    };
  }
  fail('[link] transport must be "serial" or "tcp"');
}

/** Read and parse the configuration file once at startup. */
export async function loadAssetConfig(path: string): Promise<AssetConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(
      `Cannot read Asset configuration at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  return parseAssetConfig(text);
}
