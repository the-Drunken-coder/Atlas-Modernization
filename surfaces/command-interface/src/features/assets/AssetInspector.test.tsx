import { act, render, screen } from "@testing-library/react";
import type { CommandCatalog, EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entityFixture, taskFixture } from "../../../test/fixtures.js";
import * as selectors from "../../atlas/selectors.js";
import type { AtlasSnapshot } from "../../atlas/store.js";
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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("advances heartbeat and task ages without deriving unchanged task sections again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T00:00:05Z"));
    const derivations = [
      vi.spyOn(selectors, "activeTasks"),
      vi.spyOn(selectors, "queuedTasks"),
      vi.spyOn(selectors, "tasksForAsset")
    ];
    const entity = entityFixture({
      entity_id: "asset-1",
      components: { heartbeat: { last_seen: "2026-06-20T00:00:00Z" } }
    });
    renderInspector(entity, { tasks: [taskFixture({ asset_id: entity.entity_id })] });
    expect(screen.getAllByText("5s ago")).toHaveLength(2);
    for (const derive of derivations) expect(derive).toHaveBeenCalledTimes(1);

    for (let tick = 0; tick < 3; tick++) act(() => vi.advanceTimersByTime(1_000));

    expect(screen.getAllByText("8s ago")).toHaveLength(2);
    for (const derive of derivations) expect(derive).toHaveBeenCalledTimes(1);
  });

  it("refreshes task sections on snapshot and asset changes while keeping recent history capped at 25", () => {
    const entity = asset();
    const other = entityFixture({ entity_id: "asset-2" });
    const queued = taskFixture({ task_id: "queued", asset_id: entity.entity_id, command: "queued.command" });
    const otherTask = taskFixture({ task_id: "other", asset_id: other.entity_id, command: "other.command" });
    const completed = Array.from({ length: 26 }, (_, index) => ({
      ...taskFixture({ task_id: `history-${index}`, asset_id: entity.entity_id, command: `history.${index}` }),
      status: "completed" as const,
      acknowledged_at: "2026-06-20T00:00:00Z",
      started_at: "2026-06-20T00:00:00Z",
      finished_at: new Date(Date.parse("2026-06-20T00:01:00Z") + index * 1_000).toISOString(),
      updated_at: new Date(Date.parse("2026-06-20T00:01:00Z") + index * 1_000).toISOString()
    }));
    let snapshot: AtlasSnapshot = {
      entities: { [entity.entity_id]: entity, [other.entity_id]: other },
      tasks: Object.fromEntries([...completed, queued, otherTask].map((task) => [task.task_id, task]))
    };
    const { rerender } = render(<AssetInspector entity={entity} snapshot={snapshot} onPickCommand={() => {}} />);
    const sectionCommands = (title: string) =>
      Array.from(
        screen.getByText(title).closest("section")?.querySelectorAll(".task-row__title") ?? [],
        (row) => row.textContent
      );
    const recentHistory = Array.from({ length: 25 }, (_, index) => `history.${25 - index}`);
    expect(sectionCommands("Active & Queued Tasks")).toEqual(["queued.command"]);
    expect(sectionCommands("Task History")).toEqual(recentHistory);

    const active = {
      ...queued,
      status: "in_progress" as const,
      acknowledged_at: "2026-06-20T00:02:00Z",
      started_at: "2026-06-20T00:02:00Z"
    } satisfies TaskResource;
    snapshot = { ...snapshot, tasks: { ...snapshot.tasks, [active.task_id]: active } };
    rerender(<AssetInspector entity={entity} snapshot={snapshot} onPickCommand={() => {}} />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(sectionCommands("Active & Queued Tasks")).toEqual(["queued.command"]);
    expect(sectionCommands("Task History")).toEqual(recentHistory);

    const finished = {
      ...active,
      status: "completed" as const,
      finished_at: "2026-06-20T00:03:00Z",
      updated_at: "2026-06-20T00:03:00Z"
    } satisfies TaskResource;
    snapshot = { ...snapshot, tasks: { ...snapshot.tasks, [finished.task_id]: finished } };
    rerender(<AssetInspector entity={entity} snapshot={snapshot} onPickCommand={() => {}} />);
    expect(sectionCommands("Active & Queued Tasks")).toEqual([]);
    expect(sectionCommands("Task History")).toEqual(["queued.command", ...recentHistory.slice(0, 24)]);

    rerender(<AssetInspector entity={other} snapshot={snapshot} onPickCommand={() => {}} />);
    expect(sectionCommands("Active & Queued Tasks")).toEqual(["other.command"]);
    expect(sectionCommands("Task History")).toEqual([]);
  });

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
