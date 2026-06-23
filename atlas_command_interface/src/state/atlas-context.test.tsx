import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AtlasWatchEvent, EntityResource } from "../../../atlas_sdk/src/index.js";
import type { AtlasDataSource } from "../atlas/data-source.js";
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

describe("AtlasProvider", () => {
  it("starts live sync before loading the displayed snapshot and replays startup events", async () => {
    const calls: string[] = [];
    let emit: ((event: AtlasWatchEvent) => void) | undefined;
    const fake: AtlasDataSource = {
      async loadSnapshot() {
        calls.push("loadSnapshot");
        return { entities: [entity("Older", 1)], tasks: [] };
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
        emit?.({ event: "update", resource_type: "entity", id: "asset-1", version: 2, resource: entity("Newer", 2) });
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
      <AtlasProvider loadConfig={async () => ({ atlasBaseUrl: "/atlas", protocolRevision: "rev" })} createDataSource={() => fake}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(calls.slice(0, 3)).toEqual(["watch", "start", "loadSnapshot"]);
    expect(screen.getByTestId("entity-names")).toHaveTextContent("Newer");
  });

  it("cleans up subscriptions and data source state when startup fails", async () => {
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const fake: AtlasDataSource = {
      async loadSnapshot() {
        return { entities: [], tasks: [] };
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
      <AtlasProvider loadConfig={async () => ({ atlasBaseUrl: "/atlas", protocolRevision: "rev" })} createDataSource={() => fake}>
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

  it("keeps newer watch data when an action resolves with a stale resource version", async () => {
    let emit: ((event: AtlasWatchEvent) => void) | undefined;
    const updateGeometry = vi.fn(async () => entity("Stale Action", 1));
    const fake: AtlasDataSource = {
      async loadSnapshot() {
        return { entities: [entity("Initial", 1)], tasks: [] };
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
      <AtlasProvider loadConfig={async () => ({ atlasBaseUrl: "/atlas", protocolRevision: "rev" })} createDataSource={() => fake}>
        <GeometryActionProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();

    act(() => {
      emit?.({ event: "update", resource_type: "entity", id: "asset-1", version: 2, resource: entity("Fresh Watch", 2) });
    });
    expect(screen.getByTestId("entity-names")).toHaveTextContent("Fresh Watch");

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(updateGeometry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("entity-names")).toHaveTextContent("Fresh Watch"));
  });
});
