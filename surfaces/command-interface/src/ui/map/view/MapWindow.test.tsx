import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MapWindow } from "./MapWindow.js";
import { MapWindowWorkspace } from "./MapWindowWorkspace.js";

const moveLabel = (title: string) =>
  `Move ${title} window. Use arrow keys to move; use the inward arrow to detach; use Alt plus an arrow to attach to an edge.`;

describe("MapWindow", () => {
  it("parks a floating window as a pull handle with reachable attribution and close actions", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <MapWindowWorkspace>
        <MapWindow
          id="fixture"
          title="Fixture results"
          meta="3 results"
          handleBadge={3}
          footer={<a href="https://example.test">Source</a>}
          onClose={onClose}
        >
          <span>Window body</span>
        </MapWindow>
      </MapWindowWorkspace>
    );
    const workspace = view.container.firstElementChild as HTMLElement;
    const windowElement = screen.getByRole("complementary", { name: "Fixture results" });
    workspace.getBoundingClientRect = () => rect(0, 0, 500, 400);
    windowElement.getBoundingClientRect = () => rect(300, 120, 180, 200);

    await user.click(screen.getByRole("button", { name: "Collapse Fixture results window" }));
    expect(windowElement).toHaveAttribute("data-placement", "docked");
    expect(windowElement).toHaveAttribute("data-edge", "right");
    expect(windowElement).toHaveAttribute("data-collapsed", "true");
    expect(windowElement).toHaveClass("map-window--handle");
    expect(screen.queryByText("Window body")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Source" })).toBeInTheDocument();
    expect(windowElement.querySelector(".map-window__pull-badge")).toHaveTextContent("3");

    const handle = screen.getByRole("button", { name: /^Expand Fixture results window, 3 results/ });
    await waitFor(() => expect(handle).toHaveFocus());
    await user.click(handle);
    expect(screen.getByText("Window body")).toBeVisible();
    expect(screen.getByRole("link", { name: "Source" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Collapse Fixture results window" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Collapse Fixture results window" }));
    await user.click(screen.getByRole("button", { name: "Close Fixture results window" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves with arrow keys and clamps the floating window to its map", () => {
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
      const windowElement = screen.getByRole("complementary", { name: "Fixture results" });
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

      const move = screen.getByRole("button", { name: moveLabel("Fixture results") });
      expect(windowElement).not.toHaveAttribute("data-positioned");
      fireEvent.keyDown(move, { key: "ArrowRight" });
      expect(windowElement).toHaveStyle({ left: "108px", top: "50px" });
      expect(windowElement).toHaveAttribute("data-positioned", "true");

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

  it("keeps independently attached windows visible on the same edge", async () => {
    const user = userEvent.setup();
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

    const firstMove = screen.getByRole("button", { name: moveLabel("First") });
    const secondMove = screen.getByRole("button", { name: moveLabel("Second") });
    const firstWindow = screen.getByRole("complementary", { name: "First" });
    const secondWindow = screen.getByRole("complementary", { name: "Second" });

    expect(Number(firstWindow.style.zIndex)).toBeLessThan(Number(secondWindow.style.zIndex));
    fireEvent.focus(firstMove, { relatedTarget: document.body });
    expect(Number(firstWindow.style.zIndex)).toBeGreaterThan(Number(secondWindow.style.zIndex));

    fireEvent.keyDown(firstMove, { key: "ArrowLeft", altKey: true });
    expect(firstWindow).toHaveAttribute("data-edge", "left");
    fireEvent.keyDown(firstMove, { key: "ArrowRight", altKey: true });
    expect(screen.getByRole("complementary", { name: "First" })).toHaveAttribute("data-edge", "right");
    fireEvent.keyDown(firstMove, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(secondMove, { key: "ArrowUp", altKey: true });

    expect(screen.getByRole("complementary", { name: "First" })).toHaveAttribute("data-edge", "top");
    expect(screen.getByRole("complementary", { name: "Second" })).toHaveAttribute("data-edge", "top");
    expect(screen.getByText("First body")).toBeVisible();
    expect(screen.getByText("Second body")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Collapse First window" }));
    expect(screen.getByRole("complementary", { name: "First" })).toHaveAttribute("data-placement", "docked");
    expect(screen.queryByText("First body")).not.toBeInTheDocument();
    expect(screen.getByText("Second body")).toBeVisible();
  });

  it("slides a collapsed handle without reopening and expands when pulled away from its edge", () => {
    const view = render(
      <MapWindowWorkspace>
        <MapWindow id="fixture" title="Fixture" handleBadge={12} onClose={() => undefined}>
          Window body
        </MapWindow>
      </MapWindowWorkspace>
    );
    const workspace = view.container.firstElementChild as HTMLElement;
    const windowElement = screen.getByRole("complementary", { name: "Fixture" });
    Object.defineProperties(workspace, {
      clientWidth: { value: 800, configurable: true },
      clientHeight: { value: 600, configurable: true }
    });
    Object.defineProperties(windowElement, {
      offsetWidth: { value: 200, configurable: true },
      offsetHeight: { value: 150, configurable: true }
    });
    workspace.getBoundingClientRect = () => rect(0, 0, 800, 600);
    windowElement.getBoundingClientRect = () => rect(600, 150, 200, 150);

    fireEvent.keyDown(screen.getByRole("button", { name: moveLabel("Fixture") }), {
      key: "ArrowRight",
      altKey: true
    });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Fixture window" }));
    Object.defineProperties(windowElement, {
      offsetWidth: { value: 38 },
      offsetHeight: { value: 48 }
    });
    windowElement.getBoundingClientRect = () => rect(762, 201, 38, 48);

    let handle = screen.getByRole("button", { name: /^Expand Fixture window/ });
    fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    expect(windowElement).toHaveAttribute("data-edge", "bottom");
    expect(windowElement).toHaveAttribute("data-collapsed", "true");
    fireEvent.keyDown(handle, { key: "ArrowRight", altKey: true });
    expect(windowElement).toHaveAttribute("data-edge", "right");
    expect(windowElement).toHaveAttribute("data-collapsed", "true");
    handle = screen.getByRole("button", { name: /^Expand Fixture window/ });
    fireEvent.pointerDown(handle, { pointerId: 21, isPrimary: true, button: 0, clientX: 780, clientY: 225 });
    fireEvent.pointerMove(handle, { pointerId: 21, clientX: 784, clientY: 345 });
    fireEvent.pointerUp(handle, { pointerId: 21, clientX: 784, clientY: 345 });

    expect(windowElement).toHaveAttribute("data-collapsed", "true");
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.575);
    fireEvent.click(handle);
    expect(windowElement).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(handle);
    expect(windowElement).not.toHaveAttribute("data-collapsed");

    fireEvent.click(screen.getByRole("button", { name: "Collapse Fixture window" }));
    let pulledHandle = screen.getByRole("button", { name: /^Expand Fixture window/ });
    fireEvent.pointerDown(pulledHandle, { pointerId: 22, isPrimary: true, button: 0, clientX: 780, clientY: 345 });
    fireEvent.pointerMove(pulledHandle, { pointerId: 22, clientX: 784, clientY: 390 });
    fireEvent.pointerCancel(pulledHandle, { pointerId: 22, clientX: 784, clientY: 390 });
    fireEvent.click(pulledHandle);
    expect(windowElement).not.toHaveAttribute("data-collapsed");

    fireEvent.click(screen.getByRole("button", { name: "Collapse Fixture window" }));
    pulledHandle = screen.getByRole("button", { name: /^Expand Fixture window/ });
    windowElement.getBoundingClientRect = () => rect(762, 321, 38, 48);
    fireEvent.pointerDown(pulledHandle, { pointerId: 23, isPrimary: true, button: 0, clientX: 780, clientY: 345 });
    fireEvent.pointerMove(pulledHandle, { pointerId: 23, clientX: 715, clientY: 350 });
    fireEvent.pointerUp(pulledHandle, { pointerId: 23, clientX: 715, clientY: 350 });

    expect(windowElement).toHaveAttribute("data-placement", "floating");
    expect(windowElement).not.toHaveAttribute("data-collapsed");
    expect(screen.getByText("Window body")).toBeVisible();
  });

  it("owns only one pointer stream and removes its global drag listeners", () => {
    render(
      <MapWindowWorkspace>
        <MapWindow id="fixture" title="Fixture" onClose={() => undefined}>
          Window body
        </MapWindow>
      </MapWindowWorkspace>
    );
    const windowElement = screen.getByRole("complementary", { name: "Fixture" });
    const bar = windowElement.querySelector<HTMLElement>(".map-window__bar");
    if (!bar) throw new Error("Expected a map window bar.");
    windowElement.getBoundingClientRect = () => rect(100, 50, 200, 150);
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");

    fireEvent.pointerDown(bar, { pointerId: 30, isPrimary: true, button: 0, clientX: 120, clientY: 70 });
    const pointerMoveAdds = () => addListener.mock.calls.filter(([type]) => type === "pointermove").length;
    expect(pointerMoveAdds()).toBe(1);

    fireEvent.pointerDown(bar, { pointerId: 31, isPrimary: true, button: 0, clientX: 130, clientY: 80 });
    expect(pointerMoveAdds()).toBe(1);
    fireEvent.pointerUp(window, { pointerId: 30, isPrimary: true, button: 0, clientX: 120, clientY: 70 });
    expect(removeListener.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1);

    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it("previews and stores the continuous edge position used for pointer docking", () => {
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

    fireEvent.pointerDown(bar, { pointerId: 7, isPrimary: true, button: 0, clientX: 500, clientY: 220 });
    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 600, clientY: 20 });
    const preview = view.container.querySelector<HTMLElement>('.map-window-dock-zone[data-edge="top"]');
    expect(preview).toBeInTheDocument();
    expect(preview?.style.getPropertyValue("--map-window-dock-offset")).toBe("75%");

    fireEvent.pointerUp(bar, { pointerId: 7, clientX: 600, clientY: 20 });
    expect(windowElement).toHaveAttribute("data-placement", "docked");
    expect(windowElement).toHaveAttribute("data-edge", "top");
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.75);
  });

  it("slides along an attached edge and detaches only after moving away from it", () => {
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
      offsetWidth: { value: 200, configurable: true },
      offsetHeight: { value: 150, configurable: true }
    });
    workspace.getBoundingClientRect = () => rect(0, 0, 800, 600);
    windowElement.getBoundingClientRect = () => rect(600, 150, 200, 150);

    const move = screen.getByRole("button", { name: moveLabel("Fixture") });
    fireEvent.keyDown(move, { key: "ArrowRight", altKey: true });
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.375);

    fireEvent.pointerDown(bar, { pointerId: 11, isPrimary: true, button: 0, clientX: 700, clientY: 170 });
    fireEvent.pointerMove(bar, { pointerId: 11, clientX: 705, clientY: 290 });
    fireEvent.pointerUp(bar, { pointerId: 11, clientX: 705, clientY: 290 });

    expect(windowElement).toHaveAttribute("data-placement", "docked");
    expect(windowElement).toHaveAttribute("data-edge", "right");
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.575);

    fireEvent.pointerDown(bar, { pointerId: 12, isPrimary: true, button: 0, clientX: 705, clientY: 290 });
    fireEvent.pointerMove(bar, { pointerId: 12, clientX: 770, clientY: 300 });
    fireEvent.pointerUp(bar, { pointerId: 12, clientX: 770, clientY: 300 });
    expect(windowElement).toHaveAttribute("data-placement", "docked");

    fireEvent.pointerDown(bar, { pointerId: 13, isPrimary: true, button: 0, clientX: 705, clientY: 290 });
    fireEvent.pointerMove(bar, { pointerId: 13, clientX: 640, clientY: 300 });
    fireEvent.pointerUp(bar, { pointerId: 13, clientX: 640, clientY: 300 });
    expect(windowElement).toHaveAttribute("data-placement", "floating");
    expect(windowElement).not.toHaveAttribute("data-edge");
  });

  it("moves an attached window continuously with the keyboard", () => {
    const view = render(
      <MapWindowWorkspace>
        <MapWindow id="fixture" title="Fixture" onClose={() => undefined}>
          Window body
        </MapWindow>
      </MapWindowWorkspace>
    );
    const workspace = view.container.firstElementChild as HTMLElement;
    const windowElement = screen.getByRole("complementary", { name: "Fixture" });
    Object.defineProperties(workspace, {
      clientWidth: { value: 800, configurable: true },
      clientHeight: { value: 600, configurable: true }
    });
    Object.defineProperties(windowElement, {
      offsetWidth: { value: 200, configurable: true },
      offsetHeight: { value: 150, configurable: true }
    });
    workspace.getBoundingClientRect = () => rect(0, 0, 800, 600);
    windowElement.getBoundingClientRect = () => rect(100, 50, 200, 150);
    const move = screen.getByRole("button", { name: moveLabel("Fixture") });

    fireEvent.keyDown(move, { key: "ArrowUp", altKey: true });
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.25);
    fireEvent.keyDown(move, { key: "ArrowRight" });
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.26);
    fireEvent.keyDown(move, { key: "ArrowRight", shiftKey: true });
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.29);
    fireEvent.keyDown(move, { key: "Home" });
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.125);
    fireEvent.keyDown(move, { key: "End" });
    expect(Number(windowElement.getAttribute("data-dock-offset"))).toBeCloseTo(0.875);
  });

  it("detaches expanded and collapsed windows with the inward keyboard arrow on every edge", async () => {
    const cases = [
      { edge: "top", attach: "ArrowUp", inward: "ArrowDown" },
      { edge: "right", attach: "ArrowRight", inward: "ArrowLeft" },
      { edge: "bottom", attach: "ArrowDown", inward: "ArrowUp" },
      { edge: "left", attach: "ArrowLeft", inward: "ArrowRight" }
    ] as const;

    for (const testCase of cases) {
      const view = render(
        <MapWindowWorkspace>
          <MapWindow id="fixture" title="Fixture" onClose={() => undefined}>
            Window body
          </MapWindow>
        </MapWindowWorkspace>
      );
      const workspace = view.container.firstElementChild as HTMLElement;
      const windowElement = screen.getByRole("complementary", { name: "Fixture" });
      Object.defineProperties(workspace, {
        clientWidth: { value: 800, configurable: true },
        clientHeight: { value: 600, configurable: true }
      });
      Object.defineProperties(windowElement, {
        offsetWidth: { value: 200, configurable: true },
        offsetHeight: { value: 150, configurable: true }
      });
      workspace.getBoundingClientRect = () => rect(0, 0, 800, 600);
      windowElement.getBoundingClientRect = () => rect(100, 50, 200, 150);

      let move = screen.getByRole("button", { name: moveLabel("Fixture") });
      fireEvent.keyDown(move, { key: testCase.attach, altKey: true });
      expect(windowElement).toHaveAttribute("data-edge", testCase.edge);
      fireEvent.keyDown(move, { key: testCase.inward });
      expect(windowElement).toHaveAttribute("data-placement", "floating");
      expect(windowElement).toHaveAttribute("data-positioned", "true");

      move = screen.getByRole("button", { name: moveLabel("Fixture") });
      fireEvent.keyDown(move, { key: testCase.attach, altKey: true });
      fireEvent.click(screen.getByRole("button", { name: "Collapse Fixture window" }));
      const handle = screen.getByRole("button", { name: /^Expand Fixture window/ });
      await waitFor(() => expect(handle).toHaveFocus());
      fireEvent.keyDown(handle, { key: testCase.inward });
      expect(windowElement).toHaveAttribute("data-placement", "floating");
      expect(windowElement).not.toHaveAttribute("data-collapsed");
      await waitFor(() => expect(screen.getByRole("button", { name: moveLabel("Fixture") })).toHaveFocus());

      view.unmount();
    }
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
