import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAppConfig } from "./config.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchAppConfig", () => {
  it("normalises configured URLs and map source style URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        configResponse({
          atlasBaseUrl: "https://core.test/",
          protocolRevision: "rev",
          defaultMapSourceId: "maptiler-osm-dark",
          mapSources: [{ id: "maptiler-osm-dark", label: " MapTiler OSM Dark ", styleUrl: " /maps/styles/maptiler-osm-dark.json " }]
        })
      )
    );
    vi.stubGlobal("location", { origin: "https://command.test" });

    await expect(fetchAppConfig()).resolves.toEqual({
      atlasBaseUrl: "https://core.test",
      protocolRevision: "rev",
      defaultMapSourceId: "maptiler-osm-dark",
      mapSources: [{ id: "maptiler-osm-dark", label: "MapTiler OSM Dark", styleUrl: "https://command.test/maps/styles/maptiler-osm-dark.json" }]
    });
  });

  it("rejects invalid URL fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        configResponse({
          atlasBaseUrl: "atlas",
          protocolRevision: "rev",
          defaultMapSourceId: "esri-world-imagery",
          mapSources: [{ id: "esri-world-imagery", label: "Esri", styleUrl: "/maps/styles/esri-world-imagery.json" }]
        })
      )
    );

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned invalid atlasBaseUrl");
  });

  it("rejects invalid map source style URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        configResponse({
          atlasBaseUrl: "https://core.test",
          protocolRevision: "rev",
          defaultMapSourceId: "esri-world-imagery",
          mapSources: [{ id: "esri-world-imagery", label: "Esri", styleUrl: "http://[bad" }]
        })
      )
    );

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned invalid styleUrl");
  });

  it("rejects empty protocol revisions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        configResponse({
          atlasBaseUrl: "https://core.test",
          protocolRevision: "   ",
          defaultMapSourceId: "esri-world-imagery",
          mapSources: [{ id: "esri-world-imagery", label: "Esri", styleUrl: "/maps/styles/esri-world-imagery.json" }]
        })
      )
    );

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned empty protocolRevision");
  });

  it("rejects missing or empty map sources", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(configResponse({ atlasBaseUrl: "https://core.test", protocolRevision: "rev", defaultMapSourceId: "missing" }))
      .mockResolvedValueOnce(configResponse({ atlasBaseUrl: "https://core.test", protocolRevision: "rev", defaultMapSourceId: "missing", mapSources: [] }));
    vi.stubGlobal("fetch", fetch);

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned an unexpected shape");
    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned no mapSources");
  });

  it("rejects a default map source that is not in the available list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        configResponse({
          atlasBaseUrl: "https://core.test",
          protocolRevision: "rev",
          defaultMapSourceId: "maptiler-osm-dark",
          mapSources: [{ id: "esri-world-imagery", label: "Esri", styleUrl: "/maps/styles/esri-world-imagery.json" }]
        })
      )
    );

    await expect(fetchAppConfig()).rejects.toThrow("/api/config returned invalid defaultMapSourceId");
  });
});

function configResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
