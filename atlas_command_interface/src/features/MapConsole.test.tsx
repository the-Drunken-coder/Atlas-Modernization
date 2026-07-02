import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AtlasWatchEvent, EntityResource } from "../../../atlas_sdk/src/index.js";
import { parseCommandCatalog } from "../atlas/command-model.js";
import type { AtlasDataSource, CommandSubmission } from "../atlas/data-source.js";
import type { UiGeometry } from "../atlas/geometry.js";
import type { AppConfig } from "../app/config.js";
import { AtlasProvider } from "../state/atlas-context.js";
import { MapConsole } from "./MapConsole.js";

// MapLibre never runs in jsdom; stub the map but keep the real source builder.
vi.mock("../ui/map/MapView.js", async () => {
  const sources = await import("../ui/map/map-sources.js");
  return {
    MapView: (props: {
      styleUrl: string;
      editing?: unknown;
      onMapContextMenu?: (info: { lat: number; lng: number; x: number; y: number }) => void;
      onBackgroundClick?: () => void;
    }) => (
      <div
        data-testid="map"
        data-style-url={props.styleUrl}
        data-editing={props.editing ? "true" : "false"}
        onClick={() => props.onBackgroundClick?.()}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onMapContextMenu?.({ lat: 47.61, lng: -122.33, x: 10, y: 20 });
        }}
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
  commands: [
    { id: "hold_position", name: "Hold Position", description: "Hold here.", parameters_schema: {} },
    {
      id: "goto",
      name: "Goto",
      description: "Go there.",
      parameters_schema: {
        latitude: { type: "number", description: "Latitude", minimum: -90, maximum: 90, required: true },
        longitude: { type: "number", description: "Longitude", minimum: -180, maximum: 180, required: true }
      }
    },
    { id: "return_to_home", name: "Return To Home", description: "Go home.", parameters_schema: {} }
  ]
});

const rover: EntityResource = {
  entity_id: "asset-1",
  entity_type: "asset",
  subtype: null,
  alias: "Rover",
  components: { task_catalog: { supported_tasks: ["hold_position", "goto"] }, telemetry: { latitude: 40, longitude: -74 } },
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
const circleArea: EntityResource = {
  ...area,
  components: {
    geometry: {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-74, 40] },
      properties: { shape: "circle", radius_m: 500 }
    }
  }
};

function makeFakeDataSource(geofeature: EntityResource = area) {
  let emit: ((event: AtlasWatchEvent) => void) | undefined;
  const submissions: CommandSubmission[] = [];
  const geometryUpdates: Array<{ entityId: string; geometry: UiGeometry; ifMatchVersion?: number }> = [];
  const fake: AtlasDataSource = {
    async loadSnapshot() {
      return { entities: [rover, geofeature], tasks: [] };
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
    async submitCommand(submission) {
      submissions.push(submission);
      const task = {
        task_id: "task-1",
        status: "pending",
        entity_id: submission.entityId,
        components: { command: { type: submission.command.id, id: submission.command.id }, parameters: submission.parameters ?? {} },
        metadata: { ...metadata, version: 2 }
      };
      emit?.({ event: "create", resource_type: "task", id: task.task_id, version: 2, resource: task });
      return task;
    },
    async updateGeometry(entityId, geometry, ifMatchVersion) {
      geometryUpdates.push({ entityId, geometry, ifMatchVersion });
      return { ...geofeature, components: { ...geofeature.components, geometry }, metadata: { ...geofeature.metadata, version: 10 } };
    },
    dispose() {}
  };
  return { fake, submissions, geometryUpdates, emit: (event: AtlasWatchEvent) => emit?.(event) };
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    atlasBaseUrl: "/atlas",
    protocolRevision: "rev",
    defaultMapSourceId: "maptiler-osm-dark",
    mapSources: [
      { id: "maptiler-osm-dark", label: "MapTiler OSM Dark", styleUrl: "/maps/styles/maptiler-osm-dark.json" },
      { id: "esri-world-imagery", label: "Esri World Imagery", styleUrl: "/maps/styles/esri-world-imagery.json" }
    ],
    ...overrides
  };
}

function renderConsole(fake: AtlasDataSource, config: AppConfig = appConfig()) {
  return render(
    <AtlasProvider loadConfig={async () => config} createDataSource={() => fake}>
      <MapConsole />
    </AtlasProvider>
  );
}

