import { fireEvent, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { markerSources, renderMapView, style } from "./MapView.test-harness.js";

describe("MapView style switching", () => {
  it("creates symbol markers after the initial style load", async () => {
    const { canvas, map } = renderMapView({ sources: markerSources() });

    await waitFor(() => expect(canvas.querySelectorAll(".map-symbol-marker")).toHaveLength(1));
    expect(map.sources.has("geofeatures")).toBe(true);
  });

  it("surfaces an initial style error with a retry action", async () => {
    const rendered = renderMapView({ style: style("broken", { initialStyleLoading: true }) });
    const initialMap = rendered.map;

    act(() => initialMap.fire("error", { error: new Error("initial style failed") }));

    expect(await screen.findByText("Map unavailable")).toBeInTheDocument();
    expect(screen.getByText("initial style failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(initialMap.remove).toHaveBeenCalledOnce());
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

  it("does not report a source error as a failed pending style switch", async () => {
    const onStyleSwitchError = vi.fn();
    const { map, rerenderMap } = renderMapView({
      styleId: "a",
      style: style("a"),
      onStyleSwitchError
    });
    const nextStyle = style("b");

    rerenderMap({ styleId: "b", style: nextStyle });
    await waitFor(() => expect(map.setStyle).toHaveBeenCalledWith(nextStyle));

    act(() => map.fire("error", { error: new Error("tile failed"), sourceId: "basemap" }));

    expect(onStyleSwitchError).not.toHaveBeenCalled();
    expect(map.setStyle).toHaveBeenCalledTimes(1);
    act(() => map.fire("style.load"));
    expect(onStyleSwitchError).not.toHaveBeenCalled();
  });

  it("reapplies the last successful style after an asynchronous style failure", async () => {
    const onStyleSwitchError = vi.fn();
    const { map, rerenderMap } = renderMapView({
      styleId: "a",
      style: style("a"),
      onStyleSwitchError
    });

    rerenderMap({ styleId: "b", style: style("b") });
    await waitFor(() => expect(map.setStyle).toHaveBeenCalledTimes(1));

    act(() => map.fire("error", { error: new Error("style failed") }));

    expect(onStyleSwitchError).toHaveBeenCalledWith({ failedStyleId: "b", activeStyleId: "a" });
    expect(map.setStyle).toHaveBeenCalledTimes(2);
    expect(map.setStyle).toHaveBeenNthCalledWith(2, style("a"));
  });
});
