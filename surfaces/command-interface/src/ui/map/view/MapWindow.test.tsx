import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MapWindow } from "./MapWindow.js";

describe("MapWindow", () => {
  it("collapses without hiding its attribution footer and closes explicitly", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <div>
        <MapWindow
          title="Fixture results"
          meta="3 results"
          footer={<a href="https://example.test">Source</a>}
          onClose={onClose}
        >
          <span>Window body</span>
        </MapWindow>
      </div>
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
    const view = render(
      <div>
        <MapWindow title="Fixture results" onClose={() => undefined}>
          Window body
        </MapWindow>
      </div>
    );
    const map = view.container.firstElementChild as HTMLElement;
    const windowElement = screen.getByRole("complementary", { name: "Fixture results" });
    Object.defineProperties(map, { clientWidth: { value: 500 }, clientHeight: { value: 400 } });
    Object.defineProperties(windowElement, { offsetWidth: { value: 200 }, offsetHeight: { value: 150 } });
    map.getBoundingClientRect = () => rect(0, 0, 500, 400);
    windowElement.getBoundingClientRect = () => rect(100, 50, 200, 150);

    const move = screen.getByRole("button", { name: "Move Fixture results window. Use arrow keys." });
    fireEvent.keyDown(move, { key: "ArrowRight" });
    expect(windowElement).toHaveStyle({ left: "108px", top: "50px" });

    windowElement.getBoundingClientRect = () => rect(295, 245, 200, 150);
    fireEvent.keyDown(move, { key: "ArrowRight", shiftKey: true });
    windowElement.getBoundingClientRect = () => rect(300, 245, 200, 150);
    fireEvent.keyDown(move, { key: "ArrowDown", shiftKey: true });
    expect(windowElement).toHaveStyle({ left: "300px", top: "250px" });
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
