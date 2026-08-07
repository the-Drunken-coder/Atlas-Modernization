import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UiGeometry } from "../../../atlas/geometry.js";
import { renderMapView } from "./MapView.test-harness.js";

describe("MapView geometry editing", () => {
  it("renders midpoint actions as keyboard-operable buttons", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    };

    renderMapView({ editing: { geometry, onChange } });

    const addVertex = await screen.findByRole("button", { name: "Add vertex" });
    addVertex.focus();
    await user.keyboard("{Enter}");

    const next = onChange.mock.lastCall?.[0] as Extract<UiGeometry, { type: "LineString" }>;
    expect(next.coordinates).toHaveLength(3);
    expect(next.coordinates[1][0]).toBeCloseTo(-74.15);
    expect(next.coordinates[1][1]).toBeCloseTo(40.15);
  });
});