describe("MapConsole command flow", () => {
  it("selects an asset, lists its commands, and submits a pending task", async () => {
    const user = userEvent.setup();
    const { fake, submissions } = makeFakeDataSource();
    renderConsole(fake);

    // Default assets list renders once the snapshot is ready.
    const row = await screen.findByText("Rover");
    await user.click(row);

    // The asset inspector lists the supported command and greys out the rest.
    const hold = await screen.findByRole("button", { name: /Hold Position/ });
    expect(screen.getByRole("button", { name: /Return To Home/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Return To Home/ })).toHaveAttribute("title", "This asset does not support this command");

    await user.click(hold);
    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]).toMatchObject({ entityId: "asset-1", command: { id: "hold_position" } });

    // The created task arrives over the feed and shows as pending in history.
    expect(await screen.findByText("Pending")).toBeInTheDocument();
  });

  it("saves geometry edits with the version captured when editing started", async () => {
    const user = userEvent.setup();
    const { fake, geometryUpdates, emit } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    await user.click(await screen.findByText("Area Alpha"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));

    emit({
      event: "update",
      resource_type: "entity",
      id: "geo-1",
      version: 7,
      resource: { ...area, metadata: { ...area.metadata, version: 7 } }
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(geometryUpdates).toHaveLength(1));
    expect(geometryUpdates[0]).toEqual({ entityId: "geo-1", geometry: area.components.geometry, ifMatchVersion: 1 });
  });

  it("saves circle Feature drafts without replacing them with display polygons", async () => {
    const user = userEvent.setup();
    const { fake, geometryUpdates } = makeFakeDataSource(circleArea);
    renderConsole(fake);

    await screen.findByText("Rover");
    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    await user.click(await screen.findByText("Area Alpha"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(geometryUpdates).toHaveLength(1));
    expect(geometryUpdates[0].geometry).toEqual(circleArea.components.geometry);
  });

  it("submits map-point commands with the clicked coordinates", async () => {
    const user = userEvent.setup();
    const { fake, submissions } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByText("Rover"));
    fireEvent.contextMenu(screen.getByTestId("map"));
    await user.click(await screen.findByRole("menuitem", { name: /Goto/ }));

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]).toMatchObject({ entityId: "asset-1", command: { id: "goto" }, parameters: { latitude: 47.61, longitude: -122.33 } });
  });

  it("switches between configured map sources", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-url", "/maps/styles/maptiler-osm-dark.json");

    const mapSelect = screen.getByLabelText("Map");
    expect(Array.from(mapSelect.querySelectorAll("option")).map((option) => option.textContent)).toEqual(["MapTiler OSM Dark", "Esri World Imagery"]);

    await user.selectOptions(mapSelect, "esri-world-imagery");

    expect(screen.getByTestId("map")).toHaveAttribute("data-style-url", "/maps/styles/esri-world-imagery.json");
  });

  it("falls back when the configured default is the only available map source", async () => {
    const { fake } = makeFakeDataSource();
    renderConsole(
      fake,
      appConfig({
        defaultMapSourceId: "usgs-topo",
        mapSources: [{ id: "usgs-topo", label: "USGS Topo", styleUrl: "/maps/styles/usgs-topo.json" }]
      })
    );

    await screen.findByText("Rover");
    expect(screen.getByLabelText("Map")).toHaveValue("usgs-topo");
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-url", "/maps/styles/usgs-topo.json");
  });

  it("clears the selected entity when the map background is clicked", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByText("Rover"));
    expect(await screen.findByRole("button", { name: /Hold Position/ })).toBeInTheDocument();

    await user.click(screen.getByTestId("map"));

    await waitFor(() => expect(screen.queryByRole("button", { name: /Hold Position/ })).not.toBeInTheDocument());
    expect(screen.getByText("Rover")).toBeInTheDocument();
  });

  it("clears geofeature edit state when the selected entity disappears", async () => {
    const user = userEvent.setup();
    const { fake, emit } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    await user.click(await screen.findByText("Area Alpha"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("map")).toHaveAttribute("data-editing", "true");

    emit({ event: "delete", resource_type: "entity", id: "geo-1", version: 2 });

    expect(await screen.findByText("This item is no longer available.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("map")).toHaveAttribute("data-editing", "false"));
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
