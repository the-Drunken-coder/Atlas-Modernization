import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { appendMarker, firePointerMove, rect, renderMapView } from "./MapView.test-harness.js";

describe("MapView hover target box", () => {
  it("fits a padded rectangle around hovered map markers instead of forcing a square", async () => {
    const { canvas } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 28, 40));

    firePointerMove(marker, { clientX: 80, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-x")).toBe("53px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-y")).toBe("63px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-width")).toBe("42px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-height")).toBe("54px");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("74px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("90px");
    });
  });

  it("locks onto a marker within the magnet radius without touching it", async () => {
    const { canvas } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    // Marker box is (60,70)-(80,90) map-relative; the pointer lands 5px to its right.
    firePointerMove(canvas, { clientX: 95, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });

  it("keeps a plain cursor reticle when a marker sits beyond the magnet radius", async () => {
    const { canvas } = renderMapView();
    appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    // The pointer lands 9px to the marker's right, just outside the 8px magnet.
    firePointerMove(canvas, { clientX: 99, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).not.toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("89px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });

  it("locks onto the nearest marker when several sit within the magnet radius", async () => {
    const { canvas } = renderMapView();
    appendMarker(canvas, "asset-far", rect(70, 90, 20, 20));
    appendMarker(canvas, "asset-near", rect(98, 90, 20, 20));

    // Point (85,80) is 5px from asset-far's box and 3px from asset-near's box.
    firePointerMove(canvas, { clientX: 95, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("98px");
    });
  });

  it("releases a locked reticle when Escape is pressed", async () => {
    const { canvas } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(document.querySelector(".map-reticle")).not.toBeInTheDocument();
      expect(canvas).not.toHaveClass("map-canvas--custom-cursor");
    });
  });

  it("reuses cached marker boxes until the camera moves or viewport resizes", async () => {
    const { canvas, map } = renderMapView();
    const measure = vi.fn(() => rect(70, 90, 20, 20));
    appendMarker(canvas, "asset-1", measure);

    firePointerMove(canvas, { clientX: 210, clientY: 150 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toBeInTheDocument());
    firePointerMove(canvas, { clientX: 220, clientY: 160 });
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe(
        "210px"
      )
    );

    expect(measure).toHaveBeenCalledTimes(1);

    act(() => map.fire("move"));
    firePointerMove(canvas, { clientX: 230, clientY: 170 });
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe(
        "220px"
      )
    );

    expect(measure).toHaveBeenCalledTimes(2);

    act(() => map.fire("resize"));
    firePointerMove(canvas, { clientX: 240, clientY: 180 });
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe(
        "230px"
      )
    );

    expect(measure).toHaveBeenCalledTimes(3);
  });

  it("remeasures cached marker boxes when the canvas shifts without resizing", async () => {
    const { canvas } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));

    firePointerMove(marker, { clientX: 80, clientY: 100 });
    await waitFor(() => expect(document.querySelector(".map-reticle")).toHaveClass("map-reticle--targeted"));

    vi.mocked(canvas.getBoundingClientRect).mockReturnValue(rect(30, 20, 400, 200));
    firePointerMove(canvas, { clientX: 72, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay).toHaveClass("map-reticle--targeted");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("50px");
    });
  });

  it("ignores a native marker hit that is far from the handed-off visual cursor", async () => {
    const { canvas, onBackgroundClick, onSelectEntity, rerenderMap } = renderMapView();
    const marker = appendMarker(canvas, "asset-1", rect(70, 90, 20, 20));
    rerenderMap({ focusTarget: { type: "point", id: "search-1", coordinates: [200, 150] } });
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".map-reticle")?.style.getPropertyValue("--map-reticle-x")).toBe(
        "200px"
      )
    );

    vi.useFakeTimers();
    try {
      fireEvent.wheel(canvas, { clientX: 80, clientY: 100, deltaY: -120 });
      act(() => vi.advanceTimersByTime(180));
      firePointerMove(marker, { clientX: 80, clientY: 100 });
      fireEvent.click(marker, { clientX: 80, clientY: 100, detail: 1 });

      expect(onSelectEntity).not.toHaveBeenCalled();
      expect(onBackgroundClick).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the default cursor target square when no marker is hovered", async () => {
    const { canvas } = renderMapView();

    firePointerMove(canvas, { clientX: 80, clientY: 100 });

    await waitFor(() => {
      const overlay = document.querySelector<HTMLElement>(".map-reticle");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-width")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-reticle-target-height")).toBe("22px");
      expect(overlay?.style.getPropertyValue("--map-reticle-x")).toBe("70px");
      expect(overlay?.style.getPropertyValue("--map-reticle-y")).toBe("80px");
    });
  });
});
