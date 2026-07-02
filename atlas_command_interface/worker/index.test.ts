import { describe, expect, it, vi } from "vitest";
import { handleCommandRequest } from "./index.js";

describe("thin Worker", () => {
  it("serves browser config with only public map sources when provider secrets are absent", async () => {
    const response = await handleCommandRequest(new Request("https://command.test/api/config"), env());

    expect(response.status).toBe(200);
    const config = await json(response);
    expect(config).toMatchObject({
      atlasBaseUrl: "https://core.test",
      protocolRevision: expect.any(String),
      defaultMapSourceId: "esri-world-imagery",
      mapSources: [
        { id: "esri-world-imagery", label: "Esri World Imagery", styleUrl: "/maps/styles/esri-world-imagery.json" },
        { id: "usgs-topo", label: "USGS Topo", styleUrl: "/maps/styles/usgs-topo.json" }
      ]
    });
    expect(JSON.stringify(config)).not.toContain("MAPTILER_API_KEY");
    expect(JSON.stringify(config)).not.toContain("MAPBOX_ACCESS_TOKEN");
  });

  it("includes configured provider-backed map sources without exposing secret values", async () => {
    const response = await handleCommandRequest(
      new Request("https://command.test/api/config"),
      env({ MAPTILER_API_KEY: "test-maptiler-key", MAPBOX_ACCESS_TOKEN: "test-mapbox-token" })
    );

    expect(response.status).toBe(200);
    const config = await json(response);
    expect(config.defaultMapSourceId).toBe("maptiler-osm-dark");
    expect((config.mapSources as Array<{ id: string }>).map((source) => source.id)).toEqual([
      "maptiler-osm-dark",
      "maptiler-satellite",
      "mapbox-satellite",
      "esri-world-imagery",
      "usgs-topo"
    ]);
    expect(JSON.stringify(config)).not.toContain("test-maptiler-key");
    expect(JSON.stringify(config)).not.toContain("test-mapbox-token");
  });

  it("returns generated raster style JSON for available map sources", async () => {
    const response = await handleCommandRequest(new Request("https://command.test/maps/styles/esri-world-imagery.json"), env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 8,
      sources: {
        "esri-world-imagery": {
          type: "raster",
          tiles: ["/maps/tiles/esri-world-imagery/{z}/{x}/{y}.jpg"],
          tileSize: 256,
          maxzoom: 19
        }
      },
      layers: [{ id: "background" }, { id: "esri-world-imagery-raster", type: "raster", source: "esri-world-imagery" }]
    });
  });

  it("does not serve styles for missing-secret map sources", async () => {
    const response = await handleCommandRequest(new Request("https://command.test/maps/styles/maptiler-osm-dark.json"), env());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ success: false, error_code: "NOT_FOUND" });
  });

  it("proxies public ArcGIS map tiles using z/y/x upstream ordering", async () => {
    const tileFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("tile", { headers: { "Content-Type": "image/png" } }));

    try {
      const response = await handleCommandRequest(new Request("https://command.test/maps/tiles/usgs-topo/6/19/24.png", { headers: { Accept: "image/png" } }), env());

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("tile");
      expect(tileFetch).toHaveBeenCalledWith("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/6/24/19", {
        method: "GET",
        headers: { Accept: "image/png" }
      });
    } finally {
      tileFetch.mockRestore();
    }
  });

  it("injects MapTiler and Mapbox provider secrets only in upstream tile requests", async () => {
    const tileFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("tile"));

    try {
      await handleCommandRequest(
        new Request("https://command.test/maps/tiles/maptiler-osm-dark/6/19/24.png"),
        env({ MAPTILER_API_KEY: "test maptiler key", MAPBOX_ACCESS_TOKEN: "test mapbox token" })
      );
      await handleCommandRequest(
        new Request("https://command.test/maps/tiles/mapbox-satellite/6/19/24.jpg"),
        env({ MAPTILER_API_KEY: "test maptiler key", MAPBOX_ACCESS_TOKEN: "test mapbox token" })
      );

      expect(tileFetch).toHaveBeenNthCalledWith(
        1,
        "https://api.maptiler.com/maps/dataviz-v4-dark/256/6/19/24.png?key=test%20maptiler%20key",
        expect.objectContaining({ method: "GET" })
      );
      expect(tileFetch).toHaveBeenNthCalledWith(
        2,
        "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/256/6/19/24?access_token=test%20mapbox%20token",
        expect.objectContaining({ method: "GET" })
      );
    } finally {
      tileFetch.mockRestore();
    }
  });

  it("rejects invalid map routes and tile requests", async () => {
    for (const [path, status] of [
      ["/maps/styles/unknown.json", 404],
      ["/maps/tiles/unknown/6/19/24.png", 404],
      ["/maps/tiles/maptiler-osm-dark/6/19/24.png", 404],
      ["/maps/tiles/usgs-topo/6/19/24.jpg", 404],
      ["/maps/tiles/usgs-topo/24/19/24.png", 400],
      ["/maps/tiles/usgs-topo/6/999/24.png", 400]
    ] as const) {
      const response = await handleCommandRequest(new Request(`https://command.test${path}`), env());
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ success: false });
    }

    const methodResponse = await handleCommandRequest(new Request("https://command.test/maps/styles/usgs-topo.json", { method: "POST" }), env());
    expect(methodResponse.status).toBe(405);
  });

  it("does not own auth, api key, settings, or Atlas proxy routes", async () => {
    for (const path of ["/auth/login", "/admin/auth/login", "/admin/api-keys", "/me/settings", "/atlas/entities"]) {
      const response = await handleCommandRequest(new Request(`https://command.test${path}`), env());
      expect(response.status).toBe(404);
    }
  });

  it("returns JSON 404 for unknown API routes", async () => {
    for (const path of ["/api", "/api/missing"]) {
      const response = await handleCommandRequest(new Request(`https://command.test${path}`), env());
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ success: false, error_code: "NOT_FOUND" });
    }
  });

  it("falls through to static assets", async () => {
    const assets = vi.fn(async () => new Response("asset"));
    const response = await handleCommandRequest(new Request("https://command.test/"), env({ ASSETS: { fetch: assets } }));

    expect(await response.text()).toBe("asset");
    expect(assets).toHaveBeenCalledOnce();
  });

  it("logs 5xx worker errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await handleCommandRequest(new Request("https://command.test/api/config"), env({ ATLAS_CORE_BASE_URL: "" }));

      expect(response.status).toBe(500);
      expect(log).toHaveBeenCalledWith(
        "Atlas command interface Worker error",
        expect.objectContaining({ code: "CONFIGURATION_ERROR", path: "/api/config" })
      );
    } finally {
      log.mockRestore();
    }
  });

  it("does not expose unexpected exception messages in 500 responses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await handleCommandRequest(
        new Request("https://command.test/static"),
        env({
          ASSETS: {
            fetch: async () => {
              throw new Error("internal secret detail");
            }
          }
        })
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error_code: "INTERNAL_ERROR",
        message: "Unexpected Worker error"
      });
    } finally {
      log.mockRestore();
    }
  });
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    ATLAS_CORE_BASE_URL: "https://core.test/",
    ...overrides
  };
}

async function json(response: Response): Promise<{ [key: string]: unknown; mapSources?: unknown[]; defaultMapSourceId?: unknown }> {
  return (await response.json()) as { [key: string]: unknown; mapSources?: unknown[]; defaultMapSourceId?: unknown };
}
