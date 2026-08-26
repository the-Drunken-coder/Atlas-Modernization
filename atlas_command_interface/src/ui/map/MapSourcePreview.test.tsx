import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StyleSpecification } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapSourcePreview } from "./MapSourcePreview.js";

type Listener = (event: { error: Error }) => void;

const maplibreMock = vi.hoisted(() => {
  class FakeAttributionControl {
    constructor(readonly options: { compact: boolean }) {}
  }

  class FakeMap {
    static instances: FakeMap[] = [];

    readonly addControl = vi.fn();
    readonly jumpTo = vi.fn();
    readonly remove = vi.fn();
    readonly resize = vi.fn();
    readonly listeners = new Map<string, Listener[]>();

    constructor(readonly options: Record<string, unknown>) {
      FakeMap.instances.push(this);
    }

    on(type: string, listener: Listener): this {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      return this;
    }

    fire(type: string, event = { error: new Error("fixture error") }): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  return { FakeAttributionControl, FakeMap };
});

vi.mock("./runtime/maplibre-runtime.js", () => ({
  getMapLibreRuntime: () => ({
    AttributionControl: maplibreMock.FakeAttributionControl,
    Map: maplibreMock.FakeMap
  }),
  loadMapLibre: vi.fn()
}));

vi.mock("./view/map-view-utils.js", () => ({
  cloneStyle: (style: StyleSpecification) => style,
  webglAvailable: () => true
}));

const source = {
  id: "usgs-topo",
  label: "USGS Topo",
  style: { version: 8, sources: {}, layers: [] } satisfies StyleSpecification
};
const viewport = { center: [-74, 40] as [number, number], zoom: 9, bearing: 4, pitch: 2 };

beforeEach(() => {
  maplibreMock.FakeMap.instances.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MapSourcePreview", () => {
  it("waits for the main viewport, renders noninteractively, and commits only when ready", async () => {
    const onCommit = vi.fn();
    const onDismiss = vi.fn();
    const result = render(<MapSourcePreview source={source} onCommit={onCommit} onDismiss={onDismiss} />);

    expect(screen.getByRole("status")).toHaveTextContent("Reading current view");
    expect(maplibreMock.FakeMap.instances).toHaveLength(0);

    result.rerender(<MapSourcePreview source={source} viewport={viewport} onCommit={onCommit} onDismiss={onDismiss} />);
    await waitFor(() => expect(maplibreMock.FakeMap.instances).toHaveLength(1));
    const map = maplibreMock.FakeMap.instances[0];
    expect(map.options).toMatchObject({
      center: viewport.center,
      zoom: viewport.zoom,
      bearing: viewport.bearing,
      pitch: viewport.pitch,
      interactive: false,
      renderWorldCopies: false,
      attributionControl: false
    });
    expect(map.addControl).toHaveBeenCalledWith(
      expect.objectContaining({ options: { compact: false } }),
      "bottom-right"
    );
    expect(screen.getByRole("button", { name: "Use USGS Topo" })).toBeDisabled();

    act(() => map.fire("load"));
    const useButton = screen.getByRole("button", { name: "Use USGS Topo" });
    expect(useButton).toBeEnabled();
    fireEvent.click(useButton);
    expect(onCommit).toHaveBeenCalledOnce();

    map.jumpTo.mockClear();
    const nextViewport = { ...viewport, center: [-73, 41] as [number, number], zoom: 11 };
    result.rerender(
      <MapSourcePreview source={source} viewport={nextViewport} onCommit={onCommit} onDismiss={onDismiss} />
    );
    expect(maplibreMock.FakeMap.instances).toHaveLength(1);
    expect(map.jumpTo).toHaveBeenCalledWith(nextViewport);

    result.unmount();
    expect(map.remove).toHaveBeenCalledOnce();
  });

  it("surfaces slow and failed loads, retries, and dismisses with Escape", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<MapSourcePreview source={source} viewport={viewport} onCommit={vi.fn()} onDismiss={onDismiss} />);
    await vi.waitFor(() => expect(maplibreMock.FakeMap.instances).toHaveLength(1));
    const firstMap = maplibreMock.FakeMap.instances[0];

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("status")).toHaveTextContent("taking longer");

    act(() => firstMap.fire("error", { error: new Error("Provider denied the request") }));
    expect(screen.getByRole("alert")).toHaveTextContent("Preview unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Provider denied the request");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(maplibreMock.FakeMap.instances).toHaveLength(2));
    expect(firstMap.remove).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
