import { act, renderHook } from "@testing-library/react";
import type { TaskResource } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entityFixture, taskFixture } from "../../../test/fixtures.js";
import type { CommandAvailability } from "../../atlas/command-targeting.js";
import { useCommandFlow } from "./use-command-flow.js";

const availability: CommandAvailability = {
  command: {
    command: "fixture.queued",
    name: "Fixture queued",
    description: "Exercise queued tasking.",
    input_schema: "atlas.fixture.FixtureInput"
  },
  manifest: {
    command: "fixture.queued",
    description: "Runs the fixture handler.",
    scheduling: "queued",
    supports_cancel: true,
    supports_progress: true
  },
  input: { targeting: "none", buildInput: () => ({ value: "fixture" }) }
};
const commandCatalog = [availability.command];

const formAvailability: CommandAvailability = {
  ...availability,
  input: {
    targeting: "none",
    Form: ({ onSubmit }) => (
      <button type="button" onClick={() => onSubmit({ value: "stale" })}>
        Submit fixture
      </button>
    )
  }
};

const asset = entityFixture({
  entity_id: "asset-1",
  alias: "Rover 1",
  command_manifest: [availability.manifest],
  metadata: { created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z", version: 1 }
});

const task = taskFixture({
  asset_id: asset.entity_id,
  command: availability.command.command,
  input: { value: "same" },
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z"
});

afterEach(() => vi.restoreAllMocks());

describe("useCommandFlow", () => {
  it("waits for the marker selection to commit before opening its menu", () => {
    const selectedAsset = { ...asset, entity_id: "asset-2", alias: "Scout" };
    const submitCommand = vi.fn();
    const { result, rerender } = renderHook(
      (props: { selectedEntity: typeof asset; selectedId: string; commandManifestStatus: "ready" | "loading" }) =>
        useCommandFlow({ catalog: commandCatalog, submitCommand, ...props }),
      {
        initialProps: {
          selectedEntity: asset,
          selectedId: asset.entity_id,
          commandManifestStatus: "ready"
        }
      }
    );

    act(() => {
      result.current.onMapContextMenu({ entityId: selectedAsset.entity_id, x: 10, y: 20, lat: 40, lng: -74 });
    });
    expect(result.current.mapMenu).toBeNull();

    rerender({
      selectedEntity: selectedAsset,
      selectedId: selectedAsset.entity_id,
      commandManifestStatus: "loading"
    });
    expect(result.current.mapMenu).toBeNull();

    rerender({
      selectedEntity: selectedAsset,
      selectedId: selectedAsset.entity_id,
      commandManifestStatus: "ready"
    });

    expect(result.current.mapMenu).toEqual({ x: 10, y: 20, lat: 40, lng: -74 });
  });

  it("reuses the idempotency key after an uncertain submission failure", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const submitCommand = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(task);
    const { result } = renderHook(() =>
      useCommandFlow({ catalog: commandCatalog, selectedEntity: asset, selectedId: asset.entity_id, submitCommand })
    );

    await act(async () => result.current.submit(availability, { value: "same" }));
    await act(async () => result.current.submit(availability, { value: "same" }));

    expect(submitCommand).toHaveBeenCalledTimes(2);
    expect(submitCommand.mock.calls[0]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
    expect(submitCommand.mock.calls[1]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");

    await act(async () => result.current.submit(availability, { value: "same" }));
    expect(submitCommand.mock.calls[2]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("starts a new attempt when the failed submission data changes", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const submitCommand = vi.fn().mockRejectedValue(new Error("response lost"));
    const { result } = renderHook(() =>
      useCommandFlow({ catalog: commandCatalog, selectedEntity: asset, selectedId: asset.entity_id, submitCommand })
    );

    await act(async () => result.current.submit(availability, { value: "first" }));
    await act(async () => result.current.submit(availability, { value: "changed" }));

    expect(submitCommand.mock.calls[0]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
    expect(submitCommand.mock.calls[1]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("does not restore an error after the attempt is dismissed", async () => {
    let rejectSubmission: ((reason: Error) => void) | undefined;
    const submitCommand = vi.fn(
      () =>
        new Promise<TaskResource>((_resolve, reject) => {
          rejectSubmission = reject;
        })
    );
    const { result } = renderHook(() =>
      useCommandFlow({ catalog: commandCatalog, selectedEntity: asset, selectedId: asset.entity_id, submitCommand })
    );
    let submission: Promise<void> | undefined;

    act(() => {
      submission = result.current.submit(availability, { value: "same" });
    });
    act(() => result.current.dismissCommandForm());
    await act(async () => {
      rejectSubmission?.(new Error("late failure"));
      await submission;
    });

    expect(result.current.submitError).toBeUndefined();
  });

  it("preserves an uncertain form submission across a manifest refresh", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    let rejectSubmission: ((reason: Error) => void) | undefined;
    const submitCommand = vi
      .fn<NonNullable<Parameters<typeof useCommandFlow>[0]["submitCommand"]>>()
      .mockImplementationOnce(
        () =>
          new Promise<TaskResource>((_resolve, reject) => {
            rejectSubmission = reject;
          })
      )
      .mockResolvedValueOnce(task);
    const { result, rerender } = renderHook(
      (props: { commandManifestStatus: "ready" | "loading"; commandManifestGeneration: number }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: asset,
          selectedId: asset.entity_id,
          submitCommand,
          ...props
        }),
      { initialProps: { commandManifestStatus: "ready", commandManifestGeneration: 1 } }
    );
    let submission: Promise<void> | undefined;

    act(() => result.current.pickSidebarCommand(formAvailability));
    act(() => {
      submission = result.current.submit(formAvailability, { value: "same" });
    });
    rerender({ commandManifestStatus: "loading", commandManifestGeneration: 2 });
    expect(result.current.commandForm).toBeNull();
    await act(async () => {
      rejectSubmission?.(new Error("response lost"));
      await submission;
    });
    expect(result.current.submitError).toBeDefined();

    rerender({ commandManifestStatus: "ready", commandManifestGeneration: 2 });
    act(() => result.current.pickSidebarCommand(formAvailability));
    await act(async () => result.current.submit(formAvailability, { value: "same" }));

    expect(submitCommand).toHaveBeenCalledTimes(2);
    expect(submitCommand.mock.calls[0]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
    expect(submitCommand.mock.calls[1]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("closes an open map command menu while the manifest refreshes", () => {
    const submitCommand = vi.fn();
    const { result, rerender } = renderHook(
      (props: { commandManifestStatus: "ready" | "loading" }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: asset,
          selectedId: asset.entity_id,
          commandManifestStatus: props.commandManifestStatus,
          submitCommand
        }),
      { initialProps: { commandManifestStatus: "ready" } }
    );

    act(() => {
      result.current.onMapContextMenu({ entityId: asset.entity_id, x: 10, y: 20, lat: 40, lng: -74 });
    });
    expect(result.current.mapMenu).not.toBeNull();

    rerender({ commandManifestStatus: "loading" });

    expect(result.current.mapMenu).toBeNull();
    act(() => {
      result.current.onMapContextMenu({ entityId: asset.entity_id, x: 10, y: 20, lat: 40, lng: -74 });
    });
    expect(result.current.mapMenu).toBeNull();
  });

  it("dismisses forms and rejects callbacks from an older manifest generation", async () => {
    const submitCommand = vi.fn().mockResolvedValue(task);
    const { result, rerender } = renderHook(
      (props: {
        commandManifestStatus: "ready" | "loading";
        commandManifestGeneration: number;
        entity: typeof asset;
      }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: props.entity,
          selectedId: props.entity.entity_id,
          commandManifestStatus: props.commandManifestStatus,
          commandManifestGeneration: props.commandManifestGeneration,
          submitCommand
        }),
      {
        initialProps: { commandManifestStatus: "ready", commandManifestGeneration: 1, entity: asset }
      }
    );

    act(() => result.current.pickSidebarCommand(formAvailability));
    expect(result.current.commandForm).not.toBeNull();
    const staleSubmit = result.current.submit;

    const changedAsset = { ...asset, command_manifest: [] };
    rerender({ commandManifestStatus: "loading", commandManifestGeneration: 2, entity: changedAsset });
    expect(result.current.commandForm).toBeNull();
    rerender({ commandManifestStatus: "ready", commandManifestGeneration: 2, entity: changedAsset });
    act(() => result.current.pickSidebarCommand(formAvailability));
    expect(result.current.commandForm).toBeNull();

    await act(async () => {
      await staleSubmit(formAvailability, { value: "stale" }, 1);
    });
    expect(submitCommand).not.toHaveBeenCalled();
  });
});
