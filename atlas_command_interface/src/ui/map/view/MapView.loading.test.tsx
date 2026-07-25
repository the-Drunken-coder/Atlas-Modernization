import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StyleSpecification } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMapSources } from "../rendering/map-sources.js";
import { MapView } from "./MapView.js";

const loaderMocks = vi.hoisted(() => ({
  loadMapLibre: vi.fn(),
  loadSidcRuntime: vi.fn(),
  mapConstructor: vi.fn()
}));

vi.mock("../runtime/maplibre-runtime.js", () => ({
  getMapLibreRuntime: () => undefined,
  loadMapLibre: loaderMocks.loadMapLibre
}));
vi.mock("../../symbols/sidc-runtime.js", () => ({
  getSidcRuntime: () => undefined,
  loadSidcRuntime: loaderMocks.loadSidcRuntime,
  renderSymbol: vi.fn()
}));

describe("MapView runtime boundary", () => {
  beforeEach(() => {
    loaderMocks.loadMapLibre.mockReset();
    loaderMocks.loadSidcRuntime.mockReset();
    loaderMocks.mapConstructor.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not initialize a resolved runtime after the view has unmounted", async () => {
    let resolveMapLibre!: (runtime: unknown) => void;
    let resolveSidc!: (runtime: unknown) => void;
    const mapLibre = new Promise((resolve) => {
      resolveMapLibre = resolve;
    });
    const sidc = new Promise((resolve) => {
      resolveSidc = resolve;
    });
    loaderMocks.loadMapLibre.mockReturnValue(mapLibre);
    loaderMocks.loadSidcRuntime.mockReturnValue(sidc);

    const rendered = renderMapView();
    rendered.unmount();
    await actResolve(() => {
      resolveMapLibre({});
      resolveSidc({});
    });

    expect(loaderMocks.mapConstructor).not.toHaveBeenCalled();
  });

  it("retries a failed runtime load and initializes once after the second load succeeds", async () => {
    const runtime = createRuntime();
    loaderMocks.loadMapLibre
      .mockRejectedValueOnce(new Error("MapLibre runtime failed to load"))
      .mockResolvedValueOnce(runtime);
    loaderMocks.loadSidcRuntime
      .mockRejectedValueOnce(new Error("SIDC runtime failed to load"))
      .mockResolvedValueOnce({});

    renderMapView();

    expect(await screen.findByText("Map unavailable")).toBeInTheDocument();
    expect(screen.getByText("MapLibre runtime failed to load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(loaderMocks.loadMapLibre).toHaveBeenCalledTimes(1);
    expect(loaderMocks.loadSidcRuntime).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(loaderMocks.loadMapLibre).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(loaderMocks.loadSidcRuntime).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(loaderMocks.mapConstructor).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Map unavailable")).not.toBeInTheDocument();
  });

  it("initializes with the latest style selected while runtimes are loading", async () => {
    let resolveMapLibre!: (runtime: unknown) => void;
    let resolveSidc!: (runtime: unknown) => void;
    const mapLibre = new Promise((resolve) => {
      resolveMapLibre = resolve;
    });
    const sidc = new Promise((resolve) => {
      resolveSidc = resolve;
    });
    loaderMocks.loadMapLibre.mockReturnValue(mapLibre);
    loaderMocks.loadSidcRuntime.mockReturnValue(sidc);

    const originalStyle = { version: 8, sources: {}, layers: [], metadata: { id: "original" } } as StyleSpecification;
    const latestStyle = { version: 8, sources: {}, layers: [], metadata: { id: "latest" } } as StyleSpecification;
    const rendered = renderMapView({ styleId: "original", style: originalStyle });
    rendered.rerender(
      <MapView
        sources={buildMapSources([], undefined)}
        styleId="latest"
        style={latestStyle}
        onSelectEntity={vi.fn()}
        onMapContextMenu={vi.fn()}
      />
    );

    await actResolve(() => {
      resolveMapLibre(createRuntime());
      resolveSidc({});
    });
    await waitFor(() => expect(loaderMocks.mapConstructor).toHaveBeenCalledTimes(1));

    expect(loaderMocks.mapConstructor).toHaveBeenCalledWith(expect.objectContaining({ style: latestStyle }));
  });
});

function renderMapView({
  styleId = "test-style",
  style = { version: 8, sources: {}, layers: [] } as StyleSpecification
} = {}) {
  return render(
    <MapView
      sources={buildMapSources([], undefined)}
      styleId={styleId}
      style={style}
      onSelectEntity={vi.fn()}
      onMapContextMenu={vi.fn()}
    />
  );
}

async function actResolve(resolve: () => void): Promise<void> {
  await act(async () => {
    resolve();
    await Promise.resolve();
  });
}

function createRuntime() {
  class FakeMap {
    private readonly sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    private readonly layers = new Set<string>();

    constructor(options: unknown) {
      loaderMocks.mapConstructor(options);
    }

    addControl() {}

    addLayer(layer: { id: string }) {
      this.layers.add(layer.id);
    }

    addSource(id: string) {
      this.sources.set(id, { setData: vi.fn() });
    }

    getLayer(id: string) {
      return this.layers.has(id) ? {} : undefined;
    }

    getSource(id: string) {
      return this.sources.get(id);
    }

    fitBounds() {}

    isStyleLoaded() {
      return true;
    }

    on() {
      return this;
    }

    off() {
      return this;
    }

    remove() {}

    resize() {}
  }

  return {
    AttributionControl: class {},
    Map: FakeMap,
    Marker: class {},
    NavigationControl: class {}
  };
}
