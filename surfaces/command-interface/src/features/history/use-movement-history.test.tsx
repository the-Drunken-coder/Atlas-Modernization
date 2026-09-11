import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type {
  MovementHistoryPage,
  MovementInspection,
  MovementSample,
  MovementTrail
} from "@the-drunken-coder/atlas-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { entityFixture } from "../../../test/fixtures.js";
import type { MovementHistoryReader } from "../../atlas/data-source.js";
import { MovementHistorySection, movementAge } from "./MovementHistorySection.js";
import { useMovementHistory } from "./use-movement-history.js";

const time = "2026-09-09T12:00:00Z";
const entity = entityFixture();
const sample: MovementSample = {
  sample_id: "report",
  time,
  received_at: time,
  observed_at: time,
  time_is_arrival: false,
  latitude: 0,
  longitude: 0
};
const page: MovementHistoryPage = {
  entity_created_at: entity.metadata.created_at,
  from: time,
  to: time,
  retained_from: time,
  snapshot: "1",
  samples: [sample]
};
const trail: MovementTrail = { ...page, points: [{ sample, gap_before: false }], position_count: 1, simplified: false };
function reader() {
  return {
    history: vi.fn<MovementHistoryReader["history"]>().mockResolvedValue(page),
    trail: vi.fn<MovementHistoryReader["trail"]>().mockResolvedValue(trail),
    inspectMovement: vi
      .fn<MovementHistoryReader["inspectMovement"]>()
      .mockResolvedValue({ entity_created_at: entity.metadata.created_at, time, position: sample })
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(time));
});
afterEach(() => vi.useRealTimers());
const settle = async () => {
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
};

it("fetches only while open, follows reports, then holds pinned readings across live updates", async () => {
  const api = reader();
  const { result, rerender } = renderHook(({ selected }) => useMovementHistory(selected, api), {
    initialProps: { selected: entity }
  });
  expect(api.history).not.toHaveBeenCalled();
  act(() => result.current.toggle());
  await settle();
  expect(result.current.inspection?.position?.latitude).toBe(0);
  await act(async () => vi.advanceTimersByTimeAsync(5001));
  expect(api.history).toHaveBeenCalledTimes(2);
  act(() => result.current.pin(sample));
  await settle();
  const reads = api.history.mock.calls.length;
  rerender({ selected: { ...entity, components: { telemetry: { latitude: 40, longitude: 10 } } } });
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(api.history).toHaveBeenCalledTimes(reads);
  expect(result.current.sample).toEqual(sample);
  expect(result.current.inspection?.position?.latitude).toBe(0);
  expect(result.current.following).toBe(false);
  act(() => result.current.recent());
  await settle();
  expect(api.history).toHaveBeenCalledTimes(reads + 1);
});

it("aborts old association reads and ignores a response that arrives after replacement", async () => {
  const api = reader();
  let resolve!: (value: MovementHistoryPage) => void;
  api.history.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const { result, rerender } = renderHook(({ selected }) => useMovementHistory(selected, api), {
    initialProps: { selected: entity }
  });
  act(() => result.current.toggle());
  const signal = api.history.mock.calls[0]?.[1].signal;
  rerender({ selected: { ...entity, metadata: { ...entity.metadata, created_at: "2026-09-09T11:00:00Z" } } });
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(page));
  expect(result.current.open).toBe(false);
  expect(result.current.data).toBeUndefined();
  expect(result.current.sample).toBeUndefined();
});

it.each(["range", "recent"] as const)("ignores an old response before %s effect cleanup", async (transition) => {
  const api = reader();
  let resolve!: (value: MovementHistoryPage) => void;
  api.history.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  api.history.mockRejectedValue(new Error("Replacement failed"));
  // Resolve inside the same batch, before React commits the new view and cleans up effects.
  await act(async () => {
    if (transition === "range") result.current.changeRange(86400000);
    else result.current.recent();
    resolve(page);
    await Promise.resolve();
  });
  await settle();
  expect(result.current.data).toBeUndefined();
  expect(result.current.sample).toBeUndefined();
  expect(result.current.error).toContain("Replacement failed");
});

it("previews without unpinning and cancels obsolete inspection requests", async () => {
  const api = reader();
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  await settle();
  act(() => result.current.pin(sample));
  await settle();
  const other = { ...sample, sample_id: "older", time: "2026-09-09T11:59:00Z" };
  act(() => result.current.setPreview(other));
  await act(async () => vi.advanceTimersByTimeAsync(101));
  expect(result.current.sample).toEqual(other);
  const signal = api.inspectMovement.mock.calls.at(-1)?.[3];
  act(() => result.current.setPreview(undefined));
  expect(signal?.aborted).toBe(true);
  expect(result.current.sample).toEqual(sample);
  act(() => {
    expect(result.current.dismiss()).toBe(true);
  });
  expect(result.current.sample).toBeUndefined();
});

