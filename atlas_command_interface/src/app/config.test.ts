import { afterEach, describe, expect, it, vi } from "vitest";
import { ATLAS_PROTOCOL_REVISION } from "../../../atlas_sdk/src/index.js";
import { appConfigFromEnv, fetchAppConfig } from "./config.js";

afterEach(() => vi.unstubAllGlobals());

describe("appConfigFromEnv", () => {
  it("uses the local Core URL during Vite development", () => {
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });

    expect(appConfigFromEnv({ DEV: true, MODE: "development" })).toEqual({
      atlasBaseUrl: "http://127.0.0.1:8000",
      protocolRevision: ATLAS_PROTOCOL_REVISION,
      defaultMapSourceId: "esri-world-imagery",
      mapSources: [
        { id: "esri-world-imagery", label: "Esri World Imagery", styleUrl: "http://127.0.0.1:5173/maps/styles/esri-world-imagery.json" },
        { id: "usgs-topo", label: "USGS Topo", styleUrl: "http://127.0.0.1:5173/maps/styles/usgs-topo.json" }
      ]
    });
  });

  it("uses the live production Core URL outside development", () => {
    vi.stubGlobal("location", { origin: "https://atlasinterface.com" });

    expect(appConfigFromEnv({ DEV: false, MODE: "production" })).toMatchObject({
      atlasBaseUrl: "https://atlascommandapi.org",
      protocolRevision: ATLAS_PROTOCOL_REVISION,
      defaultMapSourceId: "esri-world-imagery",
      mapSources: [
        { id: "esri-world-imagery", styleUrl: "https://atlasinterface.com/maps/styles/esri-world-imagery.json" },
        { id: "usgs-topo", styleUrl: "https://atlasinterface.com/maps/styles/usgs-topo.json" }
      ]
    });
  });

  it("allows an explicit Core URL override", () => {
    vi.stubGlobal("location", { origin: "https://preview.example" });

    expect(appConfigFromEnv({ DEV: false, MODE: "production", VITE_ATLAS_CORE_BASE_URL: " https://core.test/ " }).atlasBaseUrl).toBe("https://core.test");
  });

  it("rejects invalid explicit Core URLs", () => {
    expect(() => appConfigFromEnv({ DEV: false, VITE_ATLAS_CORE_BASE_URL: "atlas" })).toThrow("Atlas interface config has invalid atlasBaseUrl");
  });
});

describe("fetchAppConfig", () => {
  it("does not fetch a runtime config route", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });

    await expect(fetchAppConfig()).resolves.toMatchObject({ atlasBaseUrl: "http://127.0.0.1:8000" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
