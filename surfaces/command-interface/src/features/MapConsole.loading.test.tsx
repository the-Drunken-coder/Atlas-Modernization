import { render, screen } from "@testing-library/react";
import type { StyleSpecification } from "maplibre-gl";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptySnapshot } from "../atlas/store.js";
import { type AtlasContextValue, AtlasStaticProvider } from "../state/atlas-context.js";
import { MapConsole } from "./MapConsole.js";

const mapViewModule = vi.hoisted(() => {
  let resolve!: (module: { MapView: () => ReactElement }) => void;
  return {
    promise: new Promise<{ MapView: () => ReactElement }>((nextResolve) => {
      resolve = nextResolve;
    }),
    resolve
  };
});

vi.mock("../ui/map/view/MapView.js", () => mapViewModule.promise);

const style: StyleSpecification = { version: 8, sources: {}, layers: [] };

const atlasValue: AtlasContextValue = {
  status: "ready",
  config: {
    atlasBaseUrl: "http://127.0.0.1:8000",
    protocolRevision: "test",
    defaultMapSourceId: "test-map",
    placeSearch: { provider: "maptiler", unavailableReason: "missing key" },
    mapSources: [{ id: "test-map", label: "Test map", style }]
  },
  snapshot: emptySnapshot(),
  health: { running: false, healthy: false, degraded: false },
  reconnect: vi.fn(),
  submitCommand: vi.fn(),
  updateGeometry: vi.fn()
};

describe("MapConsole map boundary", () => {
  it("keeps the command shell usable while MapView is still loading", async () => {
    render(
      <AtlasStaticProvider value={atlasValue}>
        <MapConsole />
      </AtlasStaticProvider>
    );

    expect(screen.getByRole("button", { name: "Assets" })).toBeVisible();
    expect(await screen.findByText("Loading map workspace…")).toBeVisible();

    mapViewModule.resolve({ MapView: () => <div data-testid="loaded-map" /> });
    expect(await screen.findByTestId("loaded-map")).toBeInTheDocument();
  });
});
