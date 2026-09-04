import { ATLAS_PROTOCOL_REVISION } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appConfigFromEnv, coreConfigFromEnv, fetchAppConfig } from "./config.js";

afterEach(() => {
  vi.useRealTimers();
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
    expect(
      config.mapSources.map(({ id, label, style, unavailableReason }) => ({
        id,
        label,
        available: Boolean(style),
        unavailableReason
      }))
    ).toEqual([
      { id: "google-satellite", label: "Google Satellite", available: false, unavailableReason: "missing key" },
      {
        id: "openstreetmap-default",
        label: "OpenStreetMap Default",
        available: true,
        unavailableReason: undefined
      },
      { id: "usgs-topo", label: "USGS Topo", available: true, unavailableReason: undefined },
      { id: "mapbox-satellite", label: "Mapbox Satellite", available: false, unavailableReason: "missing key" },
      { id: "mapbox-outdoors", label: "Mapbox Outdoors", available: false, unavailableReason: "missing key" },
      { id: "mapbox-dark", label: "Mapbox Dark", available: false, unavailableReason: "missing key" },
      {
        id: "thunderforest-outdoors",
        label: "Thunderforest Outdoors",
        available: false,
        unavailableReason: "missing key"
      },
      { id: "maptiler-satellite", label: "MapTiler Satellite", available: false, unavailableReason: "missing key" },
      { id: "maptiler-osm-dark", label: "MapTiler OSM Dark", available: false, unavailableReason: "missing key" },
      {
        id: "openmaptiles-dark-matter",
        label: "OpenMapTiles Dark Matter",
        available: true,
        unavailableReason: undefined
      }
    ]);
    expect(config.placeSearch).toEqual({ provider: "maptiler", unavailableReason: "missing key" });
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
    const source = config.mapSources.find((source) => source.id === "maptiler-osm-dark");
    expect(source).toMatchObject({ label: "MapTiler OSM Dark" });
    expect(source?.style).toBeDefined();
    expect(source?.unavailableReason).toBeUndefined();
    expect(config.placeSearch).toEqual({ provider: "maptiler", apiKey: "maptiler-key" });
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

  it("builds the exact MapLibre styles and encoded URLs for every provider", () => {
    const config = appConfigFromEnv({
      DEV: true,
      VITE_GOOGLE_MAPS_API_KEY: " google key/& ",
      googleMapsTileSession: " session /?& ",
      VITE_MAPBOX_ACCESS_TOKEN: " mapbox /?& ",
      VITE_MAPTILER_API_KEY: " maptiler /?& ",
      VITE_THUNDERFOREST_API_KEY: " thunderforest /?& "
    });
    const expected = [
      {
        id: "google-satellite",
        label: "Google Satellite",
        tiles: [
          "https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=session%20%2F%3F%26&key=google%20key%2F%26"
        ],
        maxzoom: 22,
        rasterContrast: 0
      },
      {
        id: "openstreetmap-default",
        label: "OpenStreetMap Default",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        maxzoom: 19,
        rasterContrast: 0
      },
      {
        id: "usgs-topo",
        label: "USGS Topo",
        tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"],
        maxzoom: 23,
        rasterContrast: 0.08
      },
      {
        id: "mapbox-satellite",
        label: "Mapbox Satellite",
        tiles: ["https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90?access_token=mapbox%20%2F%3F%26"],
        maxzoom: 22,
        rasterContrast: 0
      },
      {
        id: "mapbox-outdoors",
        label: "Mapbox Outdoors",
        tiles: [
          "https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/{z}/{x}/{y}?access_token=mapbox%20%2F%3F%26"
        ],
        maxzoom: 22,
        rasterContrast: 0
      },
      {
        id: "mapbox-dark",
        label: "Mapbox Dark",
        tiles: [
          "https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}?access_token=mapbox%20%2F%3F%26"
        ],
        maxzoom: 22,
        rasterContrast: 0
      },
      {
        id: "thunderforest-outdoors",
        label: "Thunderforest Outdoors",
        tiles: ["https://api.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=thunderforest%20%2F%3F%26"],
        maxzoom: 22,
        rasterContrast: 0
      },
      {
        id: "maptiler-satellite",
        label: "MapTiler Satellite",
        tiles: ["https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key=maptiler%20%2F%3F%26"],
        maxzoom: 22,
        rasterContrast: 0
      },
      {
        id: "maptiler-osm-dark",
        label: "MapTiler OSM Dark",
        tiles: ["https://api.maptiler.com/maps/openstreetmap-dark/256/{z}/{x}/{y}.png?key=maptiler%20%2F%3F%26"],
        maxzoom: 22,
        rasterContrast: 0
      },
      {
        id: "openmaptiles-dark-matter",
        label: "OpenMapTiles Dark Matter",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
        ],
        maxzoom: 20,
        rasterContrast: 0
      }
    ];

    expect(config.defaultMapSourceId).toBe("maptiler-osm-dark");
    expect(config.mapSources).toHaveLength(expected.length);
    for (const [index, provider] of expected.entries()) {
      expect(config.mapSources[index]).toEqual({
        id: provider.id,
        label: provider.label,
        style: {
          version: 8,
          sources: {
            [provider.id]: {
              type: "raster",
              tiles: provider.tiles,
              tileSize: 256,
              minzoom: undefined,
              maxzoom: provider.maxzoom
            }
          },
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#070a0f" }
            },
            {
              id: `${provider.id}-raster`,
              type: "raster",
              source: provider.id,
              paint: {
                "raster-opacity": 0.84,
                "raster-saturation": 0,
                "raster-contrast": provider.rasterContrast
              }
            }
          ]
        }
      });
    }
  });

  it("allows an explicit Core URL override", () => {
    vi.stubGlobal("location", { origin: "https://preview.example" });

    expect(
      appConfigFromEnv({ DEV: false, MODE: "production", VITE_ATLAS_CORE_BASE_URL: " https://core.test/ " })
        .atlasBaseUrl
    ).toBe("https://core.test");
  });

  it.each([
    ["https://core.test/atlas/", "https://core.test/atlas"],
    ["http://localhost:8000/atlas", "http://localhost:8000/atlas"],
    ["http://127.12.34.56:8000/atlas", "http://127.12.34.56:8000/atlas"],
    ["http://[::1]:8000/atlas", "http://[::1]:8000/atlas"],
    ["/atlas/", "/atlas"],
    ["/", "/"]
  ])("accepts safe Core base URL %s", (value, expected) => {
    expect(appConfigFromEnv({ DEV: false, MODE: "production", VITE_ATLAS_CORE_BASE_URL: value }).atlasBaseUrl).toBe(
      expected
    );
  });

  it.each([
    "http://core.example.test",
    "ftp://core.example.test",
    "javascript:alert(1)",
    "//core.example.test",
    "https://user:secret@core.example.test",
    "https://core.example.test?token=secret",
    "https://core.example.test#fragment"
  ])("rejects unsafe Core base URL %s", (value) => {
    expect(() => appConfigFromEnv({ DEV: false, MODE: "production", VITE_ATLAS_CORE_BASE_URL: value })).toThrow(
      "Atlas interface config has invalid atlasBaseUrl"
    );
  });

  it("falls back to the default Core URL when the explicit env value is blank", () => {
    expect(appConfigFromEnv({ DEV: true, MODE: "development", VITE_ATLAS_CORE_BASE_URL: " " }).atlasBaseUrl).toBe(
      "http://127.0.0.1:8000"
    );
  });

  it("rejects invalid explicit Core URLs", () => {
    expect(() => appConfigFromEnv({ DEV: false, VITE_ATLAS_CORE_BASE_URL: "atlas" })).toThrow(
      "Atlas interface config has invalid atlasBaseUrl"
    );
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
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ session: "session-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetch);

    const config = await fetchAppConfig();

    expect(fetch).toHaveBeenCalledWith(
      "https://tile.googleapis.com/v1/createSession?key=google-key",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" })
      })
    );
    expect(config.mapSources[0].id).toBe("google-satellite");
    expect(JSON.stringify(config.mapSources[0].style)).toContain("session=session-1&key=google-key");
  });

  it.each([
    ["network failure", async () => Promise.reject(new Error("network down"))],
    ["non-OK response", async () => new Response("unavailable", { status: 503 })],
    [
      "invalid JSON",
      async () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } })
    ],
    [
      "missing session token",
      async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
    ]
  ])("keeps Google unavailable and preserves the configured default on tile-session %s", async (_name, fetchImpl) => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "google-key");
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(fetchImpl);
    vi.stubGlobal("fetch", fetch);

    const config = await fetchAppConfig();

    expect(fetch).toHaveBeenCalledWith(
      "https://tile.googleapis.com/v1/createSession?key=google-key",
      expect.objectContaining({ method: "POST" })
    );
    expect(config.defaultMapSourceId).toBe("maptiler-osm-dark");
    expect(config.mapSources.find((source) => source.id === "google-satellite")).toMatchObject({
      id: "google-satellite",
      unavailableReason: "session unavailable"
    });
    expect(config.mapSources.find((source) => source.id === "maptiler-osm-dark")).toMatchObject({
      unavailableReason: "missing key"
    });
    expect(warn).toHaveBeenCalled();
  });

  it("keeps configuration loading bounded when the Google session fetch never settles", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "google-key");
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);

    const config = fetchAppConfig();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(config).resolves.toMatchObject({ defaultMapSourceId: "maptiler-osm-dark" });
    expect(fetch).toHaveBeenCalledWith(
      "https://tile.googleapis.com/v1/createSession?key=google-key",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(fetch.mock.calls[0]?.[1]?.signal).toHaveProperty("aborted", true);
    expect(warn).toHaveBeenCalledWith(
      "Google Maps satellite session request unavailable",
      expect.stringContaining("timed out")
    );
  });

  it("keeps configuration loading bounded when the Google session response body never ends", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "google-key");
    vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            }
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
    );
    vi.stubGlobal("fetch", fetch);

    const config = fetchAppConfig();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(config).resolves.toMatchObject({ defaultMapSourceId: "maptiler-osm-dark" });
    expect(fetch.mock.calls[0]?.[1]?.signal).toHaveProperty("aborted", true);
    expect(warn).toHaveBeenCalledWith(
      "Google Maps satellite session request unavailable",
      expect.stringContaining("timed out")
    );
  });
});
