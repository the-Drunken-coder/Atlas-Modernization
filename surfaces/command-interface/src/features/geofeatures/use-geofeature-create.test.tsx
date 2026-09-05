import { act, renderHook } from "@testing-library/react";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import { type DrawingShape, useGeofeatureCreate } from "./use-geofeature-create.js";

describe("Geo Feature creation", () => {
  it.each<DrawingShape>(["Point", "LineString", "Polygon", "Circle"])("builds a valid %s draft", (shape) => {
    const { result } = renderHook(() => useGeofeatureCreate(vi.fn(), vi.fn()));
    act(() => result.current.start());
    act(() => {
      result.current.setName("Boundary");
      result.current.redraw(shape);
    });
    act(() => result.current.addPoint([-71, 42]));
    if (shape === "LineString" || shape === "Polygon") {
      expect(result.current.canFinish).toBe(false);
      act(() => result.current.addPoint([-70, 42]));
      if (shape === "Polygon") {
        expect(result.current.canFinish).toBe(false);
        act(() => result.current.addPoint([-70, 43]));
      }
      expect(result.current.canSave).toBe(false);
      act(() => result.current.finish());
    }
    expect(result.current.canSave).toBe(true);
    expect(result.current.draft?.geometry?.type).toBe(shape === "Circle" ? "Feature" : shape);
    if (shape === "Polygon")
      expect(result.current.draft?.geometry).toEqual({
        type: "Polygon",
        coordinates: [
          [
            [-71, 42],
            [-70, 42],
            [-70, 43],
            [-71, 42]
          ]
        ]
      });
    act(() => result.current.redraw(shape));
    expect(result.current.draft?.geometry).toBeUndefined();
    expect(result.current.canSave).toBe(false);
  });

  it("retains the draft after failure, prevents duplicate submissions, and retries with the same ID", async () => {
    let reject!: (error: Error) => void;
    const created = { entity_id: "created" } as EntityResource;
    const create = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          })
      )
      .mockResolvedValue(created);
    const onCreated = vi.fn();
    const { result } = renderHook(() => useGeofeatureCreate(create, onCreated));
    act(() => result.current.start());
    act(() => {
      result.current.setName("  Rally  ");
      result.current.redraw("Point");
    });
    act(() => result.current.addPoint([-71, 42]));
    const id = result.current.draft?.id;
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
      void result.current.save();
      result.current.cancel();
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.current.draft?.id).toBe(id);
    await act(async () => {
      reject(new Error("Name already in use"));
      await saving;
    });
    expect(result.current.error).toBe("Name already in use");
    expect(result.current.canSave).toBe(true);
    await act(async () => result.current.save());
    expect(create).toHaveBeenNthCalledWith(2, id, "Rally", { type: "Point", coordinates: [-71, 42] });
    expect(onCreated).toHaveBeenCalledWith(created);
    expect(result.current.draft).toBeNull();
  });
});
