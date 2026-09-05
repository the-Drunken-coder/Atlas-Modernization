import { fireEvent, screen, waitFor } from "@testing-library/react";
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

  it("keeps handles when only the editing wrapper changes and uses the latest callback", async () => {
    const user = userEvent.setup();
    const firstOnChange = vi.fn();
    const latestOnChange = vi.fn();
    const geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    };

    const rendered = renderMapView({ editing: { geometry, onChange: firstOnChange } });
    await screen.findByRole("button", { name: "Add vertex" });
    const originalHandles = [...rendered.canvas.querySelectorAll(".vertex-handle")];

    rendered.rerenderMap({ editing: { geometry, onChange: latestOnChange } });

    const currentHandles = [...rendered.canvas.querySelectorAll(".vertex-handle")];
    expect(currentHandles).toHaveLength(originalHandles.length);
    currentHandles.forEach((handle, index) => expect(handle).toBe(originalHandles[index]));

    await user.click(screen.getByRole("button", { name: "Add vertex" }));
    expect(firstOnChange).not.toHaveBeenCalled();
    expect(latestOnChange).toHaveBeenCalledOnce();
  });

  it("reconciles handles when the geometry changes and when editing ends", async () => {
    const onChange = vi.fn();
    const geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    };
    const nextGeometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.15, 40.15],
        [-74.1, 40.2]
      ]
    };

    const rendered = renderMapView({ editing: { geometry, onChange } });
    await waitFor(() => expect(rendered.canvas.querySelectorAll(".vertex-handle")).toHaveLength(3));
    const originalHandles = [...rendered.canvas.querySelectorAll(".vertex-handle")];

    rendered.rerenderMap({ editing: { geometry: nextGeometry, onChange } });

    await waitFor(() => expect(rendered.canvas.querySelectorAll(".vertex-handle")).toHaveLength(5));
    const currentHandles = [...rendered.canvas.querySelectorAll(".vertex-handle")];
    expect(currentHandles[0]).not.toBe(originalHandles[0]);

    rendered.rerenderMap({ editing: undefined });

    await waitFor(() => expect(rendered.canvas.querySelectorAll(".vertex-handle")).toHaveLength(0));
  });

  it("keeps a focused vertex through repeated keyboard moves and geometry replacement", async () => {
    const user = userEvent.setup();
    let geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2],
        [-74.0, 40.3]
      ]
    };
    let rendered!: ReturnType<typeof renderMapView>;
    const onChange = vi.fn((next: UiGeometry) => {
      geometry = next;
      rendered.rerenderMap({ editing: { geometry, onChange } });
    });

    rendered = renderMapView({ editing: { geometry, onChange } });
    rendered.map.project.mockImplementation(([longitude, latitude]: [number, number]) => ({
      x: longitude * 100,
      y: latitude * 100
    }));
    rendered.map.unproject.mockImplementation((point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      return { lng: x / 100, lat: y / 100 };
    });

    const first = await screen.findByRole("button", { name: "Move vertex 1" });
    first.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");

    const replacement = rendered.canvas.querySelector<HTMLElement>('[data-vertex-key="line-0"]');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(geometry.type).toBe("LineString");
    if (geometry.type !== "LineString") throw new Error("Expected a line geometry");
    expect(geometry.coordinates).toHaveLength(3);
    expect(geometry.coordinates[0][0]).toBeCloseTo(-74.0, 10);
    expect(geometry.coordinates[0][1]).toBeCloseTo(40.1, 10);
    expect(replacement).toBeInTheDocument();
    expect(replacement).toHaveFocus();
    expect(replacement).not.toBe(first);
  });

  it("focuses the previous same-ring vertex after deleting the last vertex", async () => {
    const user = userEvent.setup();
    let geometry: UiGeometry = {
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2],
        [-74.0, 40.3]
      ]
    };
    let rendered!: ReturnType<typeof renderMapView>;
    const onChange = vi.fn((next: UiGeometry) => {
      geometry = next;
      rendered.rerenderMap({ editing: { geometry, onChange } });
    });

    rendered = renderMapView({ editing: { geometry, onChange } });
    const last = await screen.findByRole("button", { name: "Move vertex 3" });
    last.focus();
    await user.keyboard("{Delete}");

    expect(geometry).toEqual({
      type: "LineString",
      coordinates: [
        [-74.2, 40.1],
        [-74.1, 40.2]
      ]
    });
    const previous = rendered.canvas.querySelector<HTMLElement>('[data-vertex-key="line-1"]');
    expect(previous).toBeInTheDocument();
    expect(previous).toHaveFocus();
    expect(previous).not.toBe(last);
  });

  it("does not treat a removed vertex as keyboard focus when removal is refused", async () => {
    const onChange = vi.fn();
    renderMapView({
      editing: {
        geometry: {
          type: "LineString",
          coordinates: [
            [-74.2, 40.1],
            [-74.1, 40.2]
          ]
        },
        onChange
      }
    });

    const first = await screen.findByRole("button", { name: "Move vertex 1" });
    first.focus();
    fireEvent.keyDown(first, { key: "Delete" });
    expect(onChange).not.toHaveBeenCalled();
    expect(first).toHaveFocus();
  });
});
