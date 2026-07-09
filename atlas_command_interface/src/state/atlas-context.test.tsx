import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource } from "../../../atlas_sdk/src/index.js";
import type { AppConfig } from "../app/config.js";
import type { AtlasDataSource } from "../atlas/data-source.js";
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
      {atlas.error ? <code>{atlas.error}</code> : null}
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

function snapshot(value: EntityResource): AtlasSnapshot {
  return { entities: { [value.entity_id]: value }, tasks: {} };
}

describe("AtlasProvider", () => {
  it("registers a cache-change watch, starts sync, then reads the final cache snapshot", async () => {
    const calls: string[] = [];
    let current = snapshot(entity("Older", 1));
    const fake: AtlasDataSource = {
      snapshot() {
        calls.push("snapshot");
        return current;
      },
      async loadCommandCatalog() {
        return { type: "command_catalog", name: "Catalog", description: "Test", commands: [] };
      },
      watch() {
        calls.push("watch");
        return () => undefined;
      },
      async start() {
        calls.push("start");
        current = snapshot(entity("Newer", 2));
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

  it("cleans up subscriptions and data source state when startup fails", async () => {
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const fake: AtlasDataSource = {
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

    render(
      <AtlasProvider loadConfig={async () => config} createDataSource={() => fake}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(screen.getByText("start failed")).toBeInTheDocument();
    await waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps newer cached data when a stale write response resolves", async () => {
    let current = snapshot(entity("Initial", 1));
    let refresh: (() => void) | undefined;
    const updateGeometry = vi.fn(async () => entity("Stale Action", 1));
    const fake: AtlasDataSource = {
      snapshot() {
        return current;
      },
      async loadCommandCatalog() {
        return { type: "command_catalog", name: "Catalog", description: "Test", commands: [] };
      },
      watch(onSnapshotChange) {
        refresh = onSnapshotChange;
        return () => {
          refresh = undefined;
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
      current = snapshot(entity("Fresh Cache", 2));
      refresh?.();
    });
    expect(screen.getByTestId("entity-names")).toHaveTextContent("Fresh Cache");

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(updateGeometry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("entity-names")).toHaveTextContent("Fresh Cache"));
  });
});
