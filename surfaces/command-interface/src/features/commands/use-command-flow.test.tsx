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

  it("reuses a pending idempotency key across command generation changes", async () => {
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
    expect(submitCommand.mock.calls[1]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("retains the command form and uncertain key while the same manifest revalidates", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
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
      (props: { commandManifestStatus: "ready" | "loading"; commandManifestGeneration: string }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: asset,
          selectedId: asset.entity_id,
          submitCommand,
          ...props
        }),
      { initialProps: { commandManifestStatus: "ready", commandManifestGeneration: "manifest-1" } }
    );

    act(() => result.current.pickSidebarCommand(formAvailability));
    const form = result.current.commandForm;
    expect(form).not.toBeNull();
    let submission: Promise<void> | undefined;
    act(() => {
      submission = result.current.submit(formAvailability, { value: "same" });
    });

    rerender({ commandManifestStatus: "loading", commandManifestGeneration: "manifest-1" });
    expect(result.current.commandForm).toBe(form);
    expect(result.current.submitting).toBe(true);
    await act(async () => result.current.submit(formAvailability, { value: "same" }));
    expect(submitCommand).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectSubmission?.(new Error("response lost"));
      await submission;
    });
    expect(result.current.commandForm).toBe(form);
    expect(result.current.submitting).toBe(false);
    expect(result.current.submitError).toBe("response lost");

    rerender({ commandManifestStatus: "ready", commandManifestGeneration: "manifest-1" });
    expect(result.current.submitError).toBe("response lost");
    await act(async () => result.current.submit(formAvailability, { value: "same" }));
    expect(submitCommand).toHaveBeenCalledTimes(2);
    expect(submitCommand.mock.calls[0]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
    expect(submitCommand.mock.calls[1]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("forgets a completed attempt after a manifest revalidation", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    let resolveSubmission: ((value: TaskResource) => void) | undefined;
    const submitCommand = vi
      .fn<NonNullable<Parameters<typeof useCommandFlow>[0]["submitCommand"]>>()
      .mockImplementationOnce(
        () =>
          new Promise<TaskResource>((resolve) => {
            resolveSubmission = resolve;
          })
      )
      .mockResolvedValueOnce(task);
    const { result, rerender } = renderHook(
      (props: { commandManifestStatus: "ready" | "loading"; commandManifestGeneration: string }) =>
        useCommandFlow({
          catalog: commandCatalog,
          selectedEntity: asset,
          selectedId: asset.entity_id,
          submitCommand,
          ...props
        }),
      { initialProps: { commandManifestStatus: "ready", commandManifestGeneration: "manifest-1" } }
    );

    act(() => result.current.pickSidebarCommand(formAvailability));
    expect(result.current.commandForm).not.toBeNull();
    let submission: Promise<void> | undefined;
    act(() => {
      submission = result.current.submit(formAvailability, { value: "same" });
    });

    rerender({ commandManifestStatus: "loading", commandManifestGeneration: "manifest-1" });
    await act(async () => {
      resolveSubmission?.(task);
      await submission;
    });
    expect(result.current.commandForm).toBeNull();
    expect(result.current.submitting).toBe(false);

    rerender({ commandManifestStatus: "ready", commandManifestGeneration: "manifest-1" });
    act(() => result.current.pickSidebarCommand(formAvailability));
    await act(async () => result.current.submit(formAvailability, { value: "same" }));
    expect(submitCommand.mock.calls[0]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
    expect(submitCommand.mock.calls[1]?.[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("surfaces a late submission failure after the command generation changes", async () => {
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

    expect(result.current.submitError).toBe("late failure");
  });

  it("keeps a refreshed generation blocked while the prior submission hangs", async () => {
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
    expect(result.current.submitting).toBe(true);

    act(() => {
      result.current.pickSidebarCommand(formAvailability);
    });
    expect(result.current.commandForm).toBeNull();

    await act(async () => {
      resolveSubmission?.(task);
      await submission;
    });
    expect(result.current.submitting).toBe(false);
    act(() => {
      result.current.pickSidebarCommand(formAvailability);
    });
    expect(result.current.commandForm).not.toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "allows tasking another asset while an old request hangs and ignores its late %s",
    async (outcome) => {
      const nextAsset = { ...asset, entity_id: "asset-2" };
      let resolveFirst: ((value: TaskResource) => void) | undefined;
      let rejectFirst: ((reason: Error) => void) | undefined;
      let resolveSecond: ((value: TaskResource) => void) | undefined;
      const first = new Promise<TaskResource>((resolve, reject) => {
        resolveFirst = resolve;
        rejectFirst = reject;
      });
      const second = new Promise<TaskResource>((resolve) => {
        resolveSecond = resolve;
      });
      const submitCommand = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
      const { result, rerender } = renderHook(
        (props: { entity: typeof asset; commandManifestStatus: "ready" | "loading" }) =>
          useCommandFlow({
            catalog: commandCatalog,
            selectedEntity: props.entity,
            selectedId: props.entity.entity_id,
            generation: props.entity.entity_id,
            commandManifestStatus: props.commandManifestStatus,
            submitCommand
          }),
        { initialProps: { entity: asset, commandManifestStatus: "ready" } }
      );
      let firstSubmission: Promise<void> | undefined;
      act(() => {
        firstSubmission = result.current.submit(availability, { value: "first" });
      });
      expect(result.current.submitting).toBe(true);

      rerender({ entity: nextAsset, commandManifestStatus: "loading" });
      expect(result.current.submitting).toBe(false);
      rerender({ entity: nextAsset, commandManifestStatus: "ready" });
      act(() => result.current.pickSidebarCommand(formAvailability));
      const nextForm = result.current.commandForm;
      expect(nextForm).not.toBeNull();
      let secondSubmission: Promise<void> | undefined;
      act(() => {
        secondSubmission = result.current.submit(formAvailability, { value: "second" });
      });
      expect(submitCommand).toHaveBeenCalledTimes(2);
      expect(submitCommand.mock.calls[1]?.[0].assetId).toBe(nextAsset.entity_id);

      await act(async () => {
        if (outcome === "success") resolveFirst?.(task);
        else rejectFirst?.(new Error("old asset failure"));
        await firstSubmission;
      });
      expect(result.current.submitting).toBe(true);
      expect(result.current.commandForm).toBe(nextForm);
      expect(result.current.submitError).toBeUndefined();
      await act(async () => {
        resolveSecond?.({ ...task, asset_id: nextAsset.entity_id });
        await secondSubmission;
      });
      expect(result.current.submitting).toBe(false);
      expect(result.current.commandForm).toBeNull();
    }
  );

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

  it("retains an uncertain form submission across a manifest refresh", async () => {
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
    expect(result.current.submitError).toBe("response lost");

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
