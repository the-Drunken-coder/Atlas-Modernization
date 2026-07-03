import { afterEach, describe, expect, it, vi } from "vitest";
import { ATLAS_PROTOCOL_REVISION } from "../../../atlas_sdk/src/index.js";
import { appConfigFromEnv, fetchAppConfig } from "./config.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("appConfigFromEnv", () => {
  it("uses the local Core URL during Vite development", () => {
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });

    const config = appConfigFromEnv({ DEV: true, MODE: "development" });
    expect(config).toMatchObject({
      atlasBaseUrl: "http://127.0.0.1:8000",
      protocolRevision: ATLAS_PROTOCOL_REVISION,
      defaultMapSourceId: "openstreetmap-default"
    });
    expect(config.mapSources.map(({ id, style, unavailableReason }) => ({ id, available: Boolean(style), unavailableReason }))).toEqual([
      { id: "google-satellite", available: false, unavailableReason: "missing key" },
      { id: "microsoft-imagery", available: false, unavailableReason: "missing key" },
      { id: "openstreetmap-default", available: true, unavailableReason: undefined },
      { id: "usgs-topo", available: true, unavailableReason: undefined },
      { id: "mapbox-satellite", available: false, unavailableReason: "missing key" },
      { id: "mapbox-outdoors", available: false, unavailableReason: "missing key" },
      { id: "mapbox-dark", available: false, unavailableReason: "missing key" },
      { id: "thunderforest-outdoors", available: false, unavailableReason: "missing key" },
      { id: "maptiler-satellite", available: false, unavailableReason: "missing key" },
      { id: "maptiler-osm-dark", available: false, unavailableReason: "missing key" },
      { id: "openmaptiles-dark-matter", available: true, unavailableReason: undefined }
    ]);
  });

  it("uses the same-site production Core alias outside development", () => {
    vi.stubGlobal("location", { origin: "https://atlasinterface.com" });

    expect(appConfigFromEnv({ DEV: false, MODE: "production" })).toMatchObject({
      atlasBaseUrl: "https://api.atlasinterface.com",
      protocolRevision: ATLAS_PROTOCOL_REVISION,
      defaultMapSourceId: "openstreetmap-default"
    });
  });

  it("adds credentialed map sources when their provider env vars are present", () => {
    const config = appConfigFromEnv({
      DEV: true,
      VITE_BING_MAPS_KEY: " bing-key ",
      VITE_GOOGLE_MAPS_API_KEY: " google-key ",
      VITE_GOOGLE_MAPS_TILE_SESSION: " google-session ",
      VITE_MAPBOX_ACCESS_TOKEN: " mapbox-token ",
      VITE_MAPTILER_API_KEY: " maptiler-key ",
      VITE_THUNDERFOREST_API_KEY: " thunderforest-key "
    });

    expect(config.defaultMapSourceId).toBe("google-satellite");
    expect(config.mapSources.map((source) => source.id)).toEqual([
      "google-satellite",
      "microsoft-imagery",
      "openstreetmap-default",
      "usgs-topo",
      "mapbox-satellite",
      "mapbox-outdoors",
      "mapbox-dark",
      "thunderforest-outdoors",
      "maptiler-satellite",
      "maptiler-osm-dark",
      "openmaptiles-dark-matter"
    ]);
    expect(config.mapSources.every((source) => source.style)).toBe(true);
    expect(JSON.stringify(config.mapSources.find((source) => source.id === "google-satellite")?.style)).toContain("session=google-session&key=google-key");
    expect(JSON.stringify(config.mapSources.find((source) => source.id === "microsoft-imagery")?.style)).toContain("virtualearth.net/tiles/a{quadkey}.jpeg");
  });

  it("uses Azure Maps for Microsoft imagery when only an Azure key is configured", () => {
    const config = appConfigFromEnv({ DEV: true, VITE_AZURE_MAPS_SUBSCRIPTION_KEY: " azure-key " });

    expect(JSON.stringify(config.mapSources.find((source) => source.id === "microsoft-imagery")?.style)).toContain("atlas.microsoft.com/map/tile");
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

  it("creates a Google Maps tile session when only the API key is configured", async () => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "google-key");
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ session: "session-1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    const config = await fetchAppConfig();

    expect(fetch).toHaveBeenCalledWith(
      "https://tile.googleapis.com/v1/createSession?key=google-key",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" }) })
    );
    expect(config.mapSources[0].id).toBe("google-satellite");
    expect(JSON.stringify(config.mapSources[0].style)).toContain("session=session-1&key=google-key");
  });
});
