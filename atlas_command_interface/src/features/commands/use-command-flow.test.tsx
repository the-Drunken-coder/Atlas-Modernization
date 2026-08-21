import { act, renderHook } from "@testing-library/react";
import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const asset: EntityResource = {
  entity_id: "asset-1",
  entity_type: "asset",
  subtype: null,
  alias: "Rover 1",
  components: {},
  command_manifest: [availability.manifest],
  metadata: { created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z", version: 1 }
};

const task: TaskResource = {
  task_id: "task-1",
  asset_id: asset.entity_id,
  command: availability.command.command,
  input: { value: "same" },
  status: "pending",
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z"
};

afterEach(() => vi.restoreAllMocks());

describe("useCommandFlow", () => {
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
});
