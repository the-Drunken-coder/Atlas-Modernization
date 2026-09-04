import { render, screen } from "@testing-library/react";
import type { CommandCatalog, EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { entityFixture, taskFixture } from "../../../test/fixtures.js";
import { AssetInspector, type CommandManifestStatus } from "./AssetInspector.js";

const catalog: CommandCatalog = [
  {
    command: "fixture.queued",
    name: "Fixture queued",
    description: "Exercise tasking.",
    input_schema: "atlas.protocol.JSONValue"
  }
];
const manifest: NonNullable<EntityResource["command_manifest"]> = [
  {
    command: "fixture.queued",
    description: "Runs the fixture.",
    scheduling: "queued",
    supports_cancel: true,
    supports_progress: true
  }
];

function asset(commandManifest?: EntityResource["command_manifest"]): EntityResource {
  return entityFixture({ entity_id: "asset-1", alias: "Rover", command_manifest: commandManifest });
}

function renderInspector(
  entity: EntityResource,
  options: { catalog?: CommandCatalog; commandManifestStatus?: CommandManifestStatus; tasks?: TaskResource[] } = {}
) {
  return render(
    <AssetInspector
      entity={entity}
      snapshot={{
        entities: { [entity.entity_id]: entity },
        tasks: Object.fromEntries((options.tasks ?? []).map((task) => [task.task_id, task]))
      }}
      catalog={options.catalog}
      commandManifestStatus={options.commandManifestStatus}
      onPickCommand={() => {}}
    />
  );
}

describe("AssetInspector", () => {
  it.each([
    ["loading", "Loading Asset Commands"],
    ["unavailable", "Asset Commands unavailable"]
  ] as const)("shows the dedicated Commands state for a %s manifest", (status, label) => {
    renderInspector(asset(), { catalog, commandManifestStatus: status });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("distinguishes an empty Protocol catalog from an empty Asset manifest", () => {
    renderInspector(asset(), { catalog: [] });
    expect(screen.getByText("No Commands are defined in Atlas Protocol")).toBeInTheDocument();

    renderInspector(asset([]), { catalog, commandManifestStatus: "ready" });
    expect(screen.getByText("This Asset has no Commands")).toBeInTheDocument();
  });

  it("distinguishes an Asset manifest with no registered operator input", () => {
    renderInspector(asset(manifest), { catalog, commandManifestStatus: "ready" });
    expect(screen.getByText("No operator inputs are available for this Asset's Commands")).toBeInTheDocument();
  });

  it("keeps active and queued Tasks out of terminal Task History", () => {
    const active = {
      ...taskFixture({ task_id: "active-task", asset_id: "asset-1", command: "active.command" }),
      status: "in_progress" as const,
      acknowledged_at: "2026-06-20T00:00:01Z",
      started_at: "2026-06-20T00:00:02Z"
    } satisfies TaskResource;
    const queued = taskFixture({ task_id: "queued-task", asset_id: "asset-1", command: "queued.command" });
    const completed = {
      ...active,
      task_id: "completed-task",
      command: "completed.command",
      status: "completed" as const,
      finished_at: "2026-06-20T00:00:03Z"
    } satisfies TaskResource;

    renderInspector(asset(), { tasks: [active, queued, completed] });

    const historySection = screen.getByText("Task History").closest("section");
    expect(historySection).not.toBeNull();
    expect(historySection).toHaveTextContent("completed.command");
    expect(historySection).not.toHaveTextContent("active.command");
    expect(historySection).not.toHaveTextContent("queued.command");
  });
});
