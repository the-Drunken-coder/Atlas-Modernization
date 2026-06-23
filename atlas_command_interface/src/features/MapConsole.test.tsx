import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AtlasWatchEvent, EntityResource } from "../../../atlas_sdk/src/index.js";
import { parseCommandCatalog } from "../atlas/command-model.js";
import type { AtlasDataSource, CommandSubmission } from "../atlas/data-source.js";
import { AtlasProvider } from "../state/atlas-context.js";
import { MapConsole } from "./MapConsole.js";

// MapLibre never runs in jsdom; stub the map but keep the real source builder.
vi.mock("../ui/map/MapView.js", async () => {
  const sources = await import("../ui/map/map-sources.js");
  return {
    MapView: (props: { editing?: unknown }) => <div data-testid="map" data-editing={props.editing ? "true" : "false"} />,
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
    { id: "return_to_home", name: "Return To Home", description: "Go home.", parameters_schema: {} }
  ]
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
  const submissions: Array<{ submission: CommandSubmission; credential: string }> = [];
  const geometryUpdates: Array<{ entityId: string; ifMatchVersion?: number }> = [];
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
    async submitCommand(submission, credential) {
      submissions.push({ submission, credential });
      const task = {
        task_id: "task-1",
        status: "pending",
        entity_id: submission.entityId,
        components: { command: { type: submission.commandId, id: submission.commandId }, parameters: submission.parameters ?? {} },
        metadata: { ...metadata, version: 2 }
      };
      emit?.({ event: "create", resource_type: "task", id: task.task_id, version: 2, resource: task });
      return task;
    },
    async updateGeometry(entityId, geometry, ifMatchVersion) {
      geometryUpdates.push({ entityId, ifMatchVersion });
      return { ...area, components: { ...area.components, geometry }, metadata: { ...area.metadata, version: 10 } };
    },
    dispose() {}
  };
  return { fake, submissions, geometryUpdates, emit: (event: AtlasWatchEvent) => emit?.(event) };
}

function renderConsole(fake: AtlasDataSource) {
  return render(
    <AtlasProvider loadConfig={async () => ({ atlasBaseUrl: "/atlas", protocolRevision: "rev" })} createDataSource={() => fake}>
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
    const send = await screen.findByRole("button", { name: "Send command" });
    expect(send).toBeDisabled();
    await user.type(screen.getByPlaceholderText("ATLAS_COMMAND_API_KEY"), "test-key");
    expect(send).toBeEnabled();
    await user.click(send);

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]).toMatchObject({ submission: { entityId: "asset-1", commandId: "hold_position" }, credential: "test-key" });

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
    expect(geometryUpdates[0]).toEqual({ entityId: "geo-1", ifMatchVersion: 1 });
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
