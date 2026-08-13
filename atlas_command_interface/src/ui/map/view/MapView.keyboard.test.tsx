import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildMapSources } from "../rendering/map-sources.js";
import { entity, firePointerMove, renderMapView } from "./MapView.test-harness.js";

describe("MapView keyboard selection", () => {
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
    const sources = buildMapSources(
      [pointEntity("center", 200, 100), pointEntity("offscreen-down", 200, 240)],
      "center"
    );
    const { canvas, onSelectEntity } = renderProjectedMap({ selectedId: "center", sources });

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    fireEvent(canvas, event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it("prefers directional alignment over a nearer diagonal target", () => {
    const sources = buildMapSources(
      [pointEntity("center", 200, 100), pointEntity("aligned-down", 200, 170), pointEntity("diagonal-down", 260, 120)],
      "center"
    );
    const { canvas, onSelectEntity } = renderProjectedMap({ selectedId: "center", sources });

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
  return renderProjectedMap({ selectedId, sources });
}

function pointEntity(entityId: string, x: number, y: number) {
  return entity({
    entity_id: entityId,
    entity_type: "geofeature",
    components: { geometry: { type: "Point", coordinates: [(x - 200) / 2, (y - 100) / 2] } }
  });
}

function renderProjectedMap(options: Parameters<typeof renderMapView>[0]) {
  const rendered = renderMapView(options);
  rendered.map.project.mockImplementation(([lng, lat]: [number, number]) => ({
    x: lng * 2 + 200,
    y: lat * 2 + 100
  }));
  return rendered;
}
