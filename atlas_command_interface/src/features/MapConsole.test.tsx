import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CommandCatalog, EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import { styleFixture as style } from "../../test/fixtures.js";
import type { AppConfig } from "../app/config.js";
import type { AtlasDataSource, CommandSubmission, ConnectionHealth } from "../atlas/data-source.js";
import type { UiGeometry } from "../atlas/geometry.js";
import type { AtlasSnapshot } from "../atlas/store.js";
import { type AtlasContextValue, AtlasProvider, AtlasStaticProvider } from "../state/atlas-context.js";
import { MapConsole } from "./MapConsole.js";

type MockMapViewProps = {
  styleId: string;
  mapSourceOptions: AppConfig["mapSources"];
  editing?: unknown;
  focusTarget?: { id: string } | null;
  placeDetailTarget?: { id: string } | null;
  cameraCommand?:
    | { seq: number; intent: "world" }
    | { seq: number; target: { id: string }; intent?: "focus" | "preview" | "commit" }
    | null;
  onMapContextMenu?: (info: { lat: number; lng: number; x: number; y: number }) => void;
  onBackgroundClick?: () => void;
  onSelectEntity?: (id: string) => void;
  onStyleSwitchError?: (error: { failedStyleId: string; activeStyleId: string }) => void;
};

const mapViewMock = vi.hoisted(() => ({ lastProps: undefined as MockMapViewProps | undefined }));

