import { describe, expect, it, vi } from "vitest";
import { FIT_BOUNDS_PADDING } from "./map-camera.js";
import {
  chooseGeographicZoomTarget,
  fetchMapTilerGeographicTargets,
  GEOGRAPHIC_FIT_MAX_ZOOM,
  type GeographicZoomTarget,
  geographicTypesForZoom
} from "./map-geography.js";

describe("geographicTypesForZoom", () => {
  it("moves from countries to regions and local places as the map gets closer", () => {
    expect(geographicTypesForZoom(2)).toEqual(["country", "major_landform"]);
    expect(geographicTypesForZoom(5)).toEqual(["major_landform", "region", "country"]);
    expect(geographicTypesForZoom(7)).toContain("subregion");
    expect(geographicTypesForZoom(9)).toContain("municipality");
    expect(geographicTypesForZoom(12)).toContain("place");
  });
});

describe("fetchMapTilerGeographicTargets", () => {
  it("requests scale-appropriate features and returns them in preference order", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        features: [
          { text: "Massachusetts", place_type: ["region"], bbox: [-73.5, 41.2, -69.8, 42.9] },
          { text: "Martha's Vineyard", place_type: ["major_landform"], bbox: [-70.9, 41.3, -70.4, 41.6] },
          { text: "Outside", place_type: ["country"], bbox: [10, 10, 20, 20] },
          { text: "Broken", place_type: ["region"], bbox: [0, 0, "east", 10] }
        ]
      })
    );

    const targets = await fetchMapTilerGeographicTargets({
      apiKey: "map key/&",
      coordinates: [-70.6, 41.45],
      zoom: 5,
      signal: new AbortController().signal,
      fetcher
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.maptiler.com/geocoding/-70.6,41.45.json?key=map+key%2F%26&types=major_landform%2Cregion%2Ccountry"
    );
    expect(init).toMatchObject({ headers: { Accept: "application/json" } });
    expect(targets).toEqual([
      {
        bounds: [
          [-70.9, 41.3],
          [-70.4, 41.6]
        ],
        label: "Martha's Vineyard",
        type: "major_landform"
      },
      {
        bounds: [
          [-73.5, 41.2],
          [-69.8, 42.9]
        ],
        label: "Massachusetts",
        type: "region"
      }
    ]);
  });

  it("fails closed on a non-success response", async () => {
    await expect(
      fetchMapTilerGeographicTargets({
        apiKey: "key",
        coordinates: [0, 0],
        zoom: 2,
        signal: new AbortController().signal,
        fetcher: vi.fn(async () => new Response(null, { status: 403 }))
      })
    ).rejects.toThrow("MapTiler geographic lookup failed (403)");
  });
});

describe("chooseGeographicZoomTarget", () => {
  const island: GeographicZoomTarget = {
    bounds: [
      [-70.9, 41.3],
      [-70.4, 41.6]
    ],
    type: "major_landform"
  };
  const region: GeographicZoomTarget = {
    bounds: [
      [-73.5, 41.2],
      [-69.8, 42.9]
    ],
    type: "region"
  };

  it("skips a broad landform that would not move closer and uses the next feature", () => {
    const cameraForBounds = vi.fn((bounds: GeographicZoomTarget["bounds"]) => ({
      zoom: bounds === island.bounds ? 5.1 : 7.2
    }));

    expect(chooseGeographicZoomTarget({ getZoom: () => 5, cameraForBounds }, [island, region])).toBe(region);
    expect(cameraForBounds).toHaveBeenCalledWith(island.bounds, {
      maxZoom: GEOGRAPHIC_FIT_MAX_ZOOM,
      padding: FIT_BOUNDS_PADDING
    });
  });

  it("keeps a small island when fitting it produces a real zoom", () => {
    const cameraForBounds = vi.fn(() => ({ zoom: 11 }));
    expect(chooseGeographicZoomTarget({ getZoom: () => 6, cameraForBounds }, [island, region])).toBe(island);
  });
});
