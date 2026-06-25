import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SYMBOL_CATALOG,
  DEFAULT_SYMBOL_FALLBACK,
  DEFAULT_SYMBOL_TYPE_MAPPING,
  type SymbolConfig
} from "./catalog.js";
import { __internals, createSidcIconService, renderSymbolToSvg } from "./sidc-symbol-service.js";

describe("SIDC symbol service", () => {
  let service: ReturnType<typeof createSidcIconService>;

  beforeEach(() => {
    service = createSidcIconService({
      symbolCatalog: DEFAULT_SYMBOL_CATALOG,
      typeMapping: DEFAULT_SYMBOL_TYPE_MAPPING,
      fallback: DEFAULT_SYMBOL_FALLBACK
    });
  });

  it("uses the old Atlas SIDC catalog to render SVG symbols", () => {
    const result = renderSymbolToSvg({
      sidc: DEFAULT_SYMBOL_CATALOG.DRONE.sidc,
      size: DEFAULT_SYMBOL_CATALOG.DRONE.size ?? DEFAULT_SYMBOL_FALLBACK.size,
      options: DEFAULT_SYMBOL_CATALOG.DRONE.options
    });

    expect(result.isFallback).toBe(false);
    expect(result.html).toContain("<svg");
    expect(result.size.width).toBeGreaterThan(0);
    expect(result.size.height).toBeGreaterThan(0);
  });

  it("maps current Atlas asset hints onto the inherited catalog", () => {
    expect(service.getAssetSymbol({ subtype: "ground_rover" }).sidc).toBe(DEFAULT_SYMBOL_CATALOG.ROVER.sidc);
    expect(service.getAssetSymbol({ subtype: "uas" }).sidc).toBe(DEFAULT_SYMBOL_CATALOG.DRONE.sidc);
    expect(service.getAssetSymbol({ entityId: "relay-03", entityType: "asset" }).sidc).toBe(DEFAULT_SYMBOL_CATALOG.SIGNAL.sidc);
  });

  it("maps track types to person, dog, and vehicle symbols", () => {
    expect(service.getTrackSymbol({ type: "Blue Team" }).sidc).toBe(DEFAULT_SYMBOL_CATALOG.PERSON.sidc);
    expect(service.getTrackSymbol({ type: "k9" }).sidc).toBe(DEFAULT_SYMBOL_CATALOG.DOG.sidc);
    expect(service.getTrackSymbol({ type: "unknown vehicle" }).sidc).toBe(DEFAULT_SYMBOL_CATALOG.CAR.sidc);
  });

  it("does not match partial substrings inside larger words", () => {
    const mapping = __internals.buildLookup(DEFAULT_SYMBOL_TYPE_MAPPING);
    expect(__internals.resolveConfigKey({ subtype: "cargo" }, mapping, DEFAULT_SYMBOL_TYPE_MAPPING.default)).toBe(
      DEFAULT_SYMBOL_TYPE_MAPPING.default
    );
    expect(__internals.mapTrackTypeToConfigKey("command", mapping, DEFAULT_SYMBOL_TYPE_MAPPING.default)).toBe(
      DEFAULT_SYMBOL_TYPE_MAPPING.default
    );
  });

  it("returns detached copies for configs and cached renders", () => {
    const configs = service.getSymbolConfigs();
    configs.DRONE.options = { fill: false, frame: false };
    expect(service.getSymbolConfigs().DRONE.options).toEqual(DEFAULT_SYMBOL_CATALOG.DRONE.options);

    const first = service.render(service.getAssetSymbol({ subtype: "uas" }));
    first.size.width = 0;
    first.anchor.x = 0;
    const second = service.render(service.getAssetSymbol({ subtype: "uas" }));
    expect(second.size.width).toBeGreaterThan(0);
    expect(second.anchor.x).toBeGreaterThan(0);
  });

  it("snapshots caller-owned config at service creation", () => {
    const symbolCatalog: Record<string, SymbolConfig> = Object.fromEntries(
      Object.entries(DEFAULT_SYMBOL_CATALOG).map(([key, config]) => [key, { ...config, options: config.options ? { ...config.options } : undefined }])
    );
    const typeMapping = { ...DEFAULT_SYMBOL_TYPE_MAPPING };
    const localService = createSidcIconService({ symbolCatalog, typeMapping, fallback: DEFAULT_SYMBOL_FALLBACK });

    symbolCatalog.DRONE = DEFAULT_SYMBOL_CATALOG.CAR;
    typeMapping.uas = "CAR";

    expect(localService.getAssetSymbol({ subtype: "uas" }).sidc).toBe(DEFAULT_SYMBOL_CATALOG.DRONE.sidc);
  });

  it("uses fallback markup when SIDC Kit cannot render the selected symbol", () => {
    const result = renderSymbolToSvg({ sidc: "999999999999999999999999999999", size: 24 });
    expect(result.isFallback).toBe(true);
    expect(result.html).toContain("atlas-symbol-svg--fallback");
    expect(result.error).toBeTruthy();
  });

  it("sanitizes numeric render options before writing inline styles", () => {
    const result = renderSymbolToSvg(
      {
        sidc: DEFAULT_SYMBOL_CATALOG.DRONE.sidc,
        size: DEFAULT_SYMBOL_CATALOG.DRONE.size ?? DEFAULT_SYMBOL_FALLBACK.size,
        options: DEFAULT_SYMBOL_CATALOG.DRONE.options
      },
      {
        opacity: "1; background-image: url(javascript:alert(1))" as unknown as number,
        rotation: "0deg); } </style><script>alert(1)</script>" as unknown as number
      }
    );

    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain("javascript:");
    expect(result.html).toContain("opacity: 1");
    expect(result.html).toContain("rotate(0deg)");
  });
});
