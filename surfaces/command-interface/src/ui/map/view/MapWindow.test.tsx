import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MapWindow } from "./MapWindow.js";
import { MapWindowWorkspace } from "./MapWindowWorkspace.js";

describe("MapWindow", () => {
  it("collapses without hiding its attribution footer and closes explicitly", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <MapWindowWorkspace>
        <MapWindow
          id="fixture"
          title="Fixture results"
          meta="3 results"
          footer={<a href="https://example.test">Source</a>}
          onClose={onClose}
        >
          <span>Window body</span>
        </MapWindow>
      </MapWindowWorkspace>
    );

    await user.click(screen.getByRole("button", { name: "Collapse Fixture results window" }));
    expect(screen.getByText("Window body")).not.toBeVisible();
    expect(screen.getByRole("link", { name: "Source" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Expand Fixture results window" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );

    await user.click(screen.getByRole("button", { name: "Close Fixture results window" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves with arrow keys and clamps the window to its map", () => {
    let notifyResize: (() => void) | undefined;
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      }
    });
    try {
      const view = render(
        <MapWindowWorkspace>
          <MapWindow id="fixture" title="Fixture results" onClose={() => undefined}>
            Window body
          </MapWindow>
        </MapWindowWorkspace>
      );
      const map = view.container.firstElementChild as HTMLElement;
      const windowElement = screen.getByRole("complementary", {
        name: "Fixture results"
      });
      Object.defineProperties(map, {
        clientWidth: { value: 500, configurable: true },
        clientHeight: { value: 400, configurable: true }
      });
      Object.defineProperties(windowElement, {
        offsetWidth: { value: 200, configurable: true },
        offsetHeight: { value: 150, configurable: true }
      });
      map.getBoundingClientRect = () => rect(0, 0, 500, 400);
      windowElement.getBoundingClientRect = () => rect(100, 50, 200, 150);

      const move = screen.getByRole("button", {
        name: "Move Fixture results window. Use arrow keys; use Alt plus an arrow to dock."
      });
      fireEvent.keyDown(move, { key: "ArrowRight" });
      expect(windowElement).toHaveStyle({ left: "108px", top: "50px" });

      windowElement.getBoundingClientRect = () => rect(295, 245, 200, 150);
      fireEvent.keyDown(move, { key: "ArrowRight", shiftKey: true });
      windowElement.getBoundingClientRect = () => rect(300, 245, 200, 150);
      fireEvent.keyDown(move, { key: "ArrowDown", shiftKey: true });
      expect(windowElement).toHaveStyle({ left: "300px", top: "250px" });

      Object.defineProperties(map, {
        clientWidth: { value: 250 },
        clientHeight: { value: 180 }
      });
      act(() => notifyResize?.());
      expect(windowElement).toHaveStyle({ left: "50px", top: "30px" });
    } finally {
      if (resizeObserverDescriptor) Object.defineProperty(globalThis, "ResizeObserver", resizeObserverDescriptor);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  it("docks to all four rails and keeps one popout open per edge", () => {
    render(
      <MapWindowWorkspace>
        <MapWindow id="first" title="First" onClose={() => undefined}>
          First body
        </MapWindow>
        <MapWindow id="second" title="Second" onClose={() => undefined}>
          Second body
        </MapWindow>
      </MapWindowWorkspace>
    );

    const firstMove = screen.getByRole("button", {
      name: "Move First window. Use arrow keys; use Alt plus an arrow to dock."
    });
    const secondMove = screen.getByRole("button", {
      name: "Move Second window. Use arrow keys; use Alt plus an arrow to dock."
    });

    fireEvent.keyDown(firstMove, { key: "ArrowLeft", altKey: true });
    expect(screen.getByRole("complementary", { name: "First" })).toHaveAttribute("data-edge", "left");
    fireEvent.keyDown(firstMove, { key: "ArrowRight", altKey: true });
    expect(screen.getByRole("complementary", { name: "First" })).toHaveAttribute("data-edge", "right");
    fireEvent.keyDown(firstMove, { key: "ArrowUp", altKey: true });
    expect(screen.getByRole("button", { name: "First" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "First" })).toHaveAttribute("data-edge", "top");

    fireEvent.keyDown(secondMove, { key: "ArrowDown", altKey: true });
    expect(screen.getByRole("button", { name: "Second" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Second" })).toHaveAttribute("data-edge", "bottom");
    expect(screen.getByRole("complementary", { name: "First" })).toBeVisible();

    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "Move Second window. Use arrow keys; use Alt plus an arrow to dock."
      }),
      { key: "ArrowUp", altKey: true }
    );
    expect(screen.getByRole("button", { name: "First" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Second" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("complementary", { name: "First" })).not.toBeInTheDocument();
  });

  it("shows the insertion rail while a window is dragged to an edge", () => {
    const view = render(
      <MapWindowWorkspace>
        <MapWindow id="fixture" title="Fixture" onClose={() => undefined}>
          Window body
        </MapWindow>
      </MapWindowWorkspace>
    );
    const workspace = view.container.firstElementChild as HTMLElement;
    const windowElement = screen.getByRole("complementary", { name: "Fixture" });
    const bar = windowElement.querySelector<HTMLElement>(".map-window__bar");
    if (!bar) throw new Error("Expected a map window bar.");
    Object.defineProperties(workspace, {
      clientWidth: { value: 800, configurable: true },
      clientHeight: { value: 600, configurable: true }
    });
    Object.defineProperties(windowElement, {
      offsetWidth: { value: 400, configurable: true },
      offsetHeight: { value: 240, configurable: true }
    });
    workspace.getBoundingClientRect = () => rect(0, 0, 800, 600);
    windowElement.getBoundingClientRect = () => rect(350, 200, 400, 240);

    fireEvent.pointerDown(bar, { pointerId: 7, clientX: 500, clientY: 220 });
    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 500, clientY: 20 });
    expect(view.container.querySelector('.map-window-dock-zone[data-edge="top"]')).toBeInTheDocument();
    expect(view.container.querySelector(".map-window-rail--top .map-window-rail__slot")).toBeInTheDocument();

    fireEvent.pointerUp(bar, { pointerId: 7, clientX: 500, clientY: 20 });
    expect(screen.getByRole("button", { name: "Fixture" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Fixture" })).toHaveAttribute("data-edge", "top");
  });

  it("moves a dock tab between ordered edge rails", () => {
    const view = render(
      <MapWindowWorkspace>
        <MapWindow id="fixture" title="Fixture" onClose={() => undefined}>
          Window body
        </MapWindow>
      </MapWindowWorkspace>
    );
    const workspace = view.container.firstElementChild as HTMLElement;
    workspace.getBoundingClientRect = () => rect(0, 0, 800, 600);
    Object.defineProperties(workspace, {
      clientWidth: { value: 800, configurable: true },
      clientHeight: { value: 600, configurable: true }
    });
    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "Move Fixture window. Use arrow keys; use Alt plus an arrow to dock."
      }),
      { key: "ArrowDown", altKey: true }
    );
    const tab = screen.getByRole("button", { name: "Fixture" });

    fireEvent.pointerDown(tab, { pointerId: 11, clientX: 400, clientY: 590 });
    fireEvent.pointerMove(tab, { pointerId: 11, clientX: 300, clientY: 20 });
    expect(view.container.querySelector('.map-window-dock-zone[data-edge="top"]')).toBeInTheDocument();
    fireEvent.pointerUp(tab, { pointerId: 11, clientX: 300, clientY: 20 });

    expect(screen.getByRole("button", { name: "Fixture" }).closest(".map-window-rail")).toHaveAttribute(
      "data-edge",
      "top"
    );
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  };
}
