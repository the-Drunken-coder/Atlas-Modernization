import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import type { AppConfig } from "../app/config.js";
import type { AtlasDataSource, CatalogUpdate } from "../atlas/data-source.js";
import type { CommandCatalog } from "../atlas/command-model.js";
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
      <span data-testid="catalog-name">{atlas.catalog?.name}</span>
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
      <button type="button" onClick={() => void atlas.updateGeometry("asset-1", { type: "Point", coordinates: [-74.2, 40.1] }, 1)}>
        save
      </button>
    </div>
  );
}

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };
const config: AppConfig = {
  atlasBaseUrl: "/atlas",
  protocolRevision: "rev",
  defaultMapSourceId: "openstreetmap-default",
  mapSources: [{ id: "openstreetmap-default", label: "OpenStreetMap Default", style: style("openstreetmap-default") }]
};

function style(id: string): StyleSpecification {
  return { version: 8, sources: {}, layers: [], metadata: { id } };
}

function entity(alias: string, version: number): EntityResource {
  return {
    entity_id: "asset-1",
    entity_type: "asset",
    subtype: null,
    alias,
    components: {},
    metadata: { ...metadata, version }
  };
}

function catalog(name: string): CommandCatalog {
  return { type: "command_catalog", name, description: "Test", commands: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function catalogDataSource(loadCommandCatalog: () => Promise<CommandCatalog>) {
  let emitCatalog: ((update: CatalogUpdate) => void) | undefined;
  const loadCatalog = vi.fn(loadCommandCatalog);
  const dataSource: AtlasDataSource = {
    snapshot: () => ({ entities: {}, tasks: {} }),
    loadCommandCatalog: loadCatalog,
    watch(_onSnapshot, onCatalog) {
      emitCatalog = onCatalog;
      return () => {
        emitCatalog = undefined;
      };
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
  return { dataSource, loadCommandCatalog: loadCatalog, emitCatalog: (update: CatalogUpdate) => emitCatalog?.(update) };
}

describe("AtlasProvider", () => {
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
        return { type: "command_catalog", name: "Catalog", description: "Test", commands: [] };
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
        return { type: "command_catalog", name: "Catalog", description: "Test", commands: [] };
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

  it("publishes a freshly loaded catalog after its backing object changes", async () => {
    let nextCatalog = { type: "command_catalog" as const, name: "Original", description: "Test", commands: [] };
    let emitCatalog: ((update: CatalogUpdate) => void) | undefined;
    const loadCommandCatalog = vi.fn(async () => nextCatalog);
    const fake: AtlasDataSource = {
      snapshot() {
        return { entities: {}, tasks: {} };
      },
      loadCommandCatalog,
      watch(_onSnapshot, onCatalog) {
        emitCatalog = onCatalog;
        return () => {
          emitCatalog = undefined;
        };
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

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByTestId("catalog-name")).toHaveTextContent("Original");
    expect(loadCommandCatalog).toHaveBeenCalledTimes(1);

    nextCatalog = { ...nextCatalog, name: "Updated" };
    act(() => emitCatalog?.({ status: "loaded", catalog: nextCatalog }));

    expect(screen.getByTestId("catalog-name")).toHaveTextContent("Updated");
  });

  it("accepts startup data when a live invalidation arrives before startup resolves", async () => {
    const startup = deferred<CommandCatalog>();
    const fake = catalogDataSource(() => startup.promise);

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake.dataSource}>
        <StatusProbe />
      </AtlasProvider>
    );

    await waitFor(() => expect(fake.loadCommandCatalog).toHaveBeenCalledTimes(1));
    act(() => fake.emitCatalog({ status: "pending" }));
    await act(async () => startup.resolve(catalog("Startup")));

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-name")).toHaveTextContent("Startup");
  });

  it("keeps the startup catalog when live detail retries fail", async () => {
    const startup = deferred<CommandCatalog>();
    const fake = catalogDataSource(() => startup.promise);

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake.dataSource}>
        <StatusProbe />
      </AtlasProvider>
    );

    await waitFor(() => expect(fake.loadCommandCatalog).toHaveBeenCalledTimes(1));
    act(() => {
      fake.emitCatalog({ status: "pending" });
      fake.emitCatalog({ status: "failed" });
    });
    await act(async () => startup.resolve(catalog("Startup")));
    expect(await screen.findByTestId("catalog-name")).toHaveTextContent("Startup");
  });

  it("clears a loaded catalog only after live detail retries fail", async () => {
    const fake = catalogDataSource(async () => catalog("Startup"));

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake.dataSource}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByTestId("catalog-name")).toHaveTextContent("Startup");

    act(() => fake.emitCatalog({ status: "pending" }));
    expect(screen.getByTestId("catalog-name")).toHaveTextContent("Startup");

    act(() => fake.emitCatalog({ status: "failed" }));
    expect(screen.getByTestId("catalog-name")).toBeEmptyDOMElement();
  });

  it("lets a successfully fetched newer live catalog supersede startup", async () => {
    const startup = deferred<CommandCatalog>();
    const fake = catalogDataSource(() => startup.promise);

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake.dataSource}>
        <StatusProbe />
      </AtlasProvider>
    );

    await waitFor(() => expect(fake.loadCommandCatalog).toHaveBeenCalledTimes(1));
    act(() => {
      fake.emitCatalog({ status: "pending" });
      fake.emitCatalog({ status: "loaded", catalog: catalog("Live") });
    });
    await act(async () => startup.resolve(catalog("Startup")));

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-name")).toHaveTextContent("Live");
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

  it("keeps newer watch data when an action resolves with a stale resource version", async () => {
    let current: AtlasSnapshot = { entities: { "asset-1": entity("Initial", 1) }, tasks: {} };
    let emit: ((snapshot: AtlasSnapshot) => void) | undefined;
    const updateGeometry = vi.fn(async () => entity("Stale Action", 1));
    const fake: AtlasDataSource = {
      snapshot() {
        return current;
      },
      async loadCommandCatalog() {
        return { type: "command_catalog", name: "Catalog", description: "Test", commands: [] };
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
