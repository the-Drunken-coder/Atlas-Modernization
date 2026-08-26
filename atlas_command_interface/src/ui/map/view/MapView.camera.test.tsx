import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ASSET_VIEW_ZOOM,
  FOLLOW_EASE_MS,
  flyDurationMs,
  INITIAL_WORLD_BOUNDS,
  type MapCameraCommand,
  PREVIEW_DURATION_MS,
  PREVIEW_POINT_ZOOM,
  PREVIEW_RESTORE_MS,
  RETICLE_FLASH_MS
} from "../interaction/map-camera.js";
import { buildMapSources } from "../rendering/map-sources.js";
import { entity, markerSources, notifyResizeObservers, type PointLike, renderMapView } from "./MapView.test-harness.js";

describe("MapView camera commands", () => {
  const homeView = { center: [0, 0] as [number, number], zoom: 4 };
  const movedSources = () =>
    buildMapSources(
      [entity({ entity_id: "asset-1", components: { telemetry: { latitude: 41, longitude: -73 } } })],
      undefined
    );

  const startFollowing = async () => {
    const rendered = renderMapView({ sources: markerSources() });
    rendered.rerenderMap({ cameraCommand: { seq: 1, target: { type: "entity", id: "asset-1" } } });
    await waitFor(() => expect(rendered.map.flyTo).toHaveBeenCalledTimes(1));
    act(() => rendered.map.fire("moveend", { atlasCamera: true, atlasFlySeq: 1 }));
    rendered.map.easeTo.mockClear();
    return rendered;
  };

  it("fits the world once on load with a tagged instant move", async () => {
    const { map } = renderMapView();

    await waitFor(() =>
      expect(map.fitBounds).toHaveBeenCalledWith(
        INITIAL_WORLD_BOUNDS,
        { padding: 0, duration: 0 },
        { atlasCamera: true }
      )
    );
  });

  it("flies point commands to the standard asset view with a tagged arc flight", async () => {
    const { map, rerenderMap } = renderMapView();
    map.fitBounds.mockClear();

    rerenderMap({
      cameraCommand: { seq: 1, target: { type: "point", id: "search-1", coordinates: [70, 80] } },
      focusTarget: { type: "point", id: "search-1", coordinates: [70, 80] }
    });

    await waitFor(() =>
      expect(map.flyTo).toHaveBeenCalledWith(
        {
          center: [70, 80],
          zoom: ASSET_VIEW_ZOOM,
          duration: flyDurationMs(homeView, { center: [70, 80], zoom: ASSET_VIEW_ZOOM })
        },
        { atlasCamera: true }
      )
    );
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
    const overlay = document.querySelector<HTMLElement>(".map-reticle");
    expect(overlay).toHaveClass("map-reticle--targeted");
  });

  it("flies literal point commands without entering entity follow", async () => {
    const { map, rerenderMap } = renderMapView({ sources: markerSources() });

    rerenderMap({ cameraCommand: { seq: 1, target: { type: "point", id: "asset-1", coordinates: [70, 80] } } });

    await waitFor(() =>
      expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [70, 80], zoom: ASSET_VIEW_ZOOM }), {
        atlasCamera: true
      })
    );
    act(() => map.fire("moveend", { atlasCamera: true }));
    map.easeTo.mockClear();

    rerenderMap({ sources: movedSources() });

    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("does not re-fly for the same command but re-flies when the sequence bumps", async () => {
    const { map, rerenderMap } = renderMapView({ sources: markerSources() });

    rerenderMap({ cameraCommand: { seq: 1, target: { type: "entity", id: "asset-1" } } });
    await waitFor(() => expect(map.flyTo).toHaveBeenCalledTimes(1));

    rerenderMap({ sources: movedSources() });
    expect(map.flyTo).toHaveBeenCalledTimes(1);

    rerenderMap({ cameraCommand: { seq: 2, target: { type: "entity", id: "asset-1" } } });
    await waitFor(() => expect(map.flyTo).toHaveBeenCalledTimes(2));
    expect(map.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: [-73, 41] }), {
      atlasCamera: true,
      atlasFlySeq: 2
    });
  });

  it("waits for an unlocatable entity and flies once it becomes locatable", async () => {
    const command: MapCameraCommand = { seq: 1, target: { type: "entity", id: "asset-1" } };
    const { map, rerenderMap } = renderMapView({
      cameraCommand: command,
      sources: buildMapSources([entity({ entity_id: "asset-1" })], undefined)
    });
    expect(map.flyTo).not.toHaveBeenCalled();

    rerenderMap({ sources: markerSources() });

    await waitFor(() =>
      expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-74, 40], zoom: ASSET_VIEW_ZOOM }), {
        atlasCamera: true,
        atlasFlySeq: 1
      })
    );
  });

  it("fits geometry commands with a tagged bounded ease and never follows them", async () => {
    const { map, rerenderMap } = renderMapView();
    map.fitBounds.mockClear();

    rerenderMap({
      cameraCommand: {
        seq: 1,
        target: {
          type: "geometry",
          id: "area-1",
          geometry: {
            type: "LineString",
            coordinates: [
              [-75, 40],
              [-73, 42]
            ]
          }
        }
      }
    });

    await waitFor(() =>
      expect(map.fitBounds).toHaveBeenCalledWith(
        [
          [-75, 40],
          [-73, 42]
        ],
        { duration: 450, maxZoom: 10, padding: 48 },
        { atlasCamera: true }
      )
    );
    expect(map.flyTo).not.toHaveBeenCalled();

    act(() => map.fire("moveend", { atlasCamera: true }));
    rerenderMap({ sources: movedSources() });
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("previews a point from the current view and restores that view when the preview clears", async () => {
    const { map, rerenderMap } = renderMapView();
    map.flyTo.mockClear();
    map.easeTo.mockClear();

    rerenderMap({
      cameraCommand: {
        seq: 1,
        intent: "preview",
        target: { type: "point", id: "place-1", coordinates: [70, 80] }
      }
    });
    await waitFor(() =>
      expect(map.flyTo).toHaveBeenCalledWith(
        expect.objectContaining({
          center: [70, 80],
          zoom: PREVIEW_POINT_ZOOM,
          duration: expect.any(Number),
          easing: expect.any(Function)
        }),
        { atlasCamera: true }
      )
    );

    rerenderMap({ cameraCommand: null });

    expect(map.easeTo).toHaveBeenCalledWith(
      { center: [0, 0], zoom: 4, duration: PREVIEW_RESTORE_MS, easing: expect.any(Function) },
      { atlasCamera: true }
    );
  });

  it("uses the slower eased timing for area previews", async () => {
    const { map, rerenderMap } = renderMapView();
    map.fitBounds.mockClear();

    rerenderMap({
      cameraCommand: {
        seq: 1,
        intent: "preview",
        target: {
          type: "geometry",
          id: "place-area-1",
          geometry: {
            type: "LineString",
            coordinates: [
              [-75, 40],
              [-73, 42]
            ]
          }
        }
      }
    });

    await waitFor(() =>
      expect(map.fitBounds).toHaveBeenCalledWith(
        [
          [-75, 40],
          [-73, 42]
        ],
        expect.objectContaining({ duration: PREVIEW_DURATION_MS, easing: expect.any(Function) }),
        { atlasCamera: true }
      )
    );
  });

  it("keeps the previewed view when a place focus is committed", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();

    rerenderMap({
      cameraCommand: {
        seq: 1,
        intent: "preview",
        target: { type: "point", id: "place-1", coordinates: [70, 80] }
      }
    });
    await waitFor(() => expect(map.flyTo).toHaveBeenCalledTimes(1));
    rerenderMap({
      cameraCommand: {
        seq: 2,
        intent: "commit",
        target: { type: "point", id: "place-1", coordinates: [70, 80] }
      }
    });
    await waitFor(() => expect(map.flyTo).toHaveBeenCalledTimes(2));
    rerenderMap({ cameraCommand: null });

    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("stops a restoring preview as soon as place focus is committed", async () => {
    const { map, rerenderMap } = renderMapView();
    map.easeTo.mockClear();

    rerenderMap({
      cameraCommand: {
        seq: 1,
        intent: "preview",
        target: { type: "point", id: "place-1", coordinates: [70, 80] }
      }
    });
    await waitFor(() => expect(map.flyTo).toHaveBeenCalledTimes(1));
    rerenderMap({ cameraCommand: null });
    expect(map.easeTo).toHaveBeenCalledTimes(1);
    map.stop.mockClear();

    vi.useFakeTimers();
    try {
      rerenderMap({
        cameraCommand: {
          seq: 2,
          intent: "commit",
          target: { type: "point", id: "place-1", coordinates: [70, 80] }
        }
      });

      expect(map.stop).toHaveBeenCalledTimes(1);
      expect(map.flyTo).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flashes the reticle before applying a committed place move and cancels stale commits", async () => {
    const { map, rerenderMap } = renderMapView();
    rerenderMap({
      focusTarget: { type: "point", id: "place-1", coordinates: [70, 80] },
      cameraCommand: {
        seq: 1,
        intent: "preview",
        target: { type: "point", id: "place-1", coordinates: [70, 80] }
      }
    });
    await waitFor(() => expect(map.flyTo).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    try {
      rerenderMap({
        cameraCommand: {
          seq: 2,
          intent: "commit",
          target: { type: "point", id: "place-1", coordinates: [70, 80] }
        }
      });
      const reticle = document.querySelector<HTMLElement>(".map-reticle");
      expect(reticle).toHaveAttribute("data-flashing", "true");
      expect(reticle?.style.getPropertyValue("--map-reticle-line-color")).toBe("var(--text-1)");
      expect(map.flyTo).toHaveBeenCalledTimes(1);

      await act(async () => vi.advanceTimersByTimeAsync(RETICLE_FLASH_MS));
      expect(document.querySelector(".map-reticle")).not.toHaveAttribute("data-flashing");
      expect(map.flyTo).toHaveBeenCalledTimes(2);

      rerenderMap({
        cameraCommand: {
          seq: 3,
          intent: "commit",
          target: { type: "point", id: "place-1", coordinates: [70, 80] }
        }
      });
      expect(document.querySelector(".map-reticle")).toHaveAttribute("data-flashing", "true");
      rerenderMap({ cameraCommand: { seq: 4, intent: "world" } });
      expect(document.querySelector(".map-reticle")).not.toHaveAttribute("data-flashing");
      await act(async () => vi.advanceTimersByTimeAsync(RETICLE_FLASH_MS));
      expect(map.flyTo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the world view on explicit overview commands", async () => {
    const { map, rerenderMap } = renderMapView();
    map.fitBounds.mockClear();

    rerenderMap({ cameraCommand: { seq: 1, intent: "world" } });

    await waitFor(() =>
      expect(map.fitBounds).toHaveBeenCalledWith(
        INITIAL_WORLD_BOUNDS,
        { padding: 0, duration: 450 },
        { atlasCamera: true }
      )
    );
  });

  it("follows the selected entity with short tagged eases as telemetry moves it", async () => {
    const { map, rerenderMap } = await startFollowing();

    rerenderMap({ sources: movedSources() });

    await waitFor(() =>
      expect(map.easeTo).toHaveBeenCalledWith(
        { center: [-73, 41], duration: FOLLOW_EASE_MS, easing: expect.any(Function) },
        { atlasCamera: true }
      )
    );
  });

  it("stops following when the user moves the map", async () => {
    const { map, rerenderMap } = await startFollowing();

    act(() => map.fire("movestart", {}));
    rerenderMap({ sources: movedSources() });

    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("keeps following through its own tagged camera moves", async () => {
    const { map, rerenderMap } = await startFollowing();

    act(() => map.fire("movestart", { atlasCamera: true }));
    rerenderMap({ sources: movedSources() });

    await waitFor(() => expect(map.easeTo).toHaveBeenCalledTimes(1));
  });

  it("keeps following through tagged layout resize moves", async () => {
    const { map, rerenderMap } = await startFollowing();

    act(() => {
      notifyResizeObservers();
    });
    rerenderMap({ sources: movedSources() });

    expect(map.resize).toHaveBeenLastCalledWith({ atlasCamera: true });
    await waitFor(() =>
      expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-73, 41] }), { atlasCamera: true })
    );
  });

  it("re-engages follow when the command sequence bumps after a user gesture", async () => {
    const { map, rerenderMap } = await startFollowing();
    act(() => map.fire("movestart", {}));

    rerenderMap({ cameraCommand: { seq: 2, target: { type: "entity", id: "asset-1" } } });
    await waitFor(() => expect(map.flyTo).toHaveBeenCalledTimes(2));
    act(() => map.fire("moveend", { atlasCamera: true, atlasFlySeq: 2 }));
    rerenderMap({ sources: movedSources() });

    await waitFor(() =>
      expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-73, 41] }), { atlasCamera: true })
    );
  });

  it("does not chase mid-flight and catches up once the flight lands", async () => {
    const { map, rerenderMap } = renderMapView({ sources: markerSources() });
    rerenderMap({ cameraCommand: { seq: 1, target: { type: "entity", id: "asset-1" } } });
    await waitFor(() => expect(map.flyTo).toHaveBeenCalledTimes(1));
    map.easeTo.mockClear();

    rerenderMap({ sources: movedSources() });
    expect(map.easeTo).not.toHaveBeenCalled();

    act(() => map.fire("moveend", { atlasCamera: true, atlasFlySeq: 1 }));
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledTimes(1));
    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ center: [-73, 41] }), { atlasCamera: true });
  });

  it("stops following when a box zoom completes", async () => {
    const { map, rerenderMap } = await startFollowing();
    const boxZoom = map.options.boxZoom as {
      boxZoomEnd: (zoomMap: typeof map, start: PointLike, end: PointLike, event: MouseEvent) => void;
    };

    boxZoom.boxZoomEnd(map, { x: 12, y: 18 }, { x: 220, y: 140 }, new MouseEvent("mouseup"));
    rerenderMap({ sources: movedSources() });

    expect(map.fitScreenCoordinates).toHaveBeenCalledWith({ x: 12, y: 18 }, { x: 220, y: 140 }, 0, { linear: true });
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("releases follow when the command clears", async () => {
    const { map, rerenderMap } = await startFollowing();

    rerenderMap({ cameraCommand: null });
    rerenderMap({ sources: movedSources() });

    expect(map.easeTo).not.toHaveBeenCalled();
  });
});