it("uses historical time and only labels quantities older than 60 seconds", () => {
  expect(movementAge(sample, "2026-09-09T12:01:00Z")).toBeUndefined();
  expect(movementAge(sample, "2026-09-09T12:01:01Z")).toBe("1 min old");
  expect(movementAge(undefined, time)).toBeUndefined();
  expect(movementAge(sample, "2026-09-09T12:01:00.000001Z")).toBe("1 min old");
  expect(
    movementAge({ ...sample, time: "2026-09-09T12:00:00.000001Z" }, "2026-09-09T12:01:00.000001Z")
  ).toBeUndefined();
});

it("steps actual reports from focused sidebar controls and Escape dismisses the pin", async () => {
  const api = reader();
  api.history.mockResolvedValue({
    ...page,
    samples: [sample, { ...sample, sample_id: "older", time: "2026-09-09T11:59:00Z" }]
  });
  function Panel() {
    return <MovementHistorySection history={useMovementHistory(entity, api)} />;
  }
  render(<Panel />);
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  await settle();
  const control = screen.getByRole("combobox", { name: "Historical report" });
  fireEvent.keyDown(control, { key: "ArrowLeft" });
  await settle();
  expect(control).toHaveValue("older");
  expect(screen.getByText("Pinned · UTC")).toBeInTheDocument();
  fireEvent.keyDown(control, { key: "Escape" });
  expect(control).toHaveValue("");
});

it("shows reports before a slow trail completes and preserves inspection when the trail fails", async () => {
  const api = reader();
  let reject!: (reason: Error) => void;
  api.trail.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      })
  );
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  await settle();
  expect(result.current.sample).toEqual(sample);
  expect(result.current.inspection?.position).toEqual(sample);
  await act(async () => reject(new Error("Trail point budget exceeded")));
  expect(result.current.error).toBeUndefined();
  expect(result.current.trailError).toContain("budget");
  expect(result.current.data?.trail).toBeUndefined();
  expect(result.current.inspection?.position).toEqual(sample);
});

it.each([86400000, 2592000000])("holds the %i ms interval until explicit refresh", async (duration) => {
  const api = reader();
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => {
    result.current.toggle();
    result.current.changeRange(duration);
  });
  await settle();
  const from = api.history.mock.calls[0]?.[1].from;
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(api.trail).toHaveBeenCalledTimes(1);
  expect(result.current.following).toBe(false);
  act(() => result.current.refresh());
  await settle();
  expect(api.history.mock.calls[1]?.[1].from).toBe(from);
  act(() => result.current.recent());
  await settle();
  expect(result.current.duration).toBe(3600000);
  expect(result.current.following).toBe(true);
});

it("keeps live report and readings together while inspecting a successor without leaking them into older selections", async () => {
  const api = reader();
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  await settle();
  const newer = { ...sample, sample_id: "newer", time: "2026-09-09T12:00:05Z", latitude: 5 };
  api.history.mockResolvedValue({ ...page, samples: [newer, sample] });
  let resolve!: (inspection: MovementInspection) => void;
  api.inspectMovement.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  await act(async () => vi.advanceTimersByTimeAsync(5001));
  expect(result.current.sample).toEqual(sample);
  expect(result.current.inspection?.position).toEqual(sample);
  expect(result.current.inspectionLoading).toBe(true);
  await settle();
  await act(async () => resolve({ entity_created_at: entity.metadata.created_at, time: newer.time, position: newer }));
  expect(result.current.sample).toEqual(newer);
  expect(result.current.inspection?.position).toEqual(newer);
  act(() => result.current.pin(sample));
  expect(result.current.sample).toEqual(sample);
  expect(result.current.inspection).toBeUndefined();
});

