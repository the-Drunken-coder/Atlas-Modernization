import { renderSymbol, type RenderSymbolOptions } from "sidc-kit";
import {
  DEFAULT_SYMBOL_CATALOG,
  DEFAULT_SYMBOL_FALLBACK,
  DEFAULT_SYMBOL_TYPE_MAPPING,
  type SymbolConfig,
  type SymbolStyleOptions
} from "./catalog.js";

export type SymbolInfo = {
  sidc: string;
  size: number;
  options?: SymbolStyleOptions;
};

export type AssetSymbolDescriptor = {
  entityId?: string;
  entityType?: string;
  modelId?: string;
  assetType?: string;
  symbolType?: string;
  subtype?: string;
};

export type TrackSymbolDescriptor = {
  type?: string;
};

export type SymbolRenderOptions = {
  selected?: boolean;
  opacity?: number;
  rotation?: number;
};

export type RenderedSymbol = {
  html: string;
  size: { width: number; height: number };
  anchor: { x: number; y: number };
  className: string;
  isFallback: boolean;
  error?: string;
};

export type SidcSymbolServiceConfig = {
  symbolCatalog: Record<string, SymbolConfig>;
  typeMapping: Record<string, string>;
  fallback?: SymbolInfo;
};

type NormalizedMappingEntry = {
  rawKey: string;
  normalized: string;
  configKey: string;
  tokens: string[];
};

const DEFAULT_CLASS_NAME = "atlas-sidc-icon";
const MAX_RENDER_CACHE_SIZE = 300;

function normalizeToken(value?: string): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function prepareCandidateForMatching(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .toLowerCase();
}

function splitCandidateTokens(value: string): string[] {
  return prepareCandidateForMatching(value)
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function containsTokenSequence(candidateTokens: string[], patternTokens: string[]): boolean {
  if (patternTokens.length === 0 || candidateTokens.length === 0 || candidateTokens.length < patternTokens.length) {
    return false;
  }

  const lastStart = candidateTokens.length - patternTokens.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < patternTokens.length; offset += 1) {
      if (candidateTokens[start + offset] !== patternTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function buildLookup(mapping: Record<string, string>): NormalizedMappingEntry[] {
  return Object.entries(mapping).map(([rawKey, configKey]) => ({
    rawKey,
    normalized: normalizeToken(rawKey),
    configKey,
    tokens: splitCandidateTokens(rawKey)
  }));
}

function resolveConfigKey(asset: AssetSymbolDescriptor, mapping: NormalizedMappingEntry[], defaultKey?: string): string | undefined {
  const { subtype, symbolType, assetType, modelId, entityType, entityId } = asset;
  const candidates = [subtype, symbolType, assetType, modelId, entityType, entityId];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const candidateTokens = splitCandidateTokens(candidate);
    const hit = mapping.find((entry) => entry.rawKey !== "default" && containsTokenSequence(candidateTokens, entry.tokens));
    if (hit) return hit.configKey;
  }

  return defaultKey;
}

function mapTrackTypeToConfigKey(trackType: string | undefined, mapping: NormalizedMappingEntry[], defaultKey?: string): string | undefined {
  if (!trackType) return defaultKey;
  const normalized = normalizeToken(trackType);
  const directHit = mapping.find((entry) => entry.rawKey !== "default" && entry.normalized === normalized);
  if (directHit) return directHit.configKey;

  const candidateTokens = splitCandidateTokens(trackType);
  const tokenHit = mapping.find(
    (entry) => entry.rawKey !== "default" && entry.tokens.length === 1 && candidateTokens.includes(entry.tokens[0])
  );
  if (tokenHit) return tokenHit.configKey;

  return defaultKey;
}

function cloneSymbolInfo(symbol: SymbolInfo): SymbolInfo {
  return {
    sidc: symbol.sidc,
    size: symbol.size,
    options: symbol.options ? { ...symbol.options } : undefined
  };
}

function cloneSymbolConfig(config: SymbolConfig): SymbolConfig {
  return {
    sidc: config.sidc,
    size: config.size,
    options: config.options ? { ...config.options } : undefined
  };
}

function cloneRenderedSymbol(symbol: RenderedSymbol): RenderedSymbol {
  return {
    html: symbol.html,
    size: { ...symbol.size },
    anchor: { ...symbol.anchor },
    className: symbol.className,
    isFallback: symbol.isFallback,
    ...(symbol.error ? { error: symbol.error } : {})
  };
}

function deriveSymbolInfo(configKey: string | undefined, catalog: Record<string, SymbolConfig>, fallback: SymbolInfo): SymbolInfo {
  if (!configKey) return cloneSymbolInfo(fallback);
  const config = catalog[configKey];
  if (!config) return cloneSymbolInfo(fallback);
  const size = config.size ?? fallback.size;
  return {
    sidc: config.sidc,
    size,
    options: config.options ? { ...config.options } : undefined
  };
}

function sanitizeFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim() === "") return fallback;
  let numberValue: number;
  try {
    numberValue = Number(value);
  } catch {
    return fallback;
  }
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeRenderOptions(options: SymbolRenderOptions = {}) {
  return {
    selected: options.selected ?? false,
    opacity: sanitizeFiniteNumber(options.opacity ?? 1, 1),
    rotation: sanitizeFiniteNumber(options.rotation ?? 0, 0)
  };
}

function buildSymbolMarkup(symbolInfo: SymbolInfo, options: SymbolRenderOptions = {}): RenderedSymbol {
  const normalized = normalizeRenderOptions(options);
  const safeSize = sanitizeFiniteNumber(symbolInfo.size, DEFAULT_SYMBOL_FALLBACK.size);
  const symbolOptions: RenderSymbolOptions = { ...symbolInfo.options, size: safeSize };
  const rendered = renderSymbol(symbolInfo.sidc, symbolOptions);
  const size = {
    width: sanitizeFiniteNumber(rendered.size?.width, safeSize),
    height: sanitizeFiniteNumber(rendered.size?.height, safeSize)
  };
  const anchor = {
    x: sanitizeFiniteNumber(rendered.anchor?.x, size.width / 2),
    y: sanitizeFiniteNumber(rendered.anchor?.y, size.height / 2)
  };
  const selectedStyle = normalized.selected ? "filter: drop-shadow(0 0 8px rgba(255, 215, 0, 0.8));" : "";

  return {
    html: `
      <div class="atlas-symbol-svg" style="
        width: ${size.width}px;
        height: ${size.height}px;
        opacity: ${normalized.opacity};
        transform: rotate(${normalized.rotation}deg);
        ${selectedStyle}
      ">
        ${rendered.svg}
      </div>
    `.trim(),
    size,
    anchor,
    className: DEFAULT_CLASS_NAME,
    isFallback: false
  };
}

function buildFallbackMarkup(symbolInfo: SymbolInfo, options: SymbolRenderOptions = {}, error?: unknown): RenderedSymbol {
  const normalized = normalizeRenderOptions(options);
  const safeSize = sanitizeFiniteNumber(symbolInfo.size, DEFAULT_SYMBOL_FALLBACK.size);
  const selectedStyle = normalized.selected ? "box-shadow: 0 0 8px rgba(255, 215, 0, 0.8); border-color: #ffd700;" : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message)
        : error
          ? String(error)
          : undefined;

  return {
    html: `
      <div class="atlas-symbol-svg atlas-symbol-svg--fallback" style="
        width: ${safeSize}px;
        height: ${safeSize}px;
        opacity: ${normalized.opacity};
        transform: rotate(${normalized.rotation}deg);
        ${selectedStyle}
      "></div>
    `.trim(),
    size: { width: safeSize, height: safeSize },
    anchor: { x: safeSize / 2, y: safeSize / 2 },
    className: `${DEFAULT_CLASS_NAME} ${DEFAULT_CLASS_NAME}--fallback`,
    isFallback: true,
    error: message
  };
}

