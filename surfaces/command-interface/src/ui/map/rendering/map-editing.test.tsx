import { fireEvent } from "@testing-library/react";
import type { Map as MlMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiGeometry } from "../../../atlas/geometry.js";
import type { MapLibreRuntime } from "../runtime/maplibre-runtime.js";
import { createEditingMarkers } from "./map-editing.js";

type MarkerListener = () => void;

class TestMarker {
  readonly element: HTMLElement;
  private coordinates: [number, number] = [0, 0];
  private readonly listeners = new Map<string, MarkerListener[]>();

  constructor(options: { element: HTMLElement }) {
    this.element = options.element;
  }

  setLngLat(coordinates: [number, number]): this {
    this.coordinates = [...coordinates];
    return this;
  }

  addTo(map: TestMap): this {
    map.container.append(this.element);
    return this;
  }

  on(event: string, listener: MarkerListener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  getLngLat(): { lng: number; lat: number } {
    return { lng: this.coordinates[0], lat: this.coordinates[1] };
  }

  remove(): void {
    this.element.remove();
  }
}

type TestMap = {
  container: HTMLDivElement;
  getSource: () => { setData: ReturnType<typeof vi.fn> };
  project: (position: [number, number]) => { x: number; y: number };
  unproject: (position: [number, number]) => { lng: number; lat: number };
};

const testContainers: HTMLDivElement[] = [];

afterEach(() => {
  for (const container of testContainers) container.remove();
  testContainers.length = 0;
});

function testMap(): TestMap {
  return {
    container: document.createElement("div"),
    getSource: () => ({ setData: vi.fn() }),
    project: ([lng, lat]) => ({ x: lng * 100, y: lat * 100 }),
    unproject: ([x, y]) => ({ lng: x / 100, lat: y / 100 })
  };
}

function createMarkers(geometry: UiGeometry, onChange = vi.fn()) {
  const map = testMap();
  document.body.append(map.container);
  testContainers.push(map.container);
  const markers = createEditingMarkers(
    map as unknown as MlMap,
    { geometry, onChange },
    TestMarker as unknown as MapLibreRuntime["Marker"]
  );
  return { map, markers, onChange };
}

const line: UiGeometry = {
  type: "LineString",
  coordinates: [
    [-74.2, 40.1],
    [-74.1, 40.2],
    [-74.0, 40.3]
  ]
};

describe("createEditingMarkers", () => {
  it("exposes existing vertices as named map interaction buttons", () => {
    const { map } = createMarkers(line);

    const vertices = [...map.container.querySelectorAll<HTMLButtonElement>("[data-vertex-key]")];
    expect(vertices).toHaveLength(3);
    expect(vertices.map((vertex) => vertex.getAttribute("aria-label"))).toEqual([
      "Move vertex 1",
      "Move vertex 2",
      "Move vertex 3"
    ]);
    expect(vertices.map((vertex) => vertex.dataset.vertexKey)).toEqual(["line-0", "line-1", "line-2"]);
    expect(vertices.every((vertex) => vertex.tagName === "BUTTON")).toBe(true);
    expect(vertices.every((vertex) => vertex.hasAttribute("data-map-interaction-control"))).toBe(true);

    const midpoint = map.container.querySelector<HTMLButtonElement>(".vertex-handle--mid");
    expect(midpoint).toHaveAttribute("aria-label", "Add vertex");
    expect(midpoint).toHaveAttribute("data-map-interaction-control");
  });

  it("moves the focused vertex by 10 pixels or 40 pixels with Shift", () => {
    const globalKeydown = vi.fn();
    window.addEventListener("keydown", globalKeydown);
    try {
      const { map, onChange } = createMarkers(line);
      const vertex = map.container.querySelector<HTMLButtonElement>('[data-vertex-key="line-0"]');
      if (!vertex) throw new Error("Expected first vertex");

      const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
      fireEvent(vertex, right);
      const moved = onChange.mock.lastCall?.[0] as Extract<UiGeometry, { type: "LineString" }>;
      expect(right.defaultPrevented).toBe(true);
      expect(globalKeydown).not.toHaveBeenCalled();
      expect(moved.coordinates[0]).toEqual([-74.1, 40.1]);

      const down = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        shiftKey: true,
        bubbles: true,
        cancelable: true
      });
      fireEvent(vertex, down);
      const shifted = onChange.mock.lastCall?.[0] as Extract<UiGeometry, { type: "LineString" }>;
      expect(down.defaultPrevented).toBe(true);
      expect(shifted.coordinates[0]).toEqual([-74.1, 40.5]);
    } finally {
      window.removeEventListener("keydown", globalKeydown);
    }
  });

  it("removes a vertex only when the resulting geometry remains valid", () => {
    const { map, onChange } = createMarkers(line);
    const removable = map.container.querySelector<HTMLButtonElement>('[data-vertex-key="line-1"]');
    if (!removable) throw new Error("Expected second vertex");

    const remove = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    fireEvent(removable, remove);
    const next = onChange.mock.lastCall?.[0] as Extract<UiGeometry, { type: "LineString" }>;
    expect(remove.defaultPrevented).toBe(true);
    expect(next.coordinates).toEqual([
      [-74.2, 40.1],
      [-74.0, 40.3]
    ]);

    const { map: shortMap, onChange: shortChange } = createMarkers({
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    });
    const protectedVertex = shortMap.container.querySelector<HTMLButtonElement>('[data-vertex-key="line-0"]');
    if (!protectedVertex) throw new Error("Expected protected vertex");
    fireEvent.keyDown(protectedVertex, { key: "Delete" });
    expect(shortChange).not.toHaveBeenCalled();
  });

  it("clamps keyboard movement to coordinate bounds", () => {
    const { map, onChange } = createMarkers({
      type: "LineString",
      coordinates: [
        [-180, -90],
        [180, 90]
      ]
    });
    const first = map.container.querySelector<HTMLButtonElement>('[data-vertex-key="line-0"]');
    const second = map.container.querySelector<HTMLButtonElement>('[data-vertex-key="line-1"]');
    if (!first || !second) throw new Error("Expected bounded vertices");

    fireEvent.keyDown(first, { key: "ArrowLeft" });
    fireEvent.keyDown(first, { key: "ArrowUp" });
    fireEvent.keyDown(second, { key: "ArrowRight" });
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
