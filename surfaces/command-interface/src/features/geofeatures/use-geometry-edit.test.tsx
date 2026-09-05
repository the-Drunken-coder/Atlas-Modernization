import { act, renderHook } from "@testing-library/react";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it, vi } from "vitest";
import { entityFixture } from "../../../test/fixtures.js";
import type { UiGeometry } from "../../atlas/geometry.js";
import type { AtlasContextValue } from "../../state/atlas-context.js";
import { useGeometryEdit } from "./use-geometry-edit.js";

const draftA: UiGeometry = { type: "Point", coordinates: [-74.2, 40.1] };
const draftB: UiGeometry = { type: "Point", coordinates: [-74.1, 40.2] };

function geofeature(entityId = "geo-1", geometry = draftA, version = 1): EntityResource {
  return entityFixture({
    entity_id: entityId,
    entity_type: "geofeature",
    components: { geometry },
    metadata: { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("useGeometryEdit", () => {
  it("clears the edit after an unchanged save succeeds", async () => {
    const entity = geofeature();
    const updateGeometry = vi.fn().mockResolvedValue(geofeature("geo-1", draftA, 2));
    const { result } = renderHook(() =>
      useGeometryEdit({ selectedEntity: entity, selectedId: entity.entity_id, updateGeometry })
    );

    act(() => result.current.startEdit());
    await act(async () => result.current.saveEdit());

    expect(updateGeometry).toHaveBeenCalledWith("geo-1", draftA, 1);
    expect(result.current.edit).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it("preserves a newer draft and advances its version after the earlier save succeeds", async () => {
    const entity = geofeature();
    const first = deferred<EntityResource>();
    const second = deferred<EntityResource>();
    const updateGeometry = vi
      .fn<AtlasContextValue["updateGeometry"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useGeometryEdit({ selectedEntity: entity, selectedId: entity.entity_id, updateGeometry })
    );

    act(() => result.current.startEdit());
    let firstSave!: Promise<void>;
    act(() => {
      firstSave = result.current.saveEdit();
      result.current.changeDraft(draftB);
    });
    expect(result.current.edit?.draft).toEqual(draftB);
    expect(result.current.saving).toBe(true);

    await act(async () => {
      first.resolve(geofeature("geo-1", draftA, 2));
      await firstSave;
    });

    expect(result.current.edit?.draft).toEqual(draftB);
    expect(result.current.edit?.version).toBe(2);
    expect(result.current.saving).toBe(false);

    let secondSave!: Promise<void>;
    act(() => {
      secondSave = result.current.saveEdit();
    });
    await act(async () => {
      second.resolve(geofeature("geo-1", draftB, 3));
      await secondSave;
    });

    expect(updateGeometry).toHaveBeenNthCalledWith(1, "geo-1", draftA, 1);
    expect(updateGeometry).toHaveBeenNthCalledWith(2, "geo-1", draftB, 2);
    expect(result.current.edit).toBeNull();
  });

  it("submits a draft only once before React renders the saving state", async () => {
    const entity = geofeature();
    const pending = deferred<EntityResource>();
    const updateGeometry = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(() =>
      useGeometryEdit({ selectedEntity: entity, selectedId: entity.entity_id, updateGeometry })
    );
    act(() => result.current.startEdit());
    let saves: Promise<void>[] = [];
    act(() => {
      saves = [result.current.saveEdit(), result.current.saveEdit()];
    });
    expect(updateGeometry).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(geofeature("geo-1", draftA, 2));
      await Promise.all(saves);
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.edit).toBeNull();
  });

  it("retains a newer draft and exposes the failure when the earlier save fails", async () => {
    const entity = geofeature();
    const pending = deferred<EntityResource>();
    const updateGeometry = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(() =>
      useGeometryEdit({ selectedEntity: entity, selectedId: entity.entity_id, updateGeometry })
    );

    act(() => result.current.startEdit());
    let save!: Promise<void>;
    act(() => {
      save = result.current.saveEdit();
      result.current.changeDraft(draftB);
    });
    await act(async () => {
      pending.reject(new Error("save failed"));
      await save;
    });

    expect(result.current.edit?.draft).toEqual(draftB);
    expect(result.current.edit?.version).toBe(1);
    expect(result.current.saveError).toBe("save failed");
    expect(result.current.saving).toBe(false);
  });

  it("ignores a late response after the edit is cancelled", async () => {
    const entity = geofeature();
    const pending = deferred<EntityResource>();
    const updateGeometry = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(() =>
      useGeometryEdit({ selectedEntity: entity, selectedId: entity.entity_id, updateGeometry })
    );

    act(() => result.current.startEdit());
    let save!: Promise<void>;
    act(() => {
      save = result.current.saveEdit();
      result.current.cancelEdit();
    });
    expect(result.current.edit).toBeNull();
    expect(result.current.saving).toBe(false);

    await act(async () => {
      pending.resolve(geofeature("geo-1", draftA, 2));
      await save;
    });

    expect(result.current.edit).toBeNull();
    expect(result.current.saveError).toBeUndefined();
    expect(result.current.saving).toBe(false);
  });

  it("cancels the edit and ignores a late response after selection changes", async () => {
    const entity = geofeature();
    const nextEntity = geofeature("geo-2", draftB);
    const pending = deferred<EntityResource>();
    const updateGeometry = vi.fn().mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ selectedEntity, selectedId }: { selectedEntity: EntityResource; selectedId: string }) =>
        useGeometryEdit({ selectedEntity, selectedId, updateGeometry }),
      { initialProps: { selectedEntity: entity, selectedId: entity.entity_id } }
    );

    act(() => result.current.startEdit());
    let save!: Promise<void>;
    act(() => {
      save = result.current.saveEdit();
    });
    rerender({ selectedEntity: nextEntity, selectedId: nextEntity.entity_id });
    expect(result.current.edit).toBeNull();

    await act(async () => {
      pending.resolve(geofeature("geo-1", draftA, 2));
      await save;
    });

    expect(result.current.edit).toBeNull();
    expect(result.current.saveError).toBeUndefined();
    expect(result.current.saving).toBe(false);
  });
});
