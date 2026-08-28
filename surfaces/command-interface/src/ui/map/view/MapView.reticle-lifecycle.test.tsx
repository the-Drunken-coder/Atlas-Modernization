import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { appendMarker, firePointerMove, rect, renderMapView } from "./MapView.test-harness.js";

describe("MapView reticle lifecycle", () => {
  it("keeps the focused entity reticle ahead of live map background movement", async () => {
    const { canvas, rerenderMap } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    rerenderMap({ focusTarget: { type: "entity", id: "asset-1" } });
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe(
        "70px"
      )
    );

    firePointerMove(canvas, { clientX: 220, clientY: 120 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });

  it("keeps outside-map pointer listeners stable while the reticle moves", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const { canvas } = renderMapView();
    const pointerMoveRegistrations = () =>
      addListener.mock.calls.filter(([type]) => String(type) === "pointermove").length;
    const initialRegistrations = pointerMoveRegistrations();

    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());
    firePointerMove(canvas, { clientX: 90, clientY: 110 });

    expect(pointerMoveRegistrations()).toBe(initialRegistrations);
  });

  it("clears the reticle when the pointer leaves the map bounds", async () => {
    const { canvas } = renderMapView();
    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());

    fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });

    await waitFor(() => expect(document.querySelector(".map-reticle")).not.toBeInTheDocument());
  });

  it("cancels a pending camera settle frame before scheduling the latest one", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.fn((frameId: number) => {
      frames.delete(frameId);
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const rendered = renderMapView();
    const pendingFrameId = () => {
      const frameId = frames.keys().next().value;
      if (frameId === undefined) throw new Error("Expected a pending animation frame");
      return frameId;
    };
    const runFrame = (frameId: number) => {
      const callback = frames.get(frameId);
      if (!callback) return false;
      frames.delete(frameId);
      callback(0);
      return true;
    };

    try {
      const initialResizeFrame = pendingFrameId();
      act(() => {
        expect(runFrame(initialResizeFrame)).toBe(true);
      });
      const initialCameraSettleFrame = pendingFrameId();
      act(() => {
        expect(runFrame(initialCameraSettleFrame)).toBe(true);
      });
      expect(frames.size).toBe(0);
      expect(rendered.canvas).not.toHaveClass("map-canvas--scrolling");
      requestFrame.mockClear();
      cancelFrame.mockClear();

      act(() => rendered.map.fire("moveend"));
      const frameA = pendingFrameId();
      expect(frames.size).toBe(1);
      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(rendered.canvas).not.toHaveClass("map-canvas--scrolling");

      act(() => rendered.map.fire("movestart"));
      expect(cancelFrame).toHaveBeenCalledWith(frameA);
      expect(rendered.canvas).toHaveClass("map-canvas--scrolling");
      expect(frames.has(frameA)).toBe(false);

      act(() => rendered.map.fire("moveend"));
      const frameB = pendingFrameId();
      expect(frames.size).toBe(1);
      expect(frameB).not.toBe(frameA);
      expect(requestFrame).toHaveBeenCalledTimes(2);
      expect(rendered.canvas).toHaveClass("map-canvas--scrolling");

      act(() => {
        expect(runFrame(frameA)).toBe(false);
      });
      expect(rendered.canvas).toHaveClass("map-canvas--scrolling");

      act(() => {
        expect(runFrame(frameB)).toBe(true);
      });
      expect(rendered.canvas).not.toHaveClass("map-canvas--scrolling");
    } finally {
      rendered.unmount();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("does not subscribe targeted reticles to render frames", async () => {
    const { canvas, map } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));

    firePointerMove(marker, { clientX: 80, clientY: 100 });

    // One marker-box-cache invalidation listener plus one targeted-reticle sync listener.
    await waitFor(() => expect(map.listeners.get("move") ?? []).toHaveLength(2));
    expect(map.listeners.get("render") ?? []).toHaveLength(0);
  });
});
