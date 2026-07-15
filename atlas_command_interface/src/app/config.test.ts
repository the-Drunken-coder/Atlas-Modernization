import { afterEach, describe, expect, it, vi } from "vitest";
import { ATLAS_PROTOCOL_REVISION } from "@the-drunken-coder/atlas-sdk";
import { appConfigFromEnv, coreConfigFromEnv, fetchAppConfig } from "./config.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("appConfigFromEnv", () => {
  it("uses the local Core URL during Vite development", () => {
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });

    const config = appConfigFromEnv({ DEV: true, MODE: "development" });
    expect(config).toMatchObject({
      atlasBaseUrl: "http://127.0.0.1:8000",
      protocolRevision: ATLAS_PROTOCOL_REVISION,
      defaultMapSourceId: "maptiler-osm-dark"
    });
    expect(config.mapSources.map(({ id, style, unavailableReason }) => ({ id, available: Boolean(style), unavailableReason }))).toEqual([
      { id: "google-satellite", available: false, unavailableReason: "missing key" },
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
      defaultMapSourceId: "maptiler-osm-dark"
    });
  });

  it("uses MapTiler OSM Dark as the default when it is available", () => {
    const config = appConfigFromEnv({ DEV: false, MODE: "production", VITE_MAPTILER_API_KEY: "maptiler-key" });

    expect(config.defaultMapSourceId).toBe("maptiler-osm-dark");
    expect(config.mapSources.find((source) => source.id === "maptiler-osm-dark")).toMatchObject({ label: "MapTiler OSM Dark" });
  });

  it("keeps MapTiler OSM Dark as the configured default when it is unavailable", () => {
    const config = appConfigFromEnv({ DEV: false, MODE: "production" });

    expect(config.defaultMapSourceId).toBe("maptiler-osm-dark");
    expect(config.mapSources.find((source) => source.id === "maptiler-osm-dark")).toMatchObject({
      label: "MapTiler OSM Dark",
      unavailableReason: "missing key"
    });
  });

  it("does not override the configured default when the Google session is unavailable", () => {
    expect(
      appConfigFromEnv({
        DEV: false,
        MODE: "production",
        VITE_GOOGLE_MAPS_API_KEY: "google-key",
        VITE_MAPBOX_ACCESS_TOKEN: "mapbox-token"
      }).defaultMapSourceId
    ).toBe("maptiler-osm-dark");
  });

  it("adds credentialed map sources when their provider env vars are present", () => {
    const config = appConfigFromEnv({
      DEV: true,
      VITE_GOOGLE_MAPS_API_KEY: " google-key ",
      googleMapsTileSession: " google-session ",
      VITE_MAPBOX_ACCESS_TOKEN: " mapbox-token ",
      VITE_MAPTILER_API_KEY: " maptiler-key ",
      VITE_THUNDERFOREST_API_KEY: " thunderforest-key "
    });

    expect(config.defaultMapSourceId).toBe("maptiler-osm-dark");
    expect(config.mapSources.map((source) => source.id)).toEqual([
      "google-satellite",
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
  });

  it("generates valid MapLibre raster styles for every available map source", () => {
    const config = appConfigFromEnv({
      DEV: true,
      VITE_GOOGLE_MAPS_API_KEY: "google-key",
      googleMapsTileSession: "google-session",
      VITE_MAPBOX_ACCESS_TOKEN: "mapbox-token",
      VITE_MAPTILER_API_KEY: "maptiler-key",
      VITE_THUNDERFOREST_API_KEY: "thunderforest-key"
    });
    const expectedUrlFragments: Record<string, string> = {
      "google-satellite": "session=google-session&key=google-key",
      "openstreetmap-default": "tile.openstreetmap.org",
      "usgs-topo": "basemap.nationalmap.gov",
      "mapbox-satellite": "access_token=mapbox-token",
      "mapbox-outdoors": "access_token=mapbox-token",
      "mapbox-dark": "access_token=mapbox-token",
      "thunderforest-outdoors": "apikey=thunderforest-key",
      "maptiler-satellite": "key=maptiler-key",
      "maptiler-osm-dark": "key=maptiler-key",
      "openmaptiles-dark-matter": "basemaps.cartocdn.com"
    };

    for (const source of config.mapSources) {
      expect(source.style, source.id).toBeDefined();
      const style = source.style!;
      const rasterSource = style.sources[source.id] as { type?: string; tiles?: string[] } | undefined;
      expect(style.version).toBe(8);
      expect(Object.keys(style.sources).length).toBeGreaterThan(0);
      expect(style.layers.length).toBeGreaterThan(0);
      expect(rasterSource?.type).toBe("raster");
      expect(rasterSource?.tiles?.length).toBeGreaterThan(0);
      expect(style.layers).toEqual(expect.arrayContaining([expect.objectContaining({ type: "raster", source: source.id })]));
      expect(JSON.stringify(rasterSource?.tiles)).toContain(expectedUrlFragments[source.id]);
    }
  });

  it("allows an explicit Core URL override", () => {
    vi.stubGlobal("location", { origin: "https://preview.example" });

    expect(appConfigFromEnv({ DEV: false, MODE: "production", VITE_ATLAS_CORE_BASE_URL: " https://core.test/ " }).atlasBaseUrl).toBe("https://core.test");
  });

  it("falls back to the default Core URL when the explicit env value is blank", () => {
    expect(appConfigFromEnv({ DEV: true, MODE: "development", VITE_ATLAS_CORE_BASE_URL: " " }).atlasBaseUrl).toBe("http://127.0.0.1:8000");
  });

  it("rejects invalid explicit Core URLs", () => {
    expect(() => appConfigFromEnv({ DEV: false, VITE_ATLAS_CORE_BASE_URL: "atlas" })).toThrow("Atlas interface config has invalid atlasBaseUrl");
  });
});

describe("coreConfigFromEnv", () => {
  it("resolves Core settings without initializing map providers", () => {
    expect(coreConfigFromEnv({ DEV: false, MODE: "production", VITE_GOOGLE_MAPS_API_KEY: "google-key" })).toEqual({
      atlasBaseUrl: "https://api.atlasinterface.com",
      protocolRevision: ATLAS_PROTOCOL_REVISION
    });
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

  it.each([
    ["network failure", async () => Promise.reject(new Error("network down"))],
    ["non-OK response", async () => new Response("unavailable", { status: 503 })],
    ["invalid JSON", async () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } })],
    ["missing session token", async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })]
  ])("keeps Google unavailable and preserves the configured default on tile-session %s", async (_name, fetchImpl) => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "google-key");
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(fetchImpl);
    vi.stubGlobal("fetch", fetch);

    const config = await fetchAppConfig();

    expect(fetch).toHaveBeenCalledWith("https://tile.googleapis.com/v1/createSession?key=google-key", expect.objectContaining({ method: "POST" }));
    expect(config.defaultMapSourceId).toBe("maptiler-osm-dark");
    expect(config.mapSources[0]).toMatchObject({ id: "google-satellite", style: undefined, unavailableReason: "session unavailable" });
    expect(config.mapSources.find((source) => source.id === "maptiler-osm-dark")).toMatchObject({ unavailableReason: "missing key" });
    expect(warn).toHaveBeenCalled();
  });
});
