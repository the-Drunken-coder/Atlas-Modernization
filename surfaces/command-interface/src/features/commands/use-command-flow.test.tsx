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
const formAvailability: CommandAvailability = {
  ...availability,
  input: { targeting: "none", Form: () => null }
};
const commandCatalog = [availability.command];

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
      (props: { selectedEntity: typeof asset; selectedId: string }) =>
        useCommandFlow({ catalog: commandCatalog, submitCommand, ...props }),
      { initialProps: { selectedEntity: asset, selectedId: asset.entity_id } }
    );

    act(() => {
      result.current.onMapContextMenu({ entityId: selectedAsset.entity_id, x: 10, y: 20, lat: 40, lng: -74 });
    });
    expect(result.current.mapMenu).toBeNull();

    rerender({ selectedEntity: selectedAsset, selectedId: selectedAsset.entity_id });

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

  it("clears menus and forms when the command generation changes", () => {
    const submitCommand = vi.fn();
    const { result, rerender } = renderHook(
      ({ generation }: { generation: string }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: asset,
          selectedId: asset.entity_id,
          generation,
          submitCommand
        }),
      { initialProps: { generation: "asset-1:1" } }
    );

    act(() => {
      result.current.onMapContextMenu({ entityId: asset.entity_id, x: 10, y: 20, lat: 40, lng: -74 });
    });
    expect(result.current.mapMenu).not.toBeNull();

    rerender({ generation: "asset-1:2" });
    expect(result.current.mapMenu).toBeNull();

    act(() => {
      result.current.pickSidebarCommand(formAvailability);
    });
    expect(result.current.commandForm).not.toBeNull();

    rerender({ generation: "asset-1:3" });
    expect(result.current.commandForm).toBeNull();
  });

  it("does not reuse a pending idempotency key after the command generation changes", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const submitCommand = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(task);
    const { result, rerender } = renderHook(
      ({ generation }: { generation: string }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: asset,
          selectedId: asset.entity_id,
          generation,
          submitCommand
        }),
      { initialProps: { generation: "asset-1:1" } }
    );

    await act(async () => result.current.submit(availability, { value: "same" }));
    rerender({ generation: "asset-1:2" });
    await act(async () => result.current.submit(availability, { value: "same" }));

    expect(submitCommand).toHaveBeenCalledTimes(2);
    expect(submitCommand.mock.calls[0]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
    expect(submitCommand.mock.calls[1]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("ignores a late submission failure after the command generation changes", async () => {
    let rejectSubmission: ((reason: Error) => void) | undefined;
    const submitCommand = vi.fn(
      () =>
        new Promise<TaskResource>((_resolve, reject) => {
          rejectSubmission = reject;
        })
    );
    const { result, rerender } = renderHook(
      ({ generation }: { generation: string }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: asset,
          selectedId: asset.entity_id,
          generation,
          submitCommand
        }),
      { initialProps: { generation: "asset-1:1" } }
    );
    let submission: Promise<void> | undefined;

    act(() => {
      submission = result.current.submit(availability, { value: "same" });
    });
    rerender({ generation: "asset-1:2" });
    await act(async () => {
      rejectSubmission?.(new Error("late failure"));
      await submission;
    });

    expect(result.current.submitError).toBeUndefined();
  });

  it("unblocks the refreshed generation when the prior submission hangs", async () => {
    let resolveSubmission: ((value: TaskResource) => void) | undefined;
    const submitCommand = vi.fn(
      () =>
        new Promise<TaskResource>((resolve) => {
          resolveSubmission = resolve;
        })
    );
    const { result, rerender } = renderHook(
      ({ generation }: { generation: string }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: asset,
          selectedId: asset.entity_id,
          generation,
          submitCommand
        }),
      { initialProps: { generation: "asset-1:1" } }
    );
    let submission: Promise<void> | undefined;

    act(() => {
      submission = result.current.submit(availability, { value: "same" });
    });
    expect(result.current.submitting).toBe(true);

    rerender({ generation: "asset-1:2" });
    expect(result.current.submitting).toBe(false);

    act(() => {
      result.current.pickSidebarCommand(formAvailability);
    });
    expect(result.current.commandForm).not.toBeNull();

    await act(async () => {
      resolveSubmission?.(task);
      await submission;
    });
    expect(result.current.commandForm).not.toBeNull();
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
});
