import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { markerSources, renderMapView, style } from "./MapView.test-harness.js";

describe("MapView style switching", () => {
  it("creates symbol markers after the initial style load", async () => {
    const { canvas, map } = renderMapView({ sources: markerSources() });

    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));
    expect(map.sources.has("geofeatures")).toBe(true);
  });

  it("keeps existing symbol markers when a style switch fails", async () => {
    const onStyleSwitchError = vi.fn();
    const { canvas, map, rerenderMap } = renderMapView({
      sources: markerSources(),
      styleId: "a",
      style: style("a"),
      onStyleSwitchError
    });
    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));
    const marker = canvas.querySelector(".map-symbol-marker");

    rerenderMap({ styleId: "b", style: style("b", { throwOnSetStyle: true }) });

    await waitFor(() =>
      expect(onStyleSwitchError).toHaveBeenCalledWith({
        failedStyleId: "b",
        activeStyleId: "a"
      })
    );
    expect(canvas.querySelector(".map-symbol-marker")).toBe(marker);
    expect(map.setStyle).toHaveBeenCalledTimes(1);
  });

  it("sets a prefetched style and re-registers overlays after style load", async () => {
    const nextStyle = style("b");
    const { canvas, map, rerenderMap } = renderMapView({ sources: markerSources(), styleId: "a", style: style("a") });
    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));
    const marker = canvas.querySelector(".map-symbol-marker");

    rerenderMap({ styleId: "b", style: nextStyle });

    await waitFor(() => expect(map.setStyle).toHaveBeenCalledWith(nextStyle));
    expect(map.sources.has("geofeatures")).toBe(false);

    act(() => map.fire("style.load"));

    await waitFor(() => expect(map.sources.has("geofeatures")).toBe(true));
    expect(canvas.querySelector(".map-symbol-marker")).toBe(marker);
  });
});
