import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MapSourceConfig } from "../../../app/config.js";
import { mapInstances, notifyResizeObservers, rect, renderMapView, style } from "./MapView.test-harness.js";

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

    fireEvent.pointerDown(rendered.canvas, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 80, clientY: 80 });
    expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument();

    rendered.map.stop.mockClear();
    await drawComparison();
    expect(rendered.map.stop).toHaveBeenCalledOnce();

    const region = await screen.findByTestId("map-comparison-region");
    expect(region).toHaveStyle({ left: "70px", top: "60px", width: "180px", height: "80px" });
    expect(screen.getByRole("dialog", { name: "Region comparison" })).toHaveStyle({ top: "88px", maxHeight: "102px" });
    expect(mapInstances()).toHaveLength(2);
    expect(mapInstances()[0].options).toMatchObject({ dragRotate: false, pitchWithRotate: false, touchPitch: false });
    expect(mapInstances()[0].touchZoomRotate.disableRotation).toHaveBeenCalledOnce();
    expect(mapInstances()[1].options).toMatchObject({ interactive: false, attributionControl: false });
    expect(mapInstances()[1].getContainer()).toHaveClass("map-compare__map");
    expect(mapInstances()[1].sources.has("geofeatures")).toBe(true);
    const attribution = screen.getByLabelText("Comparison map attribution");
    expect(attribution).toHaveTextContent("Alternate attribution");
    const attributionToggle = attribution.querySelector("summary");
    if (!attributionToggle) throw new Error("Comparison attribution toggle is missing");
    fireEvent.click(attributionToggle);
    expect(attribution).toHaveAttribute("open");
  });

  it("draws and resizes a region with touch pointers", async () => {
    renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison("touch");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Resize comparison region width" }), {
      pointerId: 2,
      pointerType: "touch",
      button: 0,
      clientX: 260,
      clientY: 120
    });
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 120 });
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 120 });

    await waitFor(() => expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ width: "220px" }));
  });

  it("leaves Shift-drag with the existing box-zoom interaction while drawing is armed", async () => {
    const { canvas } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    fireEvent.click(screen.getByRole("button", { name: "Compare map source inside a region" }));
    const primaryHost = canvas.querySelector<HTMLElement>(".maplibre-host");
    if (!primaryHost) throw new Error("Primary map host is missing");

    fireEvent.pointerDown(primaryHost, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 80,
      clientY: 80,
      shiftKey: true
    });
    fireEvent.mouseDown(primaryHost, { button: 0, clientX: 80, clientY: 80, shiftKey: true });

    expect(canvas.querySelector(".map-reticle--zoom")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(canvas.querySelector(".map-reticle--zoom")).not.toBeInTheDocument();
    expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument();
    expect(screen.getByText("Drag a region. Shift-drag still zooms.")).toBeInTheDocument();
  });

  it("creates a keyboard-adjustable default region when the Compare tool is activated from the keyboard", async () => {
    renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    const compare = screen.getByRole("button", { name: "Compare map source inside a region" });

    fireEvent.keyDown(compare, { key: "Enter" });

    const region = await screen.findByTestId("map-comparison-region");
    expect(region).toHaveStyle({ left: "100px", top: "50px", width: "200px", height: "100px" });
    expect(screen.getByRole("dialog", { name: "Region comparison" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Move comparison region" }), { key: "ArrowRight" });
    await waitFor(() => expect(region).toHaveStyle({ left: "110px" }));
  });

  it("does not start drawing or select the background from an SVG control target", () => {
    const { canvas, onBackgroundClick } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    const compare = screen.getByRole("button", { name: "Compare map source inside a region" });
    const icon = compare.querySelector("svg");
    if (!icon) throw new Error("Compare icon is missing");
    fireEvent.click(icon);
    expect(onBackgroundClick).not.toHaveBeenCalled();

    fireEvent.pointerDown(icon, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 20, clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 140 });

    expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument();
    expect(screen.getByText("Drag a region. Shift-drag still zooms.")).toBeInTheDocument();
    expect(canvas).toHaveClass("map-canvas--compare-drawing");

    const nativeControls = document.createElement("div");
    nativeControls.className = "maplibregl-control-container";
    const zoomButton = document.createElement("button");
    nativeControls.append(zoomButton);
    canvas.append(nativeControls);
    fireEvent.pointerDown(zoomButton, {
      pointerId: 2,
      pointerType: "mouse",
      button: 0,
      clientX: 380,
      clientY: 30
    });
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: "mouse", clientX: 200, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: "mouse", clientX: 200, clientY: 140 });

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

    for (const role of ["dialog", "menu"]) {
      const foreground = document.createElement("div");
      foreground.setAttribute("role", role);
      const foregroundControl = document.createElement("button");
      foreground.append(foregroundControl);
      screen.getByTestId("map-canvas").append(foreground);
      fireEvent.keyDown(foregroundControl, { key: "Escape" });
      expect(screen.getByRole("dialog", { name: "Region comparison" })).toBeInTheDocument();
      foreground.remove();
    }

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Region comparison" })).not.toBeInTheDocument();
    expect(screen.getByTestId("map-comparison-region")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare map source inside a region" })).toHaveFocus();
  });

  it("positions a tall source menu within the available map-pane space", async () => {
    const rendered = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    vi.spyOn(rendered.canvas, "getBoundingClientRect").mockReturnValue(rect(10, 20, 600, 360));
    await drawComparison();
    const trigger = screen.getByRole("button", { name: "Inside region" });
    const control = trigger.closest<HTMLElement>(".map-source-control");
    if (!control) throw new Error("Map source control is missing");
    let controlBounds = rect(80, 280, 240, 50);
    vi.spyOn(control, "getBoundingClientRect").mockImplementation(() => controlBounds);
    fireEvent.click(trigger);
    const menu = screen.getByRole("listbox");
    Object.defineProperty(menu, "scrollHeight", { configurable: true, value: 300 });

    notifyResizeObservers();

    await waitFor(() => expect(menu).toHaveAttribute("data-placement", "above"));
    expect(menu).toHaveStyle({ maxHeight: "256px" });
    expect(menu.parentElement).toBe(rendered.canvas);

    controlBounds = rect(180, 280, 240, 50);
    const panel = screen.getByRole("dialog", { name: "Region comparison" });
    panel.style.left = "180px";
    await waitFor(() => expect(menu).toHaveStyle({ left: "169px" }));

    fireEvent.keyDown(screen.getByRole("option", { name: /Alternate map/ }), { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Comparison map opacity" })).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("option", { name: /Alternate map/ }), { key: "Tab", shiftKey: true });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("moves the active region from its explicit keyboard handle without navigating entities", async () => {
    const { onSelectEntity } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();

    fireEvent.keyDown(screen.getByRole("button", { name: "Move comparison region" }), { key: "ArrowRight" });

    await waitFor(() => expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ left: "80px" }));
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it("resizes width by pointer and height by keyboard without navigating entities", async () => {
    const { map, onSelectEntity } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    map.stop.mockClear();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Resize comparison region width" }), {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 260,
      clientY: 120
    });
    expect(map.stop).toHaveBeenCalledOnce();
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 120 });
    fireEvent.pointerUp(screen.getByTestId("map-canvas"), {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 300,
      clientY: 120
    });

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

  it("preserves the off-screen part of a region while moving its clipped projection", async () => {
    const { map } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    map.project.mockImplementation((position: [number, number]) => ({ x: position[0] - 100, y: position[1] }));
    map.unproject.mockImplementation((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x + 100, lat: y };
    });
    map.fire("move");
    await waitFor(() =>
      expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ left: "0px", width: "150px" })
    );

    const move = screen.getByRole("button", { name: "Move comparison region" });
    fireEvent.pointerDown(move, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 150,
      clientY: 100
    });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientX: 170, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientX: 170, clientY: 100 });

    await waitFor(() =>
      expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ left: "0px", width: "170px" })
    );
  });

  it("preserves and grows the off-screen part of a region while resizing", async () => {
    const { map } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    map.project.mockImplementation((position: [number, number]) => ({ x: position[0] + 200, y: position[1] }));
    map.unproject.mockImplementation((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x - 200, lat: y };
    });
    map.fire("move");
    await waitFor(() =>
      expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ left: "270px", width: "130px" })
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Resize comparison region width" }), {
      key: "ArrowRight"
    });
    map.project.mockImplementation((position: [number, number]) => ({ x: position[0], y: position[1] }));
    map.fire("move");

    await waitFor(() =>
      expect(screen.getByTestId("map-comparison-region")).toHaveStyle({ left: "70px", width: "190px" })
    );
  });

  it("returns focus to Compare when camera movement hides focused region controls", async () => {
    const { map } = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();
    screen.getByRole("button", { name: "Move comparison region" }).focus();
    map.project.mockImplementation((position: [number, number]) => ({ x: position[0] + 500, y: position[1] }));

    map.fire("move");

    await waitFor(() => expect(screen.queryByTestId("map-comparison-region")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Compare map source inside a region" })).toHaveFocus();
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

  it("redraws to a keyboard-adjustable default region from the keyboard", async () => {
    renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    await drawComparison();

    fireEvent.keyDown(screen.getByRole("button", { name: "Redraw" }), { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("map-comparison-region")).toHaveStyle({
        left: "100px",
        top: "50px",
        width: "200px",
        height: "100px"
      })
    );
    expect(screen.getByRole("dialog", { name: "Region comparison" })).toBeInTheDocument();
  });

  it("surfaces unavailable, loading, and tile-error states without animation", async () => {
    const unavailableSources: MapSourceConfig[] = [
      { id: "base", label: "Base map", style: style("base") },
      { id: "locked", label: "Locked map", unavailableReason: "missing key" }
    ];
    const unavailable = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions: unavailableSources });
    fireEvent.click(screen.getByRole("button", { name: "Compare map source inside a region" }));
    expect(screen.getByText(/No alternate source is available/)).toBeInTheDocument();
    const unavailableTrigger = screen.getByRole("button", { name: "Inside region" });
    fireEvent.click(unavailableTrigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(unavailableTrigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Region comparison" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Inside region" })).toHaveFocus();
    await waitFor(() => expect(mapInstances()).toHaveLength(mapCount + 1));
  });

  it("floats a measured error panel when its rendered height does not fit below the region", async () => {
    const rendered = renderMapView({ styleId: "base", style: style("base"), mapSourceOptions });
    vi.spyOn(rendered.canvas, "getBoundingClientRect").mockReturnValue(rect(10, 20, 600, 360));
    await drawComparison();
    const panel = screen.getByRole("dialog", { name: "Region comparison" });
    expect(panel).toHaveAttribute("data-placement", "below");
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 280 });
    const comparisonMap = mapInstances().at(-1);
    if (!comparisonMap) throw new Error("Comparison map is missing");

    comparisonMap.fire("error", { error: new Error("tile request failed") });

    await waitFor(() => expect(panel).toHaveAttribute("data-placement", "floating"));
    expect(panel).toHaveStyle({ top: "10px", maxHeight: "340px" });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });
});

async function drawComparison(pointerType: "mouse" | "touch" = "mouse"): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Compare map source inside a region" }));
  const prompt = screen.getByText("Drag a region. Shift-drag still zooms.");
  const surface = prompt.parentElement;
  if (!surface) throw new Error("Drawing surface is missing");
  fireEvent.pointerDown(surface, { pointerId: 1, pointerType, button: 0, clientX: 80, clientY: 80 });
  fireEvent.pointerMove(window, { pointerId: 1, pointerType, clientX: 260, clientY: 160 });
  fireEvent.pointerUp(window, { pointerId: 1, pointerType, clientX: 260, clientY: 160 });
  await screen.findByTestId("map-comparison-region");
}
