import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AtlasWatchEvent, EntityResource } from "../../../atlas_sdk/src/index.js";
import { parseCommandCatalog } from "../atlas/command-model.js";
import type { AtlasDataSource } from "../atlas/data-source.js";
import { AtlasProvider } from "../state/atlas-context.js";
import { MapConsole } from "./MapConsole.js";

vi.mock("../ui/map/MapView.js", async () => {
  const sources = await import("../ui/map/map-sources.js");
  return {
    MapView: (props: { sources: { assets: { features: unknown[] }; tracks: { features: unknown[] }; geofeatures: { features: unknown[] } } }) => (
      <div
        data-testid="map"
        data-feature-count={props.sources.assets.features.length + props.sources.tracks.features.length + props.sources.geofeatures.features.length}
      />
    ),
    buildMapSources: sources.buildMapSources
  };
});

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

const catalog = parseCommandCatalog({
  type: "command_catalog",
  name: "Catalog",
  description: "Test",
  commands: [{ id: "hold_position", name: "Hold Position", description: "Hold here.", parameters_schema: {} }]
});

const rover: EntityResource = {
  entity_id: "asset-1",
  entity_type: "asset",
  subtype: null,
  alias: "Rover",
  components: { task_catalog: { supported_tasks: ["hold_position"] }, telemetry: { latitude: 40, longitude: -74 } },
  metadata
};

const area: EntityResource = {
  entity_id: "geo-1",
  entity_type: "geofeature",
  subtype: null,
  alias: "Area Alpha",
  components: {
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-74, 40],
          [-73.9, 40],
          [-73.9, 40.1],
          [-74, 40]
        ]
      ]
    }
  },
  metadata
};

function makeFakeDataSource() {
  let emit: ((event: AtlasWatchEvent) => void) | undefined;
  const fake: AtlasDataSource = {
    async loadSnapshot() {
      return { entities: [rover, area], tasks: [] };
    },
    async loadCommandCatalog() {
      return catalog;
    },
    watch(onEvent) {
      emit = onEvent;
      return () => {
        emit = undefined;
      };
    },
    async start() {},
    health() {
      return { running: true, healthy: true, degraded: false };
    },
    async submitCommand() {
      throw new Error("not used");
    },
    async updateGeometry() {
      throw new Error("not used");
    },
    dispose() {}
  };
  return { fake, emit: (event: AtlasWatchEvent) => emit?.(event) };
}

function renderConsole(fake: AtlasDataSource) {
  return render(
    <AtlasProvider loadConfig={async () => ({ atlasBaseUrl: "/atlas", protocolRevision: "rev" })} createDataSource={() => fake}>
      <MapConsole />
    </AtlasProvider>
  );
}

describe("MapConsole read-only flow", () => {
  it("selects an asset and shows its read-only inspector", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByText("Rover"));

    expect(screen.getByText("asset-1")).toBeInTheDocument();
    expect(screen.getByText("Location & Movement")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hold Position/ })).not.toBeInTheDocument();
  });

  it("switches lists and inspects a geofeature without edit controls", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    await user.click(await screen.findByText("Area Alpha"));

    expect(screen.getByText("geo-1")).toBeInTheDocument();
    expect(screen.getByText("Polygon")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByTestId("map")).toHaveAttribute("data-feature-count", "2");
  });

  it("keeps the shell stable when the selected entity disappears", async () => {
    const user = userEvent.setup();
    const { fake, emit } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByText("Rover"));
    emit({ event: "delete", resource_type: "entity", id: "asset-1", version: 2 });

    expect(await screen.findByText("This item is no longer available.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("map")).toHaveAttribute("data-feature-count", "1"));
  });
});
