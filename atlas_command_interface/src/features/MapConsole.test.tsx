import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource } from "../../../atlas_sdk/src/index.js";
import { parseCommandCatalog } from "../atlas/command-model.js";
import type { AtlasDataSource, CommandSubmission, ConnectionHealth } from "../atlas/data-source.js";
import type { AtlasSnapshot } from "../atlas/store.js";
import type { UiGeometry } from "../atlas/geometry.js";
import type { AppConfig } from "../app/config.js";
import { AtlasProvider } from "../state/atlas-context.js";
import { MapConsole } from "./MapConsole.js";

type MockMapViewProps = {
  styleId: string;
  editing?: unknown;
  focusTarget?: { id: string } | null;
  cameraCommand?: { seq: number; target: { id: string } } | null;
  onMapContextMenu?: (info: { lat: number; lng: number; x: number; y: number }) => void;
  onBackgroundClick?: () => void;
  onSelectEntity?: (id: string) => void;
  onStyleSwitchError?: (error: { failedStyleId: string; activeStyleId: string }) => void;
  previewTarget?: { id: string } | null;
};

const mapViewMock = vi.hoisted(() => ({ lastProps: undefined as MockMapViewProps | undefined }));

// MapLibre never runs in jsdom; stub the map but keep the real source builder.
vi.mock("../ui/map/MapView.js", async () => {
  const sources = await import("../ui/map/map-sources.js");
  return {
    MapView: (props: MockMapViewProps) => {
      mapViewMock.lastProps = props;
      return (
        <div
          data-testid="map"
          data-style-id={props.styleId}
          data-editing={props.editing ? "true" : "false"}
          data-focus-target={props.focusTarget?.id ?? ""}
          data-preview-target={props.previewTarget?.id ?? ""}
          data-camera-seq={props.cameraCommand?.seq ?? ""}
          data-camera-target={props.cameraCommand?.target.id ?? ""}
          onClick={() => props.onBackgroundClick?.()}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onMapContextMenu?.({ lat: 47.61, lng: -122.33, x: 10, y: 20 });
          }}
        >
          <button
            type="button"
            data-testid="map-marker-select"
            onClick={(event) => {
              event.stopPropagation();
              props.onSelectEntity?.("asset-1");
            }}
          />
        </div>
      );
    },
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

const healthyConnection: ConnectionHealth = { running: true, healthy: true, degraded: false };

function makeFakeDataSource(geofeature: EntityResource = area, health: ConnectionHealth = healthyConnection) {
  let notify: (() => void) | undefined;
  let snapshot: AtlasSnapshot = { entities: { [rover.entity_id]: rover, [geofeature.entity_id]: geofeature }, tasks: {} };
  const submissions: CommandSubmission[] = [];
  const geometryUpdates: Array<{ entityId: string; geometry: UiGeometry; ifMatchVersion?: number }> = [];
  const fake: AtlasDataSource = {
    snapshot() {
      return snapshot;
    },
    async loadCommandCatalog() {
      return catalog;
    },
    watch(onSnapshotChange) {
      notify = onSnapshotChange;
      return () => {
        notify = undefined;
      };
    },
    async start() {},
    health() {
      return health;
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
      snapshot = { ...snapshot, tasks: { ...snapshot.tasks, [task.task_id]: task } };
      notify?.();
      return task;
    },
    async updateGeometry(entityId, geometry, ifMatchVersion) {
      geometryUpdates.push({ entityId, geometry, ifMatchVersion });
      const updated = { ...geofeature, components: { ...geofeature.components, geometry }, metadata: { ...geofeature.metadata, version: 10 } };
      snapshot = { ...snapshot, entities: { ...snapshot.entities, [entityId]: updated } };
      notify?.();
      return updated;
    },
    dispose() {}
  };
  return {
    fake,
    submissions,
    geometryUpdates,
    setEntity: (entity: EntityResource) => {
      snapshot = { ...snapshot, entities: { ...snapshot.entities, [entity.entity_id]: entity } };
      notify?.();
    },
    deleteEntity: (entityId: string) => {
      const entities = { ...snapshot.entities };
      delete entities[entityId];
      snapshot = { ...snapshot, entities };
      notify?.();
    }
  };
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    atlasBaseUrl: "/atlas",
    protocolRevision: "rev",
    defaultMapSourceId: "openstreetmap-default",
    mapSources: [
      { id: "google-satellite", label: "Google Satellite", unavailableReason: "missing key" },
      { id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") },
      { id: "usgs-topo", label: "USGS Topo", style: style("usgs-topo") }
    ],
    ...overrides
  };
}

function style(id: string): StyleSpecification {
  return { version: 8, sources: {}, layers: [], metadata: { id } };
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

  it("passes hovered sidebar entities to the map as preview targets", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    const rover = await screen.findByRole("button", { name: /Rover/ });
    await user.hover(rover);

    expect(screen.getByTestId("map")).toHaveAttribute("data-preview-target", "asset-1");

    await user.unhover(rover);

    expect(screen.getByTestId("map")).toHaveAttribute("data-preview-target", "");
  });

  it("passes selected sidebar entities to the map as focus targets", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByRole("button", { name: /Rover/ }));

    expect(screen.getByTestId("map")).toHaveAttribute("data-focus-target", "asset-1");
  });

  it("issues a camera command for sidebar selections and bumps the sequence on re-select", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByRole("button", { name: /Rover/ }));
    const map = screen.getByTestId("map");
    expect(map).toHaveAttribute("data-camera-target", "asset-1");
    expect(map).toHaveAttribute("data-camera-seq", "1");

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(await screen.findByRole("button", { name: /Rover/ }));

    expect(map).toHaveAttribute("data-camera-target", "asset-1");
    expect(map).toHaveAttribute("data-camera-seq", "2");
  });

  it("selects entities from map clicks without issuing a camera command", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);
    await screen.findByRole("button", { name: /Rover/ });

    await user.click(screen.getByTestId("map-marker-select"));

    expect(await screen.findByRole("button", { name: /Hold Position/ })).toBeInTheDocument();
    const map = screen.getByTestId("map");
    expect(map).toHaveAttribute("data-focus-target", "asset-1");
    expect(map).toHaveAttribute("data-camera-target", "");
    expect(map).toHaveAttribute("data-camera-seq", "");
  });

  it("releases the camera command when the selection clears", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByRole("button", { name: /Rover/ }));
    expect(screen.getByTestId("map")).toHaveAttribute("data-camera-target", "asset-1");

    await user.click(screen.getByTestId("map"));

    await waitFor(() => expect(screen.getByTestId("map")).toHaveAttribute("data-camera-target", ""));
    expect(screen.getByTestId("map")).toHaveAttribute("data-camera-seq", "");
  });

  it("surfaces degraded live-sync health on the map", async () => {
    const { fake } = makeFakeDataSource(area, { running: true, healthy: false, degraded: true });
    renderConsole(fake);

    expect(await screen.findByRole("status", { name: "Atlas connection Reconnecting" })).toHaveTextContent("Reconnecting");
  });

  it("saves geometry edits with the version captured when editing started", async () => {
    const user = userEvent.setup();
    const { fake, geometryUpdates, setEntity } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    await user.click(await screen.findByText("Area Alpha"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));

    setEntity({ ...area, metadata: { ...area.metadata, version: 7 } });

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
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "openstreetmap-default");

    const mapSelect = screen.getByLabelText("Map");
    const options = Array.from(mapSelect.querySelectorAll("option"));
    expect(options.map((option) => option.textContent)).toEqual(["Google Satellite (missing key)", "OpenStreetMap Default", "USGS Topo"]);
    expect(options[0]).toBeDisabled();
    expect(options[1]).not.toBeDisabled();

    await user.selectOptions(mapSelect, "usgs-topo");

    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "usgs-topo");
  });

  it("reverts the map selector when a style switch fails", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    const mapSelect = screen.getByLabelText("Map");

    await user.selectOptions(mapSelect, "usgs-topo");
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "usgs-topo");

    act(() => {
      mapViewMock.lastProps?.onStyleSwitchError?.({
        failedStyleId: "usgs-topo",
        activeStyleId: "openstreetmap-default"
      });
    });

    await waitFor(() => expect(mapSelect).toHaveValue("openstreetmap-default"));
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "openstreetmap-default");
  });

  it("falls back when the configured default is the only available map source", async () => {
    const { fake } = makeFakeDataSource();
    renderConsole(
      fake,
      appConfig({
        defaultMapSourceId: "usgs-topo",
        mapSources: [{ id: "usgs-topo", label: "USGS Topo", style: style("usgs-topo") }]
      })
    );

    await screen.findByText("Rover");
    expect(screen.getByLabelText("Map")).toHaveValue("usgs-topo");
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "usgs-topo");
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
    const { fake, deleteEntity } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    await user.click(await screen.findByText("Area Alpha"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("map")).toHaveAttribute("data-editing", "true");

    deleteEntity("geo-1");

    expect(await screen.findByText("This item is no longer available.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("map")).toHaveAttribute("data-editing", "false"));
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
