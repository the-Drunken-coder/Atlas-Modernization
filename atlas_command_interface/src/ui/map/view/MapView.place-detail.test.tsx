import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MapTarget } from "../interaction/map-camera.js";
import { renderMapView } from "./MapView.test-harness.js";

const worcester: MapTarget = {
  type: "point",
  id: "place:worcester",
  coordinates: [-71.8023, 42.2626],
  label: "Worcester, Massachusetts",
  reticleSize: 48
};

const massachusetts: MapTarget = {
  type: "geometry",
  id: "place:massachusetts",
  label: "Massachusetts",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-73.5, 41.2],
        [-69.9, 41.2],
        [-69.9, 42.9],
        [-73.5, 42.9],
        [-73.5, 41.2]
      ]
    ]
  }
};

const russia: MapTarget = {
  type: "geometry",
  id: "place:russia",
  label: "Russia",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [19.4041722, 41.1850968],
        [191.023056, 41.1850968],
        [191.023056, 82.0586232],
        [19.4041722, 82.0586232],
        [19.4041722, 41.1850968]
      ]
    ]
  }
};

describe("MapView place detail lens", () => {
  it("frames changing place targets without moving the main map", async () => {
    const rendered = renderMapView({ placeDetailTarget: worcester });
    rendered.map.fitBounds.mockClear();
    rendered.map.flyTo.mockClear();

    await screen.findByRole("region", { name: "Local detail for Worcester, Massachusetts" });
    await waitFor(() => expect(rendered.maps()).toHaveLength(2));
    const lens = screen.getByRole("region", { name: "Local detail for Worcester, Massachusetts" });
    const detailMap = rendered.maps().find((map) => map.options.interactive === false)!;
    await waitFor(() =>
      expect(detailMap.jumpTo).toHaveBeenCalledWith({ center: worcester.coordinates, zoom: 13 }, expect.any(Object))
    );
    const pointReticle = lens.querySelector<HTMLElement>(".map-reticle");
    expect(pointReticle?.style.getPropertyValue("--map-reticle-target-width")).toBe("62px");
    expect(pointReticle?.style.getPropertyValue("--map-reticle-target-height")).toBe("62px");
    expect(rendered.map.jumpTo).not.toHaveBeenCalled();
    expect(rendered.map.fitBounds).not.toHaveBeenCalled();
    expect(rendered.map.flyTo).not.toHaveBeenCalled();
    fireEvent.click(lens);
    expect(rendered.onBackgroundClick).not.toHaveBeenCalled();

    detailMap.project.mockImplementation(([longitude, latitude]) => ({
      x: (longitude + 74) * 50,
      y: (43 - latitude) * 50
    }));
    rendered.rerenderMap({ placeDetailTarget: massachusetts });

    await screen.findByRole("region", { name: "Local detail for Massachusetts" });
    expect(rendered.maps()).toHaveLength(2);
    expect(detailMap.fitBounds).toHaveBeenCalledWith(
      [
        [-73.5, 41.2],
        [-69.9, 42.9]
      ],
      expect.objectContaining({ duration: 0, maxZoom: 14, padding: 28 }),
      expect.any(Object)
    );
    const areaReticle = screen
      .getByRole("region", { name: "Local detail for Massachusetts" })
      .querySelector<HTMLElement>(".map-reticle");
    expect(Number.parseFloat(areaReticle?.style.getPropertyValue("--map-reticle-target-width") ?? "")).toBeCloseTo(194);
    expect(Number.parseFloat(areaReticle?.style.getPropertyValue("--map-reticle-target-height") ?? "")).toBeCloseTo(99);
    expect(rendered.map.fitBounds).not.toHaveBeenCalled();

    rendered.rerenderMap({ placeDetailTarget: russia });

    await screen.findByRole("region", { name: "Local detail for Russia" });
    expect(detailMap.setRenderWorldCopies).toHaveBeenLastCalledWith(true);
    expect(detailMap.fitBounds).toHaveBeenLastCalledWith(
      [
        [19.4041722, 41.1850968],
        [191.023056, 82.0586232]
      ],
      expect.objectContaining({ duration: 0, maxZoom: 14, padding: 28 }),
      expect.any(Object)
    );

    rendered.rerenderMap({ placeDetailTarget: null });

    expect(screen.queryByRole("region", { name: /Local detail for/ })).not.toBeInTheDocument();
    expect(detailMap.remove).toHaveBeenCalledOnce();
  });
});
