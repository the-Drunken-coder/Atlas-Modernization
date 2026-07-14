import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildMapSources } from "./map-sources.js";
import { entity, firePointerMove, renderMapView } from "./MapView.test-harness.js";

describe("MapView keyboard selection", () => {
  it("focuses position-picking mode and chooses the map center with Enter", () => {
    const { canvas, onPickPosition } = renderMapView({ positionPicking: true });

    expect(canvas).toHaveFocus();
    expect(canvas).toHaveAccessibleName("Map position picker");
    fireEvent.keyDown(canvas, { key: "Enter" });

    expect(onPickPosition).toHaveBeenCalledWith({ lng: 200, lat: 100, x: 210, y: 120 });
  });

  it("leaves Enter available to ordinary controls while position-picking is active", () => {
    const { onPickPosition } = renderMapView({ positionPicking: true });
    const button = document.createElement("button");
    document.body.appendChild(button);
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });

    fireEvent(button, event);

    expect(event.defaultPrevented).toBe(false);
    expect(onPickPosition).not.toHaveBeenCalled();
    button.remove();
  });

  it("cancels position-picking mode with Escape without clearing selection", () => {
    const { canvas, onBackgroundClick, onCancelPositionPicking } = renderMapView({ positionPicking: true, selectedId: "asset-1" });
    const laterEscapeHandler = vi.fn();
    window.addEventListener("keydown", laterEscapeHandler);

    fireEvent.keyDown(canvas, { key: "Escape" });

    expect(onCancelPositionPicking).toHaveBeenCalledTimes(1);
    expect(onBackgroundClick).not.toHaveBeenCalled();
    expect(laterEscapeHandler).not.toHaveBeenCalled();
    window.removeEventListener("keydown", laterEscapeHandler);
  });

  it("leaves Escape handling to an open menu without clearing selection", () => {
    const { onBackgroundClick } = renderMapView({ selectedId: "asset-1" });
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const menuItem = document.createElement("button");
    menuItem.setAttribute("role", "menuitem");
    menu.appendChild(menuItem);
    document.body.appendChild(menu);

    fireEvent.keyDown(menuItem, { key: "Escape" });

    expect(onBackgroundClick).not.toHaveBeenCalled();
    menu.remove();
  });

  it("does not route menu arrow keys to map selection", () => {
    const { onSelectEntity } = renderDirectionalMap("center");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const menuItem = document.createElement("button");
    menuItem.setAttribute("role", "menuitem");
    menu.appendChild(menuItem);
    document.body.appendChild(menu);

    fireEvent.keyDown(menuItem, { key: "ArrowDown" });

    expect(onSelectEntity).not.toHaveBeenCalled();
    menu.remove();
  });

  it("uses a pointer activation as a position while picking", () => {
    const { canvas, onPickPosition, onSelectEntity } = renderMapView({ positionPicking: true });

    fireEvent.click(canvas, { clientX: 110, clientY: 70 });

    expect(onPickPosition).toHaveBeenCalledWith({ lng: 100, lat: 50, x: 110, y: 70 });
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it("preserves position-picking selection when the map is unavailable", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const { canvas, onBackgroundClick, onPickPosition, onSelectEntity } = renderMapView({
      positionPicking: true,
      selectedId: "asset-1"
    });

    fireEvent.click(canvas, { clientX: 110, clientY: 70 });

    expect(onPickPosition).not.toHaveBeenCalled();
    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(onBackgroundClick).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"]
  ])("uses %s to select the visible entity in that direction", (key, expectedId) => {
    const { canvas, map, onSelectEntity } = renderDirectionalMap("center");
    map.fitBounds.mockClear();
    map.flyTo.mockClear();

    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    fireEvent(canvas, event);

    expect(map.options.keyboard).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onSelectEntity).toHaveBeenCalledWith(expectedId);
    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  it("starts directional selection from the viewport center when nothing is selected", () => {
    const { canvas, onSelectEntity } = renderDirectionalMap();

    fireEvent.keyDown(canvas, { key: "ArrowDown" });

    expect(onSelectEntity).toHaveBeenCalledWith("down");
  });

  it("ignores entities outside the current viewport", () => {
    const sources = buildMapSources([pointEntity("center", 200, 100), pointEntity("offscreen-down", 200, 240)], "center");
    const { canvas, onSelectEntity } = renderMapView({ selectedId: "center", sources });

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    fireEvent(canvas, event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it("prefers directional alignment over a nearer diagonal target", () => {
    const sources = buildMapSources([pointEntity("center", 200, 100), pointEntity("aligned-down", 200, 170), pointEntity("diagonal-down", 260, 120)], "center");
    const { canvas, onSelectEntity } = renderMapView({ selectedId: "center", sources });

    fireEvent.keyDown(canvas, { key: "ArrowDown" });

    expect(onSelectEntity).toHaveBeenCalledWith("aligned-down");
  });

  it("does not intercept arrow keys from editable controls", () => {
    const { canvas, onSelectEntity } = renderDirectionalMap("center");
    const input = document.createElement("input");
    canvas.appendChild(input);

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    fireEvent(input, event);

    expect(event.defaultPrevented).toBe(false);
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it("routes arrow keys from sidebar controls to map selection", () => {
    const { onSelectEntity } = renderDirectionalMap("center");
    const sidebarButton = document.createElement("button");
    document.body.appendChild(sidebarButton);

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    fireEvent(sidebarButton, event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSelectEntity).toHaveBeenCalledWith("down");
    sidebarButton.remove();
  });

  it("does not intercept arrow keys from the sidebar resize handle", () => {
    const { onSelectEntity } = renderDirectionalMap("center");
    const separator = document.createElement("div");
    separator.setAttribute("role", "separator");
    document.body.appendChild(separator);

    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    fireEvent(separator, event);

    expect(event.defaultPrevented).toBe(false);
    expect(onSelectEntity).not.toHaveBeenCalled();
    separator.remove();
  });

  it("removes global arrow navigation when the map unmounts", () => {
    const { onSelectEntity, unmount } = renderDirectionalMap("center");
    unmount();

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(false);
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it("clears the pointer reticle when keyboard navigation takes over", async () => {
    const { canvas, onSelectEntity } = renderDirectionalMap("center");
    firePointerMove(canvas, { clientX: 210, clientY: 120 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());

    fireEvent.keyDown(canvas, { key: "ArrowDown" });

    expect(onSelectEntity).toHaveBeenCalledWith("down");
    await waitFor(() => expect(document.querySelector(".map-reticle")).not.toBeInTheDocument());
    expect(canvas).not.toHaveClass("map-canvas--custom-cursor");
  });
});

function renderDirectionalMap(selectedId?: string) {
  const sources = buildMapSources(
    [
      pointEntity("center", 200, 100),
      pointEntity("up", 200, 40),
      pointEntity("down", 200, 160),
      pointEntity("left", 80, 100),
      pointEntity("right", 320, 100),
      pointEntity("offscreen", 200, 240)
    ],
    selectedId
  );
  return renderMapView({ selectedId, sources });
}

function pointEntity(entityId: string, x: number, y: number) {
  return entity({ entity_id: entityId, entity_type: "geofeature", components: { geometry: { type: "Point", coordinates: [x, y] } } });
}