// MapLibre never runs in jsdom; stub the map but keep the real source builder.
vi.mock("../ui/map/view/MapView.js", async () => {
  const sources = await import("../ui/map/rendering/map-sources.js");
  return {
    MapView: (props: MockMapViewProps) => {
      mapViewMock.lastProps = props;
      const cameraTarget = props.cameraCommand && "target" in props.cameraCommand ? props.cameraCommand.target.id : "";
      return (
        <div
          data-testid="map"
          data-style-id={props.styleId}
          data-editing={props.editing ? "true" : "false"}
          data-focus-target={props.focusTarget?.id ?? ""}
          data-place-detail-target={props.placeDetailTarget?.id ?? ""}
          data-camera-seq={props.cameraCommand?.seq ?? ""}
          data-camera-target={cameraTarget}
          data-camera-intent={props.cameraCommand?.intent ?? ""}
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

const catalog: CommandCatalog = [];
const taskingCatalog: CommandCatalog = [
  {
    command: "fixture.queued",
    name: "Fixture queued",
    description: "Exercise tasking.",
    input_schema: "atlas.protocol.JSONValue"
  }
];

const rover: EntityResource = {
  entity_id: "asset-1",
  entity_type: "asset",
  subtype: null,
  alias: "Rover",
  components: {
    telemetry: { latitude: 40, longitude: -74 }
  },
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
  let current: AtlasSnapshot = {
    entities: { [rover.entity_id]: rover, [geofeature.entity_id]: geofeature },
    tasks: {}
  };
  let currentHealth = health;
  let notify: ((snapshot: AtlasSnapshot) => void) | undefined;
  const submissions: CommandSubmission[] = [];
  const geometryUpdates: Array<{ entityId: string; geometry: UiGeometry; ifMatchVersion?: number }> = [];
  const fake: AtlasDataSource = {
    snapshot() {
      return current;
    },
    async loadCommandCatalog() {
      return catalog;
    },
    watch(onSnapshot) {
      notify = onSnapshot;
      return () => {
        notify = undefined;
      };
    },
    async start() {},
    health() {
      return currentHealth;
    },
    async submitCommand(submission) {
      submissions.push(submission);
      const task: TaskResource = {
        task_id: "task-1",
        status: "pending",
        asset_id: submission.assetId,
        command: submission.command.command,
        input: submission.input,
        created_at: "2026-06-20T00:00:00Z",
        updated_at: "2026-06-20T00:00:00Z"
      };
      current = { ...current, tasks: { ...current.tasks, [task.task_id]: task } };
      notify?.(current);
      return task;
    },
    async updateGeometry(entityId, geometry, ifMatchVersion) {
      geometryUpdates.push({ entityId, geometry, ifMatchVersion });
      const updated = {
        ...geofeature,
        components: { ...geofeature.components, geometry },
        metadata: { ...geofeature.metadata, version: 10 }
      };
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
    placeSearch: { provider: "maptiler", unavailableReason: "missing key" },
    mapSources: [
      { id: "google-satellite", label: "Google Satellite", unavailableReason: "missing key" },
      { id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") },
      { id: "usgs-topo", label: "USGS Topo", style: style("usgs-topo") }
    ],
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderConsole(fake: AtlasDataSource, config: AppConfig = appConfig()) {
  return render(
    <AtlasProvider loadConfig={async () => config} createDataSource={() => fake}>
      <MapConsole />
    </AtlasProvider>
  );
}

function renderStaticConsole(overrides: Partial<AtlasContextValue> = {}) {
  const snapshot = makeFakeDataSource().fake.snapshot();
  const value: AtlasContextValue = {
    status: "ready",
    config: appConfig(),
    snapshot,
    catalog,
    health: healthyConnection,
    reconnect: vi.fn(),
    submitCommand: async () => {
      throw new Error("not used");
    },
    updateGeometry: async () => {
      throw new Error("not used");
    },
    ...overrides
  };
  return render(
    <AtlasStaticProvider value={value}>
      <MapConsole />
    </AtlasStaticProvider>
  );
}

describe("MapConsole", () => {
  it("shows the intentional no-Commands state for the empty Protocol catalog", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByText("Rover"));
    expect(screen.getByText("No Commands are defined in Atlas Protocol")).toBeInTheDocument();
  });

  it("keeps one Asset detail request alive across telemetry snapshot replacements", async () => {
    const user = userEvent.setup();
    const pending = deferred<EntityResource>();
    const loadEntityDetails = vi.fn(() => pending.promise);
    const baseValue: AtlasContextValue = {
      status: "ready",
      config: appConfig(),
      snapshot: { entities: { [rover.entity_id]: rover }, tasks: {} },
      catalog: taskingCatalog,
      health: healthyConnection,
      reconnect: vi.fn(),
      loadEntityDetails,
      submitCommand: async () => {
        throw new Error("not used");
      },
      updateGeometry: async () => {
        throw new Error("not used");
      }
    };
    const view = render(
      <AtlasStaticProvider value={baseValue}>
        <MapConsole />
      </AtlasStaticProvider>
    );

    await user.click(await screen.findByText("Rover"));
    await user.click(screen.getByRole("button", { name: /Commands/ }));
    expect(screen.getByText("Loading Asset Commands")).toBeInTheDocument();
    expect(loadEntityDetails).toHaveBeenCalledOnce();

    view.rerender(
      <AtlasStaticProvider
        value={{
          ...baseValue,
          snapshot: {
            entities: {
              [rover.entity_id]: {
                ...rover,
                components: { telemetry: { latitude: 40.1, longitude: -74.1 } },
                metadata: { ...rover.metadata, version: 2 }
              }
            },
            tasks: {}
          }
        }}
      >
        <MapConsole />
      </AtlasStaticProvider>
    );
    expect(loadEntityDetails).toHaveBeenCalledOnce();

    pending.resolve({ ...rover, command_manifest: [] });
    expect(await screen.findByText("This Asset has no Commands")).toBeInTheDocument();
  });

  it("reports unavailable Asset Commands when detail loading fails", async () => {
    const user = userEvent.setup();
    const pending = deferred<EntityResource>();
    renderStaticConsole({
      catalog: taskingCatalog,
      loadEntityDetails: () => pending.promise
    });

    await user.click(await screen.findByText("Rover"));
    await user.click(screen.getByRole("button", { name: /Commands/ }));
    pending.reject(new Error("details unavailable"));

    expect(await screen.findByText("Asset Commands unavailable")).toBeInTheDocument();
    expect(screen.queryByText("This Asset has no Commands")).not.toBeInTheDocument();
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

  it("previews places in the detail lens, commits focus, and returns to the world view", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          type: "FeatureCollection",
          attribution: "© MapTiler © OpenStreetMap contributors",
          features: [
            {
              id: "poi.1",
              text: "Worcester Polytechnic Institute",
              place_name: "Worcester Polytechnic Institute, Worcester, Massachusetts, United States",
              center: [-71.8063, 42.2746],
              place_type: ["poi"]
            }
          ]
        })
      )
    );
    try {
      renderStaticConsole({
        config: appConfig({ placeSearch: { provider: "maptiler", apiKey: "maptiler-key" } })
      });

      fireEvent.click(screen.getByRole("button", { name: /Rover/ }));
      await act(async () => Promise.resolve());
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-seq", "1");

      fireEvent.click(screen.getByRole("button", { name: "Places" }));
      const input = screen.getByRole("searchbox", { name: "Search places" });
      expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: "Worcester" } });
      await act(async () => vi.advanceTimersByTimeAsync(250));

      const result = screen.getByRole("button", {
        name: "Worcester Polytechnic Institute, Worcester, Massachusetts, United States"
      });
      fireEvent.mouseEnter(result);
      expect(screen.getByTestId("map")).toHaveAttribute("data-focus-target", "");
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-target", "asset-1");
      await act(async () => vi.advanceTimersByTimeAsync(249));
      expect(screen.getByTestId("map")).toHaveAttribute("data-place-detail-target", "");
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByTestId("map")).toHaveAttribute("data-focus-target", "place:poi.1");
      expect(screen.getByTestId("map")).toHaveAttribute("data-place-detail-target", "place:poi.1");
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-target", "asset-1");

      fireEvent.click(result);
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-target", "place:poi.1");
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-seq", "2");
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-intent", "commit");
      expect(screen.getByTestId("map")).toHaveAttribute("data-focus-target", "place:poi.1");
      expect(screen.getByTestId("map")).toHaveAttribute("data-place-detail-target", "");
      await act(async () => Promise.resolve());
      expect(screen.getByTestId("map")).toHaveAttribute("data-focus-target", "place:poi.1");

      const worldView = screen.getByRole("button", { name: "World view" });
      expect(worldView).toHaveAttribute("title", "World view");
      expect(worldView).not.toHaveTextContent("World view");
      expect(worldView.querySelector("svg")).not.toBeNull();
      fireEvent.click(worldView);
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-target", "");
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-intent", "world");
      expect(screen.getByTestId("map")).toHaveAttribute("data-camera-seq", "3");
      expect(screen.getByTestId("map")).toHaveAttribute("data-focus-target", "");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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

  it("retains each entity-list filter through inspector navigation", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    const assetFilter = await screen.findByRole("searchbox", { name: "Filter entities" });
    await user.type(assetFilter, "Rov");
    await user.click(screen.getByRole("button", { name: /Rover/ }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("searchbox", { name: "Filter entities" })).toHaveValue("Rov");

    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    const geofeatureFilter = screen.getByRole("searchbox", { name: "Filter entities" });
    expect(geofeatureFilter).toHaveValue("");
    await user.type(geofeatureFilter, "Alpha");

    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(screen.getByRole("searchbox", { name: "Filter entities" })).toHaveValue("Rov");
  });

  it("selects entities from map clicks without issuing a camera command", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);
    await screen.findByRole("button", { name: /Rover/ });

    await user.click(screen.getByTestId("map-marker-select"));

    expect(await screen.findByText("No Commands are defined in Atlas Protocol")).toBeInTheDocument();
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

    expect(await screen.findByRole("status", { name: "Atlas connection Reconnecting" })).toHaveTextContent(
      "Reconnecting"
    );
  });

  it("announces a connection error without opening its details", async () => {
    renderStaticConsole({
      connectionError: { source: "live-sync", message: "feed connection failed" },
      health: { running: true, healthy: false, degraded: true }
    });

    expect(await screen.findByRole("status", { name: "Atlas connection Connection error" })).toHaveTextContent(
      "Connection error"
    );
    expect(screen.queryByRole("dialog", { name: "Atlas Core connection error" })).not.toBeInTheDocument();
  });

  it("sanitizes a fallback health error before rendering details", async () => {
    const user = userEvent.setup();
    renderStaticConsole({
      health: {
        running: true,
        healthy: false,
        degraded: true,
        error: {
          source: "live-sync",
          message: "Atlas request failed: https://user:password@example.test?api_key=secret Bearer token"
        }
      }
    });

    await user.click(await screen.findByRole("button", { name: "Atlas connection error" }));

    const dialog = screen.getByRole("dialog", { name: "Atlas Core connection error" });
    expect(dialog).toHaveTextContent("Atlas request failed");
    expect(dialog).not.toHaveTextContent("user:password");
    expect(dialog).not.toHaveTextContent("api_key=secret");
    expect(dialog).not.toHaveTextContent("secret");
    expect(dialog).not.toHaveTextContent("Bearer token");
  });

  it("sanitizes an explicit connection error before rendering details", async () => {
    const user = userEvent.setup();
    renderStaticConsole({
      connectionError: {
        source: "startup",
        message: "Atlas request failed: https://user:password@example.test?api_key=secret Bearer token"
      },
      health: { running: false, healthy: false, degraded: false }
    });

    await user.click(await screen.findByRole("button", { name: "Atlas connection error" }));

    const dialog = screen.getByRole("dialog", { name: "Atlas Core connection error" });
    expect(dialog).toHaveTextContent("Atlas request failed");
    expect(dialog).not.toHaveTextContent("user:password");
    expect(dialog).not.toHaveTextContent("api_key=secret");
    expect(dialog).not.toHaveTextContent("secret");
    expect(dialog).not.toHaveTextContent("Bearer token");
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
    const createDataSource = vi
      .fn()
      .mockReturnValueOnce(failing)
      .mockReturnValueOnce(retryFailed)
      .mockReturnValueOnce(recovered);

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
    expect(retryBadge).toHaveFocus();
    await user.click(retryBadge);
    expect(screen.getByText("Core retry failed")).toBeInTheDocument();
    expect(createDataSource).toHaveBeenCalledTimes(2);
    expect(retryFailedDispose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByText("Rover")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Atlas connection Online" })).toHaveTextContent("Online");
    expect(document.querySelector('.connection-badge[data-state="live"]')).toHaveFocus();
    expect(createDataSource).toHaveBeenCalledTimes(3);
    expect(failedDispose).toHaveBeenCalledTimes(1);
  });

  it("opens error details by keyboard and restores focus safely on close", async () => {
    const user = userEvent.setup();
    const mapEscape = vi.fn();
    const mapKeyListener = (event: KeyboardEvent) => {
      if (event.key === "Escape") mapEscape();
    };
    window.addEventListener("keydown", mapKeyListener);
    const { fake } = makeFakeDataSource(area, {
      running: true,
      healthy: false,
      degraded: true,
      error: {
        source: "live-sync",
        message: "feed websocket failed at https://user:password@example.test?api_key=secret Bearer token"
      }
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
    expect(mapEscape).not.toHaveBeenCalled();
    window.removeEventListener("keydown", mapKeyListener);
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
      fireEvent.click(badge);
      setHealth(healthyConnection);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.queryByRole("dialog", { name: "Atlas Core connection error" })).not.toBeInTheDocument();
      expect(document.querySelector('.connection-badge[data-state="live"]')).toHaveFocus();

      setHealth(failingHealth);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.getByRole("button", { name: "Atlas connection error" })).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves focus from a closed error badge to the recovered status", async () => {
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
      });
      screen.getByRole("button", { name: "Atlas connection error" }).focus();
      setHealth(healthyConnection);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

      expect(document.querySelector('.connection-badge[data-state="live"]')).toHaveFocus();
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

  it("ignores a geometry save that settles after selection changes", async () => {
    const user = userEvent.setup();
    let rejectUpdate!: (cause: Error) => void;
    const { fake } = makeFakeDataSource();
    fake.updateGeometry = () =>
      new Promise<never>((_resolve, reject) => {
        rejectUpdate = reject;
      });
    renderConsole(fake);

    await screen.findByText("Rover");
    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    await user.click(await screen.findByText("Area Alpha"));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Saving…" });

    await user.click(screen.getByTestId("map-marker-select"));
    rejectUpdate(new Error("late geometry failure"));

    await waitFor(() => expect(screen.queryByText("late geometry failure")).not.toBeInTheDocument());
    expect(screen.getByText("Asset")).toBeInTheDocument();
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

  it("switches between configured map sources", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    expect(await screen.findByTestId("map")).toHaveAttribute("data-style-id", "openstreetmap-default");

    const mapPicker = screen.getByLabelText("Map");
    expect(mapPicker).toHaveTextContent("OpenStreetMap Default");
    await user.click(mapPicker);

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.querySelector(".map-source-option__label")?.textContent)).toEqual([
      "OpenStreetMap Default",
      "Google Satellite",
      "USGS Topo"
    ]);
    expect(options[0]).not.toBeDisabled();
    expect(options[0]).toHaveAttribute("data-selected", "true");
    expect(options[1]).toBeDisabled();
    expect(options[1]).toHaveTextContent("missing key");

    await user.click(options[2]);

    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "usgs-topo");
    expect(mapPicker).toHaveTextContent("USGS Topo");
    expect(screen.queryByRole("listbox", { name: "Map" })).not.toBeInTheDocument();
  });

  it("supports keyboard navigation in the map source menu", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    const mapPicker = screen.getByLabelText("Map");
    mapPicker.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "OpenStreetMap Default" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "USGS Topo" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Map" })).not.toBeInTheDocument();
    expect(mapPicker).toHaveFocus();

    await user.click(mapPicker);
    await user.click(screen.getByText("Rover"));
    expect(screen.queryByRole("listbox", { name: "Map" })).not.toBeInTheDocument();
    mapPicker.focus();

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "usgs-topo");
    expect(mapPicker).toHaveFocus();
  });

  it("starts with the configured MapTiler OSM Dark default", async () => {
    const { fake } = makeFakeDataSource();
    const config = appConfig({
      defaultMapSourceId: "maptiler-osm-dark",
      mapSources: [
        { id: "maptiler-osm-dark", label: "MapTiler OSM Dark", style: style("maptiler-osm-dark") },
        { id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") }
      ]
    });
    renderConsole(fake, config);

    await screen.findByText("Rover");
    expect(screen.getByLabelText("Map")).toHaveTextContent("MapTiler OSM Dark");
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "maptiler-osm-dark");
    expect(mapViewMock.lastProps?.mapSourceOptions).toBe(config.mapSources);
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
    expect(screen.getByLabelText("Map")).toHaveTextContent("MapTiler OSM Dark");
    expect(screen.queryByTestId("map")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atlas connection error" })).toBeInTheDocument();
  });

  it("reverts the map selector when a style switch fails", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await screen.findByText("Rover");
    const mapPicker = screen.getByLabelText("Map");

    await user.click(mapPicker);
    await user.click(screen.getByRole("option", { name: "USGS Topo" }));
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "usgs-topo");

    act(() => {
      mapViewMock.lastProps?.onStyleSwitchError?.({
        failedStyleId: "usgs-topo",
        activeStyleId: "openstreetmap-default"
      });
    });

    await waitFor(() => expect(mapPicker).toHaveTextContent("OpenStreetMap Default"));
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
    expect(screen.getByLabelText("Map")).toHaveTextContent("USGS Topo");
    expect(screen.getByTestId("map")).toHaveAttribute("data-style-id", "usgs-topo");
  });

  it("clears the selected entity when the map background is clicked", async () => {
    const user = userEvent.setup();
    const { fake } = makeFakeDataSource();
    renderConsole(fake);

    await user.click(await screen.findByText("Rover"));
    expect(await screen.findByText("No Commands are defined in Atlas Protocol")).toBeInTheDocument();

    await user.click(screen.getByTestId("map"));

    await waitFor(() =>
      expect(screen.queryByText("No Commands are defined in Atlas Protocol")).not.toBeInTheDocument()
    );
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
