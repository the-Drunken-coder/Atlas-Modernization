import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CommandCatalog, EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import { entityFixture, metadataFixture, styleFixture } from "../../test/fixtures.js";
import type { AppConfig } from "../app/config.js";
import type { AtlasDataSource, ConnectionHealth } from "../atlas/data-source.js";
import type { AtlasSnapshot } from "../atlas/store.js";
import { AtlasProvider, useAtlas } from "./atlas-context.js";

function StatusProbe() {
  const atlas = useAtlas();
  const entityNames = Object.values(atlas.snapshot.entities)
    .map((entity) => entity.alias ?? entity.entity_id)
    .join(",");
  return (
    <div>
      <span>{atlas.status}</span>
      <span data-testid="entity-names">{entityNames}</span>
      <span data-testid="catalog-name">{atlas.catalog?.[0]?.name}</span>
      <span data-testid="entity-details-capability">{atlas.loadEntityDetails ? "available" : "unavailable"}</span>
      {atlas.health.error ? (
        <code data-testid="health-error">
          {atlas.health.error.source}: {atlas.health.error.message}
        </code>
      ) : null}
      {atlas.connectionError ? (
        <code data-testid="connection-error">
          {atlas.connectionError.source}: {atlas.connectionError.message}
        </code>
      ) : null}
      {atlas.error ? <code>{atlas.error}</code> : null}
      {atlas.error ? (
        <button type="button" onClick={atlas.reconnect}>
          Retry connection
        </button>
      ) : null}
    </div>
  );
}

function GeometryActionProbe() {
  const atlas = useAtlas();
  const entityNames = Object.values(atlas.snapshot.entities)
    .map((entity) => entity.alias ?? entity.entity_id)
    .join(",");
  return (
    <div>
      <span>{atlas.status}</span>
      <span data-testid="entity-names">{entityNames}</span>
      <button
        type="button"
        onClick={() => void atlas.updateGeometry("asset-1", { type: "Point", coordinates: [-74.2, 40.1] }, 1)}
      >
        save
      </button>
    </div>
  );
}

const config: AppConfig = {
  atlasBaseUrl: "/atlas",
  protocolRevision: "rev",
  defaultMapSourceId: "openstreetmap-default",
  mapSources: [
    { id: "openstreetmap-default", label: "OpenStreetMap Default", style: styleFixture("openstreetmap-default") }
  ]
};

function entity(alias: string, version: number): EntityResource {
  return entityFixture({
    entity_id: "asset-1",
    alias,
    metadata: metadataFixture(version)
  });
}

