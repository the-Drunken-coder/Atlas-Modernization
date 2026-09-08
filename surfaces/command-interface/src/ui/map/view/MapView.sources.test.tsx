import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { entityFixture } from "../../../../test/fixtures.js";
import { buildMapSources } from "../rendering/map-sources.js";
import { renderMapView, style } from "./MapView.test-harness.js";

const geofeature = entityFixture({
  entity_id: "geo-1",
  entity_type: "geofeature",
  components: { geometry: { type: "Point", coordinates: [10, 20] } }
});

describe("MapView geofeature publication", () => {
  it("skips asset-only updates and publishes changed geofeatures", () => {
    const sources = buildMapSources([geofeature], undefined);
    const { map, rerenderMap } = renderMapView({ sources });
    const sink = map.sources.get("geofeatures")!.setData;
    expect(sink).toHaveBeenLastCalledWith(sources.geofeatures);
    sink.mockClear();

    rerenderMap({ sources: { ...sources, assets: { ...sources.assets } } });
    expect(sink).not.toHaveBeenCalled();

    const selected = buildMapSources([geofeature], geofeature.entity_id);
    rerenderMap({ sources: selected });
    expect(sink).toHaveBeenCalledExactlyOnceWith(selected.geofeatures);
  });

  it("publishes the latest geometry when the initial style finishes loading", () => {
    const { map, rerenderMap } = renderMapView({ style: style("a", { initialStyleLoading: true }) });
    const sources = buildMapSources([geofeature], undefined);
    rerenderMap({ sources });
    expect(map.sources.has("geofeatures")).toBe(false);

    act(() => map.fire("style.load"));
    expect(map.sources.get("geofeatures")!.setData).toHaveBeenCalledExactlyOnceWith(sources.geofeatures);
  });

  it.each([false, true])("republishes an unchanged collection after style reload, recovery=%s", (recover) => {
    const sources = buildMapSources([geofeature], undefined);
    const { map, rerenderMap } = renderMapView({ sources, styleId: "a", style: style("a") });
    rerenderMap({ styleId: "b", style: style("b") });
    if (recover) act(() => map.fire("error", { error: new Error("style failed") }));
    expect(map.sources.has("geofeatures")).toBe(false);

    act(() => map.fire("style.load"));
    expect(map.sources.get("geofeatures")!.setData).toHaveBeenCalledExactlyOnceWith(sources.geofeatures);
  });

  it("republishes after a synchronous style-switch failure", () => {
    const sources = buildMapSources([geofeature], undefined);
    const { map, rerenderMap } = renderMapView({ sources, styleId: "a", style: style("a") });
    const sink = map.sources.get("geofeatures")!.setData;
    sink.mockClear();
    rerenderMap({ styleId: "b", style: style("b", { throwOnSetStyle: true }) });
    expect(sink).toHaveBeenCalledExactlyOnceWith(sources.geofeatures);
  });

  it("publishes unchanged geometry to a replacement map after retry", () => {
    const sources = buildMapSources([geofeature], undefined);
    const { map, maps } = renderMapView({ sources, style: style("a", { initialStyleLoading: true }) });
    act(() => map.fire("error", { error: new Error("initial style failed") }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const replacement = maps().at(-1)!;
    expect(replacement).not.toBe(map);

    act(() => replacement.fire("style.load"));
    expect(replacement.sources.get("geofeatures")!.setData).toHaveBeenCalledExactlyOnceWith(sources.geofeatures);
  });
});
