import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import * as mapViewHarness from "./MapView.test-harness.js";

const { appendMarker, firePointerMove, rect, renderMapView } = mapViewHarness;

describe("MapView pointer lifecycle", () => {
  it("coalesces pointer movement to the latest position in one animation frame", () => {
    const frames = stubAnimationFrames();

    const { canvas, map } = renderMapView();
    flushAnimationFrames(frames);
    map.queryRenderedFeatures.mockClear();

    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    firePointerMove(canvas, { clientX: 90, clientY: 110 });

    expect(frames.size).toBe(1);
    expect(document.querySelector(".map-reticle")).not.toBeInTheDocument();

    flushAnimationFrames(frames, 16);

    const overlay = document.querySelector<HTMLElement>(".map-reticle");
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(1);
    expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("80px");
    expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("90px");
  });

  it("cancels a pending reticle frame when the pointer leaves", () => {
    const frames = stubAnimationFrames();

    const { canvas } = renderMapView();
    flushAnimationFrames(frames);

    firePointerMove(canvas, { clientX: 80, clientY: 100 });
    fireEvent.pointerLeave(canvas);

    expect(frames.size).toBe(0);
    expect(canvas).not.toHaveClass("map-canvas--custom-cursor");
    expect(document.querySelector(".map-reticle")).not.toBeInTheDocument();
  });

  it("uses the click position instead of a targeted reticle from a pending pointer frame", () => {
    const frames = stubAnimationFrames();

    const { canvas, onBackgroundClick, onSelectEntity } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    firePointerMove(marker, { clientX: 80, clientY: 100 });
    flushAnimationFrames(frames);
    expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted");

    firePointerMove(canvas, { clientX: 300, clientY: 100 });
    fireEvent.click(canvas, { clientX: 300, clientY: 100 });

    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(onBackgroundClick).toHaveBeenCalledOnce();
  });

  it("cancels a pending reticle frame when the map unmounts", () => {
    const frames = stubAnimationFrames();

    const { canvas, unmount } = renderMapView();
    flushAnimationFrames(frames);
    firePointerMove(canvas, { clientX: 80, clientY: 100 });

    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });
});

function stubAnimationFrames(): Map<number, FrameRequestCallback> {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frameId = ++nextFrameId;
    frames.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (frameId: number) => frames.delete(frameId));
  return frames;
}

function flushAnimationFrames(frames: Map<number, FrameRequestCallback>, timestamp = 0): void {
  act(() => {
    for (const [frameId, callback] of frames) {
      frames.delete(frameId);
      callback(timestamp);
    }
  });
}