export function renderSymbolToSvg(symbolInfo: SymbolInfo, options: SymbolRenderOptions = {}): RenderedSymbol {
  try {
    return buildSymbolMarkup(symbolInfo, options);
  } catch (error) {
    return buildFallbackMarkup(symbolInfo, options, error);
  }
}

export function createSidcIconService(config: SidcSymbolServiceConfig) {
  const fallback = cloneSymbolInfo(config.fallback ?? DEFAULT_SYMBOL_FALLBACK);
  const lookup = buildLookup(config.typeMapping);
  const defaultKey = config.typeMapping.default;
  const renderCache = new Map<string, RenderedSymbol>();

  function render(symbolInfo: SymbolInfo, options: SymbolRenderOptions = {}): RenderedSymbol {
    const key = JSON.stringify({ sidc: symbolInfo.sidc, size: symbolInfo.size, options: symbolInfo.options, renderOptions: options });
    const cached = renderCache.get(key);
    if (cached) return cloneRenderedSymbol(cached);
    const rendered = renderSymbolToSvg(symbolInfo, options);
    renderCache.set(key, rendered);
    if (renderCache.size > MAX_RENDER_CACHE_SIZE) {
      const toDelete = Math.floor(MAX_RENDER_CACHE_SIZE / 2);
      let count = 0;
      for (const cachedKey of renderCache.keys()) {
        if (count >= toDelete) break;
        renderCache.delete(cachedKey);
        count += 1;
      }
    }
    return cloneRenderedSymbol(rendered);
  }

  function getAssetSymbol(asset: AssetSymbolDescriptor): SymbolInfo {
    return deriveSymbolInfo(resolveConfigKey(asset, lookup, defaultKey), config.symbolCatalog, fallback);
  }

  function getTrackSymbol(track: TrackSymbolDescriptor): SymbolInfo {
    return deriveSymbolInfo(mapTrackTypeToConfigKey(track.type, lookup, defaultKey), config.symbolCatalog, fallback);
  }

  function preload(): void {
    for (const entry of Object.values(config.symbolCatalog)) {
      if (!entry.sidc) continue;
      try {
        renderSymbol(entry.sidc, { ...entry.options, size: entry.size ?? fallback.size });
      } catch {
        // Invalid optional catalog entries should not block the console shell.
      }
    }
  }

  return {
    getAssetSymbol,
    getTrackSymbol,
    getAvailableSymbols: () => Object.keys(config.typeMapping).filter((key) => key !== "default"),
    getSymbolConfigs: () =>
      Object.fromEntries(Object.entries(config.symbolCatalog).map(([key, symbolConfig]) => [key, cloneSymbolConfig(symbolConfig)])),
    render,
    preload
  };
}

export const defaultSidcIconService = createSidcIconService({
  symbolCatalog: DEFAULT_SYMBOL_CATALOG,
  typeMapping: DEFAULT_SYMBOL_TYPE_MAPPING,
  fallback: DEFAULT_SYMBOL_FALLBACK
});

export const __internals = {
  buildLookup,
  containsTokenSequence,
  mapTrackTypeToConfigKey,
  resolveConfigKey,
  sanitizeFiniteNumber
};