function catalog(name: string): CommandCatalog {
  return [
    {
      command: "fixture.queued",
      name,
      description: "Test",
      input_schema: "atlas.fixture.FixtureInput"
    }
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function catalogDataSource(loadCommandCatalog: () => Promise<CommandCatalog>) {
  const loadCatalog = vi.fn(loadCommandCatalog);
  const dataSource: AtlasDataSource = {
    snapshot: () => ({ entities: {}, tasks: {} }),
    loadCommandCatalog: loadCatalog,
    watch() {
      return () => undefined;
    },
    async start() {},
    async submitCommand() {
      throw new Error("not used");
    },
    async updateGeometry() {
      throw new Error("not used");
    },
    dispose() {}
  };
  return { dataSource, loadCommandCatalog: loadCatalog };
}

describe("AtlasProvider", () => {
  it("does not advertise Entity detail loading when the data source omits it", async () => {
    const { dataSource } = catalogDataSource(async () => catalog("Commands"));

    render(
      <AtlasProvider config={config} createDataSource={() => dataSource}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("entity-details-capability")).toHaveTextContent("unavailable");
  });

  it("does not classify configuration loading failures as connection errors", async () => {
    render(
      <AtlasProvider
        loadConfig={async () => {
          throw new Error("configuration failed");
        }}
      >
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(screen.getByText("configuration failed")).toBeInTheDocument();
    expect(screen.queryByTestId("health-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connection-error")).not.toBeInTheDocument();
  });

  it("treats data source construction failures as fatal initialization errors", async () => {
    render(
      <AtlasProvider
        config={config}
        createDataSource={() => {
          throw new Error("data source construction failed");
        }}
      >
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(screen.getByText("data source construction failed")).toBeInTheDocument();
    expect(screen.queryByTestId("health-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connection-error")).not.toBeInTheDocument();
  });

  it("treats data source watch failures as fatal initialization errors", async () => {
    const dataSource = {
      ...catalogDataSource(async () => catalog("Commands")).dataSource,
      watch() {
        throw new Error("data source watch failed");
      }
    };

    render(
      <AtlasProvider config={config} createDataSource={() => dataSource}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(screen.getByText("data source watch failed")).toBeInTheDocument();
    expect(screen.queryByTestId("health-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connection-error")).not.toBeInTheDocument();
  });

  it("keeps the public connection error until health fully recovers", async () => {
    vi.useFakeTimers();
    let health: ConnectionHealth = {
      running: true,
      healthy: false,
      degraded: true,
      error: { source: "live-sync", message: "feed failed" }
    };
    const dataSource: AtlasDataSource = {
      snapshot: () => ({ entities: {}, tasks: {} }),
      watch: () => () => {},
      async start() {},
      async loadCommandCatalog() {
        return catalog("Commands");
      },
      async submitCommand() {
        throw new Error("not used");
      },
      async updateGeometry() {
        throw new Error("not used");
      },
      health: () => health,
      dispose() {}
    };

    try {
      render(
        <AtlasProvider config={config} createDataSource={() => dataSource}>
          <StatusProbe />
        </AtlasProvider>
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId("health-error")).toHaveTextContent("feed failed");
      expect(screen.getByTestId("connection-error")).toHaveTextContent("feed failed");

      health = { running: true, healthy: false, degraded: false };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.queryByTestId("health-error")).not.toBeInTheDocument();
      expect(screen.getByTestId("connection-error")).toHaveTextContent("feed failed");

      health = { running: true, healthy: true, degraded: false };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.queryByTestId("health-error")).not.toBeInTheDocument();
      expect(screen.queryByTestId("connection-error")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers the watch before sync and reads the authoritative post-start snapshot", async () => {
    const calls: string[] = [];
    let current: AtlasSnapshot = { entities: { "asset-1": entity("Older", 1) }, tasks: {} };
    let emit: ((snapshot: AtlasSnapshot) => void) | undefined;
    const fake: AtlasDataSource = {
      snapshot() {
        calls.push("snapshot");
        return current;
      },
      async loadCommandCatalog() {
        return [];
      },
      watch(onEvent) {
        calls.push("watch");
        emit = onEvent;
        return () => {
          emit = undefined;
        };
      },
      async start() {
        calls.push("start");
        current = { entities: { "asset-1": entity("Newer", 2) }, tasks: {} };
        emit?.(current);
      },
      async submitCommand() {
        throw new Error("not used");
      },
      async updateGeometry() {
        throw new Error("not used");
      },
      dispose() {}
    };

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(calls.slice(0, 3)).toEqual(["watch", "start", "snapshot"]);
    expect(screen.getByTestId("entity-names")).toHaveTextContent("Newer");
  });

  it("disposes a failed startup and creates a fresh data source for a one-shot retry", async () => {
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const failing: AtlasDataSource = {
      snapshot() {
        return { entities: {}, tasks: {} };
      },
      async loadCommandCatalog() {
        throw new Error("catalog unavailable");
      },
      watch() {
        return unsubscribe;
      },
      async start() {
        throw new Error("start failed");
      },
      async submitCommand() {
        throw new Error("not used");
      },
      async updateGeometry() {
        throw new Error("not used");
      },
      dispose
    };
    const succeeding: AtlasDataSource = {
      snapshot() {
        return { entities: { "asset-1": entity("Recovered", 2) }, tasks: {} };
      },
      async loadCommandCatalog() {
        return [];
      },
      watch() {
        return () => undefined;
      },
      async start() {},
      async submitCommand() {
        throw new Error("not used");
      },
      async updateGeometry() {
        throw new Error("not used");
      },
      dispose() {}
    };
    const createDataSource = vi.fn().mockReturnValueOnce(failing).mockReturnValueOnce(succeeding);

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={createDataSource}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByText("start failed")).toBeInTheDocument();
    expect(screen.getByTestId("health-error")).toHaveTextContent("startup: start failed");
    expect(screen.getByTestId("connection-error")).toHaveTextContent("startup: start failed");
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeInTheDocument();
    await waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });
    expect(createDataSource).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("entity-names")).toHaveTextContent("Recovered");
    expect(screen.queryByTestId("health-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connection-error")).not.toBeInTheDocument();
    expect(screen.queryByText("start failed", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry connection" })).not.toBeInTheDocument();
    expect(createDataSource).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("publishes the catalog during normal startup", async () => {
    const startup = deferred<CommandCatalog>();
    const fake = catalogDataSource(() => startup.promise);

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake.dataSource}>
        <StatusProbe />
      </AtlasProvider>
    );

    await waitFor(() => expect(fake.loadCommandCatalog).toHaveBeenCalledTimes(1));
    await act(async () => startup.resolve(catalog("Startup")));

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-name")).toHaveTextContent("Startup");
  });

  it("treats an unavailable command catalog as a fatal setup error", async () => {
    const dispose = vi.fn();
    const unsubscribe = vi.fn();
    const fake = catalogDataSource(async () => {
      throw new Error("catalog unavailable");
    }).dataSource;
    fake.dispose = dispose;
    fake.watch = () => unsubscribe;

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(screen.getByText("catalog unavailable")).toBeInTheDocument();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps newer watch data when an action resolves with a stale resource version", async () => {
    let current: AtlasSnapshot = { entities: { "asset-1": entity("Initial", 1) }, tasks: {} };
    let emit: ((snapshot: AtlasSnapshot) => void) | undefined;
    const updateGeometry = vi.fn(async () => entity("Stale Action", 1));
    const fake: AtlasDataSource = {
      snapshot() {
        return current;
      },
      async loadCommandCatalog() {
        return [];
      },
      watch(onEvent) {
        emit = onEvent;
        return () => {
          emit = undefined;
        };
      },
      async start() {},
      async submitCommand() {
        throw new Error("not used");
      },
      updateGeometry,
      dispose() {}
    };

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake}>
        <GeometryActionProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();

    act(() => {
      current = { entities: { "asset-1": entity("Fresh Watch", 2) }, tasks: {} };
      emit?.(current);
    });
    expect(screen.getByTestId("entity-names")).toHaveTextContent("Fresh Watch");

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(updateGeometry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("entity-names")).toHaveTextContent("Fresh Watch"));
  });
});
