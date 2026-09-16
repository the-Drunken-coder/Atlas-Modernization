import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGeofeatureDelete } from "./use-geofeature-delete.js";

describe("useGeofeatureDelete", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses the named confirmation and completes only after deletion resolves", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let finish!: () => void;
    const deletion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const removeEntity = vi.fn(() => deletion);
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useGeofeatureDelete(removeEntity, onDeleted));

    let request!: Promise<void>;
    act(() => {
      request = result.current.remove("geo-1", "Zone Alpha");
    });
    expect(confirm).toHaveBeenCalledWith('Delete "Zone Alpha"? This cannot be undone.');
    expect(result.current.deleting("geo-1")).toBe(true);
    expect(onDeleted).not.toHaveBeenCalled();

    await act(async () => finish());
    await request;
    expect(onDeleted).toHaveBeenCalledWith("geo-1");
    expect(result.current.deleting("geo-1")).toBe(false);

    await act(() => result.current.remove("geo-2", "Zone Bravo"));
    expect(removeEntity).toHaveBeenLastCalledWith("geo-2");
  });

  it("retains the target and sanitizes a failed deletion", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDeleted = vi.fn();
    const { result } = renderHook(() =>
      useGeofeatureDelete(
        vi.fn(async () => {
          throw new Error("request failed: Bearer secret-token");
        }),
        onDeleted
      )
    );

    await act(() => result.current.remove("geo-1", "Zone Alpha"));
    expect(result.current.deleting("geo-1")).toBe(false);
    expect(result.current.error("geo-1")).toBe("request failed: Bearer [redacted]");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
