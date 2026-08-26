import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MapSourceConfig } from "../../../app/config.js";
import { mapInstances, renderMapView, style } from "./MapView.test-harness.js";

const mapSourceOptions: MapSourceConfig[] = [
  { id: "base", label: "Base map", style: style("base") },
  {
    id: "alternate",
    label: "Alternate map",
    style: {
      version: 8,
      sources: { alternate: { type: "raster", tiles: [], attribution: "Alternate attribution" } },
      layers: []
    }
  },
  { id: "locked", label: "Locked map", unavailableReason: "missing key" }
];

describe("MapView region comparison", () => {
  it("draws only after the explicit tool is active and creates a region-sized passive map", async () => {
    const rendered = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });

    fireEvent.mouseDown(rendered.canvas, { button: 0, clientX: 80, clientY: 80 });
    expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument();

    await drawComparison();

    const region = await screen.findByTestId("map-comparison-region");
    expect(region).toHaveStyle({ left: "70px", top: "60px", width: "180px", height: "80px" });
    expect(screen.getByRole("dialog", { name: "Region comparison" })).toHaveStyle({ top: "88px", maxHeight: "102px" });
    expect(mapInstances()).toHaveLength(2);
    expect(mapInstances()[1].options).toMatchObject({ interactive: false, attributionControl: false });
    expect(mapInstances()[1].getContainer()).toHaveClass("map-compare__map");
    expect(mapInstances()[1].sources.has("geofeatures")).toBe(true);
    expect(screen.getByLabelText("Comparison map attribution")).toHaveTextContent("Alternate attribution");
  });

  it("leaves Shift-drag with the existing box-zoom interaction while drawing is armed", async () => {
    const { canvas } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    fireEvent.click(screen.getByRole("button", { name: "Compare map source inside a region" }));
    const primaryHost = canvas.querySelector<HTMLElement>(".maplibre-host");
    if (!primaryHost) throw new Error("Primary map host is missing");

    fireEvent.mouseDown(primaryHost, { button: 0, clientX: 80, clientY: 80, shiftKey: true });

    expect(canvas.querySelector(".map-reticle--zoom")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(canvas.querySelector(".map-reticle--zoom")).not.toBeInTheDocument();
    expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument();
    expect(screen.getByText("Drag a region. Shift-drag still zooms.")).toBeInTheDocument();
  });

  it("keeps the secondary camera aligned as the primary map moves", async () => {
    const { map } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    const comparisonMap = mapInstances()[1];
    comparisonMap.jumpTo.mockClear();
    map.project.mockImplementation((position: [number, number]) => ({ x: position[0] + 20, y: position[1] + 10 }));

    map.fire("move");

    await waitFor(() => expect(comparisonMap.jumpTo).toHaveBeenCalled());
    expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ left: "90px", top: "70px" });
  });

  it("syncs zoom when the clipped region bounds do not change", async () => {
    const { map } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    const comparisonMap = mapInstances()[1];
    map.project.mockImplementation((position: [number, number]) => ({
      x: position[0] < 160 ? -100 : 500,
      y: position[1] > 100 ? -100 : 300
    }));

    map.fire("zoom");

    await waitFor(() =>
      expect(screen.getByTestId("map-comparison-region")).toHaveStyle({
        left: "0px",
        top: "0px",
        width: "400px",
        height: "200px"
      })
    );
    expect(screen.getByTestId("map-comparison-region")).toHaveAttribute("data-resize-right-inside", "true");
    expect(screen.getByTestId("map-comparison-region")).toHaveAttribute("data-resize-bottom-inside", "true");
    comparisonMap.jumpTo.mockClear();
    map.getZoom.mockReturnValue(12);

    map.fire("zoom");

    await waitFor(() => expect(comparisonMap.jumpTo).toHaveBeenCalledWith(expect.objectContaining({ zoom: 12 })));
  });

  it("gives Escape to the source list, then the panel, then the active region", async () => {
    renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    const sourceTrigger = screen.getByRole("button", { name: "Inside region" });
    fireEvent.click(sourceTrigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("option", { name: /Alternate map/ }), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Region comparison" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Region comparison" })).not.toBeInTheDocument();
    expect(screen.getByTestId("map-comparison-region")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare map source inside a region" })).toHaveFocus();
  });

  it("moves the active region from its explicit keyboard handle without navigating entities", async () => {
    const { onSelectEntity } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();

    fireEvent.keyDown(screen.getByRole("button", { name: "Move comparison region" }), { key: "ArrowRight" });

    await waitFor(() => expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ left: "80px" }));
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it("resizes width by pointer and height by keyboard without navigating entities", async () => {
    const { onSelectEntity } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();

    fireEvent.mouseDown(screen.getByRole("button", { name: "Resize comparison region width" }), {
      button: 0,
      clientX: 260,
      clientY: 120
    });
    fireEvent.mouseMove(window, { clientX: 300, clientY: 120 });
    fireEvent.mouseUp(screen.getByTestId("map-canvas"), { clientX: 300, clientY: 120 });

    await waitFor(() => expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ width: "220px" }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: /Alternate map/ }));
    expect(screen.getByRole("dialog", { name: "Region comparison" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Resize comparison region height" }), {
      key: "ArrowDown"
    });
    await waitFor(() => expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ height: "90px" }));
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it("resizes both axes from the corner keyboard handle", async () => {
    renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    const corner = screen.getByRole("button", { name: "Resize comparison region width and height" });

    fireEvent.keyDown(corner, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ width: "190px" }));
    fireEvent.keyDown(corner, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ height: "90px" }));
  });

  it("adjusts comparison opacity and resets it after clear", async () => {
    renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    const slider = screen.getByRole("slider", { name: "Comparison map opacity" });
    expect(slider).toHaveValue("100");

    fireEvent.change(slider, { target: { value: "45" } });

    expect(mapInstances()[1].getContainer()).toHaveStyle({ opacity: "0.45" });
    fireEvent.click(screen.getByRole("button", { name: "Close comparison controls" }));
    expect(screen.getByRole("button", { name: /Alternate map · 45%/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Alternate map · 45%/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await drawComparison();
    expect(screen.getByRole("slider", { name: "Comparison map opacity" })).toHaveValue("100");
  });

  it("restores the previous region when redraw is canceled and clears it explicitly", async () => {
    renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();

    fireEvent.click(screen.getByRole("button", { name: "Redraw" }));
    expect(screen.getByText("Drag a region. Shift-drag still zooms.")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByRole("dialog", { name: "Region comparison" })).toBeInTheDocument();
    expect(screen.getByTestId("map-comparison-region")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare map source inside a region" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("surfaces unavailable, loading, and tile-error states without animation", async () => {
    const unavailableSources: MapSourceConfig[] = [
      { id: "base", label: "Base map", style: style("base") },
      { id: "locked", label: "Locked map", unavailableReason: "missing key" }
    ];
    const unavailable = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions: unavailableSources });
    fireEvent.click(screen.getByRole("button", { name: "Compare map source inside a region" }));
    expect(screen.getByText(/No alternate source is available/)).toBeInTheDocument();
    unavailable.unmount();

    renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    const comparisonMap = mapInstances().at(-1);
    if (!comparisonMap) throw new Error("Comparison map is missing");
    comparisonMap.fire("dataloading");
    await waitFor(() => expect(screen.getByText("Loading tiles")).toBeInTheDocument());

    comparisonMap.fire("error", { error: new Error("tile request failed") });

    expect(await screen.findByRole("alert")).toHaveTextContent("tile request failed");
    const mapCount = mapInstances().length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mapInstances()).toHaveLength(mapCount + 1));
  });
});

async function drawComparison(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Compare map source inside a region" }));
  const prompt = screen.getByText("Drag a region. Shift-drag still zooms.");
  const surface = prompt.parentElement;
  if (!surface) throw new Error("Drawing surface is missing");
  fireEvent.mouseDown(surface, { button: 0, clientX: 80, clientY: 80 });
  fireEvent.mouseMove(window, { clientX: 260, clientY: 160 });
  fireEvent.mouseUp(window, { clientX: 260, clientY: 160 });
  await screen.findByTestId("map-comparison-region");
}
