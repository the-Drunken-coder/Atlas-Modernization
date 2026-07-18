import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView.js";
import { buildMapSources } from "./map-sources.js";

const deferred = vi.hoisted(() => {
  let resolveMapLibre!: (runtime: unknown) => void;
  let resolveSidc!: (runtime: unknown) => void;
  return {
    mapLibre: new Promise((resolve) => {
      resolveMapLibre = resolve;
    }),
    resolveMapLibre,
    sidc: new Promise((resolve) => {
      resolveSidc = resolve;
    }),
    resolveSidc
  };
});

const mapConstructor = vi.hoisted(() => vi.fn());

vi.mock("./maplibre-runtime.js", () => ({
  getMapLibreRuntime: () => undefined,
  loadMapLibre: () => deferred.mapLibre
}));
vi.mock("../symbols/sidc-runtime.js", () => ({
  getSidcRuntime: () => undefined,
  loadSidcRuntime: () => deferred.sidc,
  renderSymbol: vi.fn()
}));

describe("MapView runtime boundary", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  });

  it("does not initialize a resolved runtime after the view has unmounted", async () => {
    const runtime = {
      AttributionControl: class {},
      Map: mapConstructor,
      Marker: class {},
      NavigationControl: class {}
    };
    const rendered = render(
      <MapView
        sources={buildMapSources([], undefined)}
        styleId="test-style"
        style={{ version: 8, sources: {}, layers: [] }}
        onSelectEntity={vi.fn()}
        onMapContextMenu={vi.fn()}
      />
    );

    rendered.unmount();
    await act(async () => {
      deferred.resolveMapLibre(runtime);
      deferred.resolveSidc({});
      await Promise.resolve();
    });

    expect(mapConstructor).not.toHaveBeenCalled();
  });
});
