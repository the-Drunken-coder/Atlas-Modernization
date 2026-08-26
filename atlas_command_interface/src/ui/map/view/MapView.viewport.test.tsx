import { act, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderMapView } from "./MapView.test-harness.js";

it("reports the initial viewport and later camera changes", async () => {
  const onViewportChange = vi.fn();
  const { map } = renderMapView({ onViewportChange });

  await waitFor(() => expect(onViewportChange).toHaveBeenCalledWith({ bounds: [-20, -10, 20, 10], zoom: 4 }));

  act(() => {
    map.bounds = [170, -8, -170, 12];
    map.zoom = 8.5;
    map.fire("moveend");
  });

  expect(onViewportChange).toHaveBeenLastCalledWith({ bounds: [170, -8, -170, 12], zoom: 8.5 });
});
