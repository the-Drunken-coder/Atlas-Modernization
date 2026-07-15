import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { parseCommandCatalog } from "../atlas/command-model.js";
import type { AtlasDataSource, CatalogUpdate, CommandSubmission, ConnectionHealth } from "../atlas/data-source.js";
import type { UiGeometry } from "../atlas/geometry.js";
import type { AtlasSnapshot } from "../atlas/store.js";
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
    {
      id: "set_speed",
      name: "Set Speed",
      description: "Set travel speed.",
      parameters_schema: { speed: { type: "number", description: "Speed", minimum: 0, required: true } }
    },
    { id: "return_to_home", name: "Return To Home", description: "Go home.", parameters_schema: {} }
  ]
});

const rover: EntityResource = {
  entity_id: "asset-1",
  entity_type: "asset",
  subtype: null,
  alias: "Rover",
  components: { task_catalog: { supported_tasks: ["hold_position", "goto", "set_speed"] }, telemetry: { latitude: 40, longitude: -74 } },
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
  let current: AtlasSnapshot = { entities: { [rover.entity_id]: rover, [geofeature.entity_id]: geofeature }, tasks: {} };
  let currentHealth = health;
  let notify: ((snapshot: AtlasSnapshot) => void) | undefined;
  let notifyCatalog: ((update: CatalogUpdate) => void) | undefined;
  const submissions: CommandSubmission[] = [];
  const geometryUpdates: Array<{ entityId: string; geometry: UiGeometry; ifMatchVersion?: number }> = [];
  const fake: AtlasDataSource = {
    snapshot() {
      return current;
    },
    async loadCommandCatalog() {
      return catalog;
    },
    watch(onSnapshot, onCatalog) {
      notify = onSnapshot;
      notifyCatalog = onCatalog;
      return () => {
        notify = undefined;
        notifyCatalog = undefined;
      };
    },
    async start() {},
    health() {
      return currentHealth;
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
      current = { ...current, tasks: { ...current.tasks, [task.task_id]: task } };
      notify?.(current);
      return task;
    },
    async updateGeometry(entityId, geometry, ifMatchVersion) {
      geometryUpdates.push({ entityId, geometry, ifMatchVersion });
      const updated = { ...geofeature, components: { ...geofeature.components, geometry }, metadata: { ...geofeature.metadata, version: 10 } };
      current = { ...current, entities: { ...current.entities, [updated.entity_id]: updated } };
      notify?.(current);
      return updated;
    },
    dispose() {}
  };
  return {
    fake,
    submissions,
    geometryUpdates,
    emit: (snapshot: AtlasSnapshot) => {
      current = snapshot;
      notify?.(snapshot);
    },
    emitCatalog: (update: CatalogUpdate) => notifyCatalog?.(update),
    setHealth: (next: ConnectionHealth) => {
      currentHealth = next;
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

  it("closes an open command form when the live catalog becomes unavailable", async () => {
    const user = userEvent.setup();
    const { fake, emitCatalog, submissions } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByText("Rover"));
    await user.click(await screen.findByRole("button", { name: /Set Speed/ }));
    expect(screen.getByRole("dialog", { name: "Send Set Speed" })).toBeInTheDocument();

    act(() => emitCatalog({ status: "failed" }));

    expect(screen.queryByRole("dialog", { name: "Send Set Speed" })).not.toBeInTheDocument();
    expect(submissions).toHaveLength(0);
  });

  it("keeps a hidden command pending until Core responds", async () => {
    const user = userEvent.setup();
    const { fake, emitCatalog } = makeFakeDataSource();
    const reject: Array<(reason?: unknown) => void> = [];
    fake.submitCommand = async () => {
      await new Promise((_, rejectSubmission) => reject.push(rejectSubmission));
      throw new Error("unreachable");
    };
    renderConsole(fake);

    await user.click(await screen.findByText("Rover"));
    await user.click(await screen.findByRole("button", { name: /Set Speed/ }));
    await user.type(screen.getByRole("spinbutton", { name: /speed/ }), "10");
    await user.click(screen.getByRole("button", { name: "Send command" }));

    act(() => emitCatalog({ status: "failed" }));
    expect(await screen.findByText("Command submission pending…")).toBeInTheDocument();

    act(() => emitCatalog({ status: "loaded", catalog }));
    await user.click(await screen.findByRole("button", { name: /Set Speed/ }));
    expect(screen.queryByRole("dialog", { name: "Send Set Speed" })).not.toBeInTheDocument();

    await act(async () => {
      reject[0](new Error("Core response failed"));
      await Promise.resolve();
    });
    expect(screen.queryByText("Core response failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Send Set Speed" })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /Set Speed/ }));
    expect(screen.getByRole("dialog", { name: "Send Set Speed" })).toBeInTheDocument();
  });

  it("does not change the map reticle target when sidebar rows are hovered", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    const rover = await screen.findByRole("button", { name: /Rover/ });
    await user.hover(rover);

    expect(screen.getByTestId("map")).toHaveAttribute("data-focus-target", "");

    await user.unhover(rover);

    expect(screen.getByTestId("map")).toHaveAttribute("data-focus-target", "");
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

  it("shows repeated startup failures and returns to Online after recovery", async () => {
    const user = userEvent.setup();
    const failedDispose = vi.fn();
    const retryFailedDispose = vi.fn();
    const failing: AtlasDataSource = {
      ...makeFakeDataSource().fake,
      async start() {
        throw new Error("Core startup failed");
      },
      dispose: failedDispose
    };
    const retryFailed: AtlasDataSource = {
      ...makeFakeDataSource().fake,
      async start() {
        throw new Error("Core retry failed");
      },
      dispose: retryFailedDispose
    };
    const recovered = makeFakeDataSource().fake;
    const createDataSource = vi.fn().mockReturnValueOnce(failing).mockReturnValueOnce(retryFailed).mockReturnValueOnce(recovered);

    render(
      <AtlasProvider loadConfig={async () => appConfig()} createDataSource={createDataSource}>
        <MapConsole />
      </AtlasProvider>
    );

    const initialBadge = await screen.findByRole("button", { name: "Atlas connection error" });
    await user.click(initialBadge);
    expect(screen.getByText("Core startup failed")).toBeInTheDocument();
    expect(createDataSource).toHaveBeenCalledTimes(1);
    expect(failedDispose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    const retryBadge = await screen.findByRole("button", { name: "Atlas connection error" });
    expect(document.activeElement).toBe(retryBadge.parentElement);
    await user.click(retryBadge);
    expect(screen.getByText("Core retry failed")).toBeInTheDocument();
    expect(createDataSource).toHaveBeenCalledTimes(2);
    expect(retryFailedDispose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByText("Rover")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Atlas connection Online" })).toHaveTextContent("Online");
    expect(createDataSource).toHaveBeenCalledTimes(3);
    expect(failedDispose).toHaveBeenCalledTimes(1);
  });

  it("opens error details by keyboard and restores focus safely on close", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource(area, {
      running: true,
      healthy: false,
      degraded: true,
      error: { source: "live-sync", message: "feed websocket failed at https://user:password@example.test?api_key=secret Bearer token" }
    });
    renderConsole(fake);

    const badge = await screen.findByRole("button", { name: "Atlas connection error" });
    badge.focus();
    await user.keyboard("{Enter}");

    const close = await screen.findByRole("button", { name: "Close connection details" });
    expect(document.activeElement).toBe(close);
    const dialog = screen.getByRole("dialog", { name: "Atlas Core connection error" });
    expect(dialog).toHaveTextContent("Retrying automatically…");
    expect(dialog).not.toHaveTextContent("user:password");
    expect(dialog).not.toHaveTextContent("secret");
    expect(dialog).not.toHaveTextContent("Bearer token");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Atlas Core connection error" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(badge);
  });

  it("closes details and preserves a focus target when recovery clears the error", async () => {
    vi.useFakeTimers();
    const failingHealth: ConnectionHealth = {
      running: true,
      healthy: false,
      degraded: true,
      error: { source: "live-sync", message: "feed websocket failed to open" }
    };
    const { fake, setHealth } = makeFakeDataSource(area, failingHealth);
    try {
      renderConsole(fake);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const badge = screen.getByRole("button", { name: "Atlas connection error" });
      const focusAnchor = badge.parentElement;
      fireEvent.click(badge);
      setHealth(healthyConnection);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.queryByRole("dialog", { name: "Atlas Core connection error" })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(focusAnchor);
    } finally {
      vi.useRealTimers();
    }
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
      entities: { [rover.entity_id]: rover, [area.entity_id]: { ...area, metadata: { ...area.metadata, version: 7 } } },
      tasks: {}
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
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "openstreetmap-default");

    const mapSelect = screen.getByLabelText("Map");
    const options = Array.from(mapSelect.querySelectorAll("option"));
    expect(options.map((option) => option.textContent)).toEqual(["Google Satellite (missing key)", "OpenStreetMap Default", "USGS Topo"]);
    expect(options[0]).toBeDisabled();
    expect(options[1]).not.toBeDisabled();

    await user.selectOptions(mapSelect, "usgs-topo");

    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "usgs-topo");
  });

  it("starts with the configured MapTiler OSM Dark default", async () => {
    const { fake } = makeFakeDataSource();
    renderConsole(
      fake,
      appConfig({
        defaultMapSourceId: "maptiler-osm-dark",
        mapSources: [
          { id: "maptiler-osm-dark", label: "MapTiler OSM Dark", style: style("maptiler-osm-dark") },
          { id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") }
        ]
      })
    );

    await screen.findByText("Rover");
    expect(screen.getByLabelText("Map")).toHaveValue("maptiler-osm-dark");
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "maptiler-osm-dark");
  });

  it("does not silently fall back when the configured default map source is unavailable", async () => {
    const { fake } = makeFakeDataSource(area, {
      running: false,
      healthy: false,
      degraded: false,
      error: { source: "startup", message: "Core unavailable" }
    });
    renderConsole(
      fake,
      appConfig({
        defaultMapSourceId: "maptiler-osm-dark",
        mapSources: [
          { id: "maptiler-osm-dark", label: "MapTiler OSM Dark", unavailableReason: "missing key" },
          { id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") }
        ]
      })
    );

    expect(await screen.findByText("The configured default map source is unavailable.")).toBeInTheDocument();
    expect(screen.getByLabelText("Map")).toHaveValue("maptiler-osm-dark");
    expect(screen.queryByTestId("map")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atlas connection error" })).toBeInTheDocument();
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
    const { fake, emit } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    await user.click(await screen.findByText("Area Alpha"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("map")).toHaveAttribute("data-editing", "true");

    emit({ entities: { [rover.entity_id]: rover }, tasks: {} });

    expect(await screen.findByText("This item is no longer available.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("map")).toHaveAttribute("data-editing", "false"));
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