it("retains navigation and recovery on an empty continuation page", async () => {
  const api = reader();
  api.history
    .mockResolvedValueOnce({ ...page, next_cursor: "older" })
    .mockResolvedValue({ ...page, samples: [], retention_advanced: true });
  function Panel() {
    return <MovementHistorySection history={useMovementHistory(entity, api)} />;
  }
  render(<Panel />);
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Older reports" }));
  await settle();
  expect(screen.getByRole("button", { name: "Newer reports" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Return to recent" })).toBeEnabled();
  expect(screen.queryByRole("combobox", { name: "Historical report" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Newer reports" }));
  await settle();
  expect(api.history.mock.calls.at(-1)?.[1].cursor).toBeUndefined();
});

it("reports a failed inspection without claiming it is still loading", async () => {
  const api = reader();
  api.inspectMovement.mockRejectedValue(new Error("Inspection unavailable"));
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  await settle();
  expect(result.current.inspectionError).toBeDefined();
  expect(result.current.inspectionLoading).toBe(false);
  expect(result.current.inspection).toBeUndefined();
});

it("retains the last successful trail after refresh failure", async () => {
  const api = reader();
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  await settle();
  api.trail.mockRejectedValue(new Error("Trail unavailable"));
  act(() => result.current.refresh());
  await settle();
  expect(result.current.data?.trail).toEqual(trail);
  expect(result.current.trailError).toBeDefined();
  act(() => result.current.changeRange(86400000));
  expect(result.current.data).toBeUndefined();
});

it("does not label a completed hover inspection as following when returning to live fails", async () => {
  const api = reader();
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  await settle();
  const older = { ...sample, sample_id: "hover", time: "2026-09-09T11:59:00Z" };
  api.inspectMovement.mockResolvedValue({
    entity_created_at: entity.metadata.created_at,
    time: older.time,
    position: older
  });
  act(() => result.current.setPreview(older));
  await act(async () => vi.advanceTimersByTimeAsync(101));
  expect(result.current.inspection?.position).toEqual(older);
  api.inspectMovement.mockRejectedValue(new Error("Inspection unavailable"));
  act(() => result.current.setPreview(undefined));
  await settle();
  expect(result.current.following).toBe(true);
  expect(result.current.sample).toEqual(sample);
  expect(result.current.inspection).toBeUndefined();
  expect(result.current.inspectionError).toBeDefined();
});

it("lets preview-only Escape fall through to Entity selection", async () => {
  const api = reader();
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  await settle();
  act(() => result.current.setPreview({ ...sample, sample_id: "hover" }));
  act(() => expect(result.current.dismiss()).toBe(false));
  expect(result.current.following).toBe(true);
});

it("keeps a fixed interval trail across raw-page navigation", async () => {
  const api = reader();
  api.history.mockResolvedValue({ ...page, next_cursor: "older" });
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => {
    result.current.toggle();
    result.current.changeRange(2592000000);
  });
  await settle();
  act(() => result.current.navigatePage(true));
  expect(result.current.data?.trail).toEqual(trail);
  await settle();
  act(() => result.current.navigatePage(false));
  await settle();
  expect(api.trail).toHaveBeenCalledTimes(1);
  act(() => result.current.refresh());
  await settle();
  expect(api.trail).toHaveBeenCalledTimes(2);
});

it.each(["2026-09-09T11:59:00Z", "2026-09-09T12:01:00Z"])(
  "labels retention coverage on a first page with cutoff %s",
  async (cutoff) => {
    const api = reader();
    api.history.mockResolvedValue({ ...page, samples: [], retained_from: cutoff });
    function Panel() {
      return <MovementHistorySection history={useMovementHistory(entity, api)} />;
    }
    render(<Panel />);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await settle();
    expect(screen.getByText(/Reports before .* are unavailable/)).toBeInTheDocument();
    if (cutoff > time) expect(screen.getByText("This interval is outside retained history.")).toBeInTheDocument();
  }
);

it("keeps an in-flight trail request alive across page navigation", async () => {
  const api = reader();
  api.history.mockResolvedValue({ ...page, next_cursor: "older" });
  let resolve!: (value: MovementTrail) => void;
  api.trail.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => {
    result.current.toggle();
    result.current.changeRange(2592000000);
  });
  await settle();
  const signal = api.trail.mock.calls[0]?.[1].signal;
  act(() => result.current.navigatePage(true));
  await settle();
  expect(api.trail).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  await act(async () => resolve(trail));
  expect(result.current.data?.trail).toEqual(trail);
});

it("accepts only one page transition until that page arrives", async () => {
  const api = reader();
  api.history.mockResolvedValueOnce({ ...page, next_cursor: "older" });
  const { result } = renderHook(() => useMovementHistory(entity, api));
  act(() => result.current.toggle());
  await settle();
  let resolve!: (value: MovementHistoryPage) => void;
  api.history.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  act(() => {
    result.current.navigatePage(true);
    result.current.navigatePage(true);
  });
  await settle();
  expect(result.current.navigationLoading).toBe(true);
  act(() => result.current.navigatePage(false));
  expect(api.history).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ ...page, next_cursor: "oldest" }));
  act(() => {
    result.current.navigatePage(false);
    result.current.navigatePage(false);
  });
  await settle();
  expect(api.history.mock.calls.at(-1)?.[1].cursor).toBeUndefined();
});

it("keeps automatic refresh quiet while explicit refresh still reports progress", async () => {
  const api = reader();
  let resolve!: (value: MovementHistoryPage) => void;
  api.history.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  function Panel() {
    return <MovementHistorySection history={useMovementHistory(entity, api)} />;
  }
  render(<Panel />);
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(screen.getByRole("status")).toHaveTextContent("Loading history");
  await act(async () => resolve(page));
  await settle();
  await act(async () => vi.advanceTimersByTimeAsync(5001));
  expect(api.history).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Historical report" })).toBeInTheDocument();
  await act(async () => resolve(page));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByRole("status")).toHaveTextContent("Refreshing history");
  await act(async () => resolve(page));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
