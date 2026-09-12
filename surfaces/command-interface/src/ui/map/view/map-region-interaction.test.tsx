import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Map as MlMap } from "maplibre-gl";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { rect } from "./MapView.test-harness.js";
import type { RegionBounds } from "./map-region-geometry.js";
import {
  type RegionDrawResult,
  type RegionInteractionCancellation,
  useMapRegionInteraction
} from "./map-region-interaction.js";

describe("useMapRegionInteraction", () => {
  it("completes a clamped drawing for its active pointer and cleans up capture", async () => {
    const { canvas, setPointerCapture, releasePointerCapture } = interactionCanvas(rect(10, 20, 100, 80));
    const onDrawResult = vi.fn();
    const suppressNextClick = vi.fn();

    render(<DrawingHarness canvas={canvas} onDrawResult={onDrawResult} suppressNextClick={suppressNextClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Draw" }));
    await waitFor(() => expect(canvas).toHaveClass("map-canvas--region-drawing"));

    fireEvent.pointerDown(canvas, { pointerId: 7, button: 0, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 70, clientY: 60 });
    expect(screen.getByTestId("drawing-rect")).toHaveTextContent("10,10,0,0");

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 130, clientY: 120 });
    expect(screen.getByTestId("drawing-rect")).toHaveTextContent("10,10,90,70");
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 130, clientY: 120 });

    expect(onDrawResult).toHaveBeenCalledWith({
      kind: "complete",
      initialRegion: null,
      region: { west: 10, south: 10, east: 100, north: 80 }
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(suppressNextClick).toHaveBeenCalledOnce();
    expect(canvas).not.toHaveClass("map-canvas--region-drawing");
  });

  it("can reject a date-line drawing and remain armed for another pointer", async () => {
    const { canvas, setPointerCapture } = interactionCanvas(rect(0, 0, 100, 80), false);
    const map = interactionMap();
    vi.mocked(map.unproject).mockImplementation((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x < 50 ? 179.8 : -179.8, lat: y } as ReturnType<MlMap["unproject"]>;
    });
    const onDrawResult = vi.fn(() => "continue" as const);

    render(<DrawingHarness canvas={canvas} map={map} onDrawResult={onDrawResult} suppressNextClick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Draw" }));
    await waitFor(() => expect(canvas).toHaveClass("map-canvas--region-drawing"));
    fireEvent.pointerDown(canvas, { pointerId: 4, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 4, clientX: 90, clientY: 70 });

    expect(onDrawResult).toHaveBeenCalledWith({ kind: "invalid", initialRegion: null });
    expect(screen.getByRole("status")).toHaveTextContent("Date-line crossings are not supported");
    expect(canvas).toHaveClass("map-canvas--region-drawing");

    fireEvent.pointerDown(canvas, { pointerId: 5, button: 0, clientX: 20, clientY: 20 });
    expect(setPointerCapture).toHaveBeenLastCalledWith(5);
  });

  it("ignores unrelated pointers and reports the original region when a transform is canceled", () => {
    const { canvas, releasePointerCapture } = interactionCanvas(rect(0, 0, 100, 80));
    const onCancel = vi.fn();
    const onRegionChange = vi.fn();

    render(<TransformHarness canvas={canvas} onCancel={onCancel} onRegionChange={onRegionChange} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move" }), {
      pointerId: 11,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    fireEvent.pointerMove(window, { pointerId: 12, clientX: 30, clientY: 20 });
    fireEvent.pointerCancel(window, { pointerId: 12 });
    expect(onRegionChange).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { pointerId: 11, clientX: 30, clientY: 20 });
    expect(onRegionChange).toHaveBeenCalledWith({ west: 30, south: 20, east: 70, north: 60 });
    fireEvent.pointerCancel(window, { pointerId: 11 });

    expect(onCancel).toHaveBeenCalledWith({
      kind: "transform",
      initialRegion: { west: 10, south: 10, east: 50, north: 50 },
      reason: "pointer"
    });
    expect(releasePointerCapture).toHaveBeenCalledWith(11);
  });

  it("can suppress external cancellation only while the pointer is still captured", () => {
    const { canvas } = interactionCanvas(rect(0, 0, 100, 80), false);
    const suppressNextClick = vi.fn();

    render(
      <TransformHarness
        canvas={canvas}
        onCancel={vi.fn()}
        onRegionChange={vi.fn()}
        suppressNextClick={suppressNextClick}
      />
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move" }), {
      pointerId: 15,
      button: 0,
      clientX: 10,
      clientY: 10
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel externally" }));

    expect(suppressNextClick).not.toHaveBeenCalled();
  });
});

function interactionCanvas(bounds: DOMRect, pointerCaptured = true) {
  const canvas = document.createElement("div");
  document.body.append(canvas);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(bounds);
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.assign(canvas, {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture: vi.fn(() => pointerCaptured)
  });
  return { canvas, setPointerCapture, releasePointerCapture };
}

function DrawingHarness({
  canvas,
  map: suppliedMap,
  onDrawResult,
  suppressNextClick
}: {
  canvas: HTMLDivElement;
  map?: MlMap;
  onDrawResult(result: RegionDrawResult): "continue" | void;
  suppressNextClick(): void;
}) {
  const [region, setRegion] = useState<RegionBounds | null>(null);
  const fallbackMap = useMemo(interactionMap, []);
  const interaction = useMapRegionInteraction({
    map: suppliedMap ?? fallbackMap,
    mapCanvas: canvas,
    onBeginInteraction: vi.fn(),
    onRegionChange: setRegion,
    onDrawResult,
    onCancel: vi.fn(),
    escapeBlocked: () => false,
    suppressNextClick
  });

  return (
    <>
      <button type="button" onClick={() => interaction.beginDrawing(region)}>
        Draw
      </button>
      {interaction.drawingRect ? (
        <output data-testid="drawing-rect">
          {interaction.drawingRect.left},{interaction.drawingRect.top},{interaction.drawingRect.width},
          {interaction.drawingRect.height}
        </output>
      ) : null}
      {interaction.selectionError ? <output role="status">{interaction.selectionError}</output> : null}
    </>
  );
}

function TransformHarness({
  canvas,
  onCancel,
  onRegionChange,
  suppressNextClick = vi.fn()
}: {
  canvas: HTMLDivElement;
  onCancel(cancellation: RegionInteractionCancellation): void;
  onRegionChange(region: RegionBounds): void;
  suppressNextClick?: () => void;
}) {
  const map = useMemo(interactionMap, []);
  const region = { west: 10, south: 10, east: 50, north: 50 };
  const interaction = useMapRegionInteraction({
    map,
    mapCanvas: canvas,
    onBeginInteraction: vi.fn(),
    onRegionChange,
    onDrawResult: vi.fn(),
    onCancel,
    escapeBlocked: () => false,
    suppressNextClick
  });

  return (
    <>
      <button type="button" onPointerDown={(event) => interaction.beginTransform("move", event, region)}>
        Move
      </button>
      <button
        type="button"
        onClick={() =>
          interaction.cancelInteraction({
            reason: "external",
            suppressReleaseClick: "if-captured",
            notify: true
          })
        }
      >
        Cancel externally
      </button>
    </>
  );
}

function interactionMap(): MlMap {
  return {
    project: vi.fn(([longitude, latitude]: [number, number]) => ({ x: longitude, y: latitude })),
    unproject: vi.fn((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x, lat: y };
    })
  } as unknown as MlMap;
}
