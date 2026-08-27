import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MapTarget } from "../interaction/map-camera.js";
import { renderMapView } from "./MapView.test-harness.js";

const worcester: MapTarget = {
  type: "point",
  id: "place:worcester",
  coordinates: [-71.8023, 42.2626],
  label: "Worcester, Massachusetts"
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
    expect(rendered.map.jumpTo).not.toHaveBeenCalled();
    expect(rendered.map.fitBounds).not.toHaveBeenCalled();
    expect(rendered.map.flyTo).not.toHaveBeenCalled();
    fireEvent.click(lens);
    expect(rendered.onBackgroundClick).not.toHaveBeenCalled();

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
    expect(rendered.map.fitBounds).not.toHaveBeenCalled();

    rendered.rerenderMap({ placeDetailTarget: null });

    expect(screen.queryByRole("region", { name: /Local detail for/ })).not.toBeInTheDocument();
    expect(detailMap.remove).toHaveBeenCalledOnce();
  });
});
