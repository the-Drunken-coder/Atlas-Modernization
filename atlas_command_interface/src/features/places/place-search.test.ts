import { describe, expect, it, vi } from "vitest";
import { createMapTilerPlaceSearch } from "./place-search.js";

describe("MapTiler place search", () => {
  it("encodes autocomplete requests and maps point and area targets", async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({
        type: "FeatureCollection",
        attribution: "© MapTiler © OpenStreetMap contributors",
        features: [
          {
            id: "poi.1",
            text: "Worcester Polytechnic Institute",
            place_name: "Worcester Polytechnic Institute, Worcester, Massachusetts, United States",
            center: [-71.8063, 42.2746],
            place_type: ["poi"]
          },
          {
            id: "municipality.2",
            text: "Worcester",
            place_name: "Worcester, Massachusetts, United States",
            center: [-71.8023, 42.2626],
            bbox: [-71.96, 42.18, -71.71, 42.35],
            place_type: ["municipality"]
          },
          { id: "invalid", text: "Missing coordinates" }
        ]
      })
    );
    const controller = new AbortController();
    const search = createMapTilerPlaceSearch(" key /?& ", fetch);

    const response = await search("Worcester Polytechnic", controller.signal);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.maptiler.com/geocoding/Worcester%20Polytechnic.json?key=key+%2F%3F%26&limit=5&autocomplete=true"
    );
    expect(init).toEqual({ signal: controller.signal });
    expect(response).toEqual({
      attribution: "© MapTiler © OpenStreetMap contributors",
      results: [
        {
          id: "poi.1",
          name: "Worcester Polytechnic Institute",
          context: "Worcester, Massachusetts, United States",
          coordinates: [-71.8063, 42.2746],
          target: {
            type: "point",
            id: "place:poi.1",
            coordinates: [-71.8063, 42.2746],
            label: "Worcester Polytechnic Institute"
          }
        },
        {
          id: "municipality.2",
          name: "Worcester",
          context: "Massachusetts, United States",
          coordinates: [-71.8023, 42.2626],
          target: {
            type: "geometry",
            id: "place:municipality.2",
            label: "Worcester",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-71.96, 42.18],
                  [-71.71, 42.18],
                  [-71.71, 42.35],
                  [-71.96, 42.35],
                  [-71.96, 42.18]
                ]
              ]
            }
          }
        }
      ]
    });
  });

  it("uses a valid point geometry when center is absent", async () => {
    const search = createMapTilerPlaceSearch(
      "key",
      vi.fn(async () =>
        Response.json({
          type: "FeatureCollection",
          attribution: "© MapTiler",
          features: [
            {
              id: "address.1",
              text: "100 Institute Road",
              geometry: { type: "Point", coordinates: [-71.8063, 42.2746] }
            }
          ]
        })
      )
    );

    await expect(search("100 Institute Road", new AbortController().signal)).resolves.toMatchObject({
      results: [{ coordinates: [-71.8063, 42.2746], target: { type: "point" } }]
    });
  });

  it.each([
    [403, "Place search is not authorized."],
    [503, "Place search failed."]
  ])("maps HTTP %s to an operator-safe error", async (status, message) => {
    const search = createMapTilerPlaceSearch(
      "key",
      vi.fn(async () => new Response(null, { status }))
    );

    await expect(search("Worcester", new AbortController().signal)).rejects.toThrow(message);
  });

  it("does not expose a failed request URL or API key", async () => {
    const search = createMapTilerPlaceSearch(
      "secret-key",
      vi.fn(async () => {
        throw new Error("https://api.maptiler.com/geocoding/Worcester.json?key=secret-key");
      })
    );

    await expect(search("Worcester", new AbortController().signal)).rejects.toThrow("Place search failed.");
  });

  it("rejects malformed successful responses", async () => {
    const search = createMapTilerPlaceSearch(
      "key",
      vi.fn(async () => Response.json({ features: [] }))
    );

    await expect(search("Worcester", new AbortController().signal)).rejects.toThrow(
      "Place search returned an invalid response."
    );
  });
});
